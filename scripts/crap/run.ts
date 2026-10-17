import { spawn } from "node:child_process";
import { mkdtemp, cp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { createInstrumenter } from "istanbul-lib-instrument";
import { analyzeFile } from "./analyze.js";
import type { BaselineEntry } from "./baseline.js";
import { assertUniqueBaseline } from "./baseline.js";
import { round, type FunctionMetric } from "./model.js";
import { evaluate, type QualityResult } from "./policy.js";

const root = resolve(import.meta.dir, "../..");

function parseJson<T>(text: string, phase: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`${phase} validation phase failed: malformed JSON (${text.length} bytes)`);
  }
}

async function files(dir: string): Promise<string[]> {
  const entries = await (await import("node:fs/promises")).readdir(dir, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map(async (entry) => {
        const path = join(dir, entry.name);
        return entry.isDirectory() ? files(path) : entry.name.endsWith(".ts") ? [path] : [];
      }),
    )
  ).flat();
}

function mergeCoverage(target: Record<string, any>, snapshot: Record<string, any>): void {
  for (const [file, value] of Object.entries(snapshot)) {
    if (!value || typeof value !== "object")
      throw new Error(`coverage validation phase failed: invalid entry for ${file}`);
    const existing = target[file];
    if (!existing) {
      target[file] = value;
      continue;
    }
    for (const key of ["statementMap", "fnMap", "branchMap"])
      if (JSON.stringify(existing[key] ?? {}) !== JSON.stringify(value[key] ?? {}))
        throw new Error(`coverage validation phase failed: inconsistent maps for ${file}`);
    for (const key of ["s", "f", "b"])
      for (const [id, count] of Object.entries(value[key] ?? {}))
        existing[key][id] = Math.max(existing[key][id] ?? 0, count as number);
  }
}

function runBun(
  cwd: string,
  args: string[],
  quiet: boolean,
): Promise<{ code: number; output: string }> {
  return new Promise((resolveExit, reject) => {
    const child = spawn(process.execPath, ["test", ...args], {
      cwd,
      stdio: quiet ? ["ignore", "pipe", "pipe"] : "inherit",
      env: { ...process.env, CRAP_REPO_ROOT: root, VARLOCK_LIVE_BINARY: "" },
    });
    let output = "";
    if (quiet) {
      child.stdout?.on("data", (chunk) => {
        output += String(chunk);
      });
      child.stderr?.on("data", (chunk) => {
        output += String(chunk);
      });
    }
    child.on("error", reject);
    child.on("exit", (code) => resolveExit({ code: code ?? 1, output }));
  });
}

async function main(): Promise<void> {
  const temp = await mkdtemp(join(tmpdir(), "key-ferry-crap-"));
  try {
    await cp(join(root, "src"), join(temp, "src"), { recursive: true });
    await cp(join(root, "tests"), join(temp, "tests"), { recursive: true });
    await cp(join(root, "scripts"), join(temp, "scripts"), { recursive: true });
    // The isolated mirror must contain the declared baseline dataset as well
    // as code. Do not fall back to the caller's working tree or an empty
    // baseline: the mirror is deliberately independent of repository layout.
    await cp(join(root, "quality"), join(temp, "quality"), { recursive: true });
    // Bun resolves the repository's existing runtime dependencies through this isolated mirror.
    await cp(join(root, "node_modules"), join(temp, "node_modules"), { recursive: true });
    const instrumenter = createInstrumenter({
      esModules: true,
      parserPlugins: ["typescript"],
      produceSourceMap: true,
    });
    for (const file of await files(join(temp, "src"))) {
      const original = await readFile(file, "utf8");
      await writeFile(file, instrumenter.instrumentSync(original, relative(temp, file)));
    }
    // `exit` does not await promises. Bun.write here used to race process teardown
    // and leave a truncated JSON file. Use synchronous I/O only for this tiny,
    // local coverage snapshot, after all test work has settled.
    const collector =
      'import { existsSync, writeFileSync } from "node:fs"\nconst path = `.crap-${process.pid}.json`\nprocess.on("exit", () => { if (!existsSync(path)) writeFileSync(path, JSON.stringify((globalThis as any).__coverage__ ?? null)) })\n';
    for (const file of await files(join(temp, "src")))
      await writeFile(file, `${await readFile(file, "utf8")}\n${collector}`);
    const testArgs = process.argv.slice(2).filter((arg) => arg !== "--json");
    const testRun = await runBun(
      temp,
      [...(testArgs.length ? testArgs : ["tests"])],
      process.env.CRAP_JSON === "1" || process.argv.includes("--json"),
    );
    if (testRun.code !== 0)
      throw new Error(`instrumented Bun tests failed with exit code ${testRun.code}`);
    const coverage: Record<string, any> = {};
    const snapshots = (await readdir(temp)).filter((file) => /^\.crap-\d+\.json$/.test(file));
    if (!snapshots.length)
      throw new Error("coverage collection phase failed: no per-process snapshots were written");
    for (const snapshot of snapshots) {
      const text = await readFile(join(temp, snapshot), "utf8");
      if (!text.trim()) throw new Error(`coverage validation phase failed: ${snapshot} was empty`);
      const parsed = parseJson<Record<string, any>>(text, "coverage snapshot");
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        throw new Error(`coverage validation phase failed: ${snapshot} root was not an object`);
      mergeCoverage(coverage, parsed);
    }
    if (!coverage || typeof coverage !== "object" || Array.isArray(coverage))
      throw new Error("coverage validation phase failed: snapshot root was not an object");
    const metrics: FunctionMetric[] = [];
    for (const file of await files(join(temp, "src"))) {
      const originalPath = join(root, relative(join(temp, "src"), file).replace(/^/, "src/"));
      const key = relative(temp, file);
      // Istanbul omits modules that no test imported. They are still analyzed as
      // complete source with zero statement hits; a missing global coverage map is
      // handled as an error below rather than silently becoming zero coverage.
      const entry = coverage[key] ?? coverage[file] ?? { statementMap: {}, s: {} };
      if (!entry || typeof entry !== "object") throw new Error(`malformed coverage for ${key}`);
      metrics.push(...analyzeFile(key, await readFile(originalPath, "utf8"), entry, root));
    }
    const baselinePath = join(root, "quality/crap-baseline.json");
    const baselineText = await readFile(baselinePath, "utf8");
    if (!baselineText.trim()) throw new Error("baseline validation phase failed: file is empty");
    const baseline = parseJson<{ entries: BaselineEntry[] }>(baselineText, "baseline");
    assertUniqueBaseline(baseline.entries);
    const results: QualityResult[] = metrics.map((metric) => {
      const matching = baseline.entries.find(
        (entry) =>
          entry.file === metric.file &&
          entry.identity === metric.identity &&
          entry.fingerprint === metric.fingerprint,
      );
      return evaluate(metric, matching, !matching);
    });
    const failures = results.filter((result) => result.status === "fail");
    const report = {
      generatedAt: new Date().toISOString(),
      coverageUnit: "statements",
      metrics: results,
      warningCount: results.filter((result) => result.status === "warn").length,
      failureCount: failures.length,
    };
    if (failures.length) process.exitCode = 1;
    if (process.env.CRAP_JSON === "1" || process.argv.includes("--json")) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    for (const metric of [...results].sort((a, b) => b.crap - a.crap).slice(0, 20)) {
      console.log(
        `${metric.file}:${metric.line ?? "?"} ${metric.name} CC=${metric.complexity} coverage=${round(metric.coverage)} CRAP=${round(metric.crap)} ${metric.status}`,
      );
    }
    console.log(
      `CRAP gate: ${results.length} functions, ${report.warningCount} legacy warnings, ${report.failureCount} failures`,
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

if (import.meta.main) await main();
