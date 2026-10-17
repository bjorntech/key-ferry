import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { analyzeFile } from "./analyze.js";
import type { BaselineEntry } from "./baseline.js";
import { assertUniqueBaseline } from "./baseline.js";

const expectedCommit = "66f5cf9";
export type BaselineDocument = {
  commit: string;
  entries: BaselineEntry[];
};

export function verifyMetricEntries(
  baseline: readonly BaselineEntry[],
  metrics: readonly Pick<BaselineEntry, "file" | "identity" | "fingerprint" | "complexity">[],
): void {
  assertUniqueBaseline(baseline);
  if (metrics.length !== baseline.length) throw new Error("function count changed");
  metrics.forEach((metric, index) => {
    const entry = baseline[index];
    if (
      entry.file !== metric.file ||
      entry.identity !== metric.identity ||
      entry.fingerprint !== metric.fingerprint
    )
      throw new Error(`identity/fingerprint mismatch for ${metric.file}:${metric.identity}`);
    if (entry.complexity !== metric.complexity)
      throw new Error(
        `complexity mismatch for ${metric.file}:${metric.identity}: expected ${entry.complexity}, actual ${metric.complexity}`,
      );
  });
}

export function verifyBaseline(
  baseline: BaselineDocument,
  commit: string,
  repoRoot: string,
): { files: number; functions: number; metricsDigest: string } {
  if (commit !== expectedCommit || baseline.commit !== expectedCommit)
    throw new Error(`baseline provenance requires historical commit ${expectedCommit}`);
  assertUniqueBaseline(baseline.entries);
  const files = [...new Set(baseline.entries.map((entry) => entry.file))];
  const entries: BaselineEntry[] = [];
  for (const file of files) {
    const text = execFileSync("git", ["show", `${commit}:${file}`], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    const metrics = analyzeFile(file, text, undefined, repoRoot);
    const old = baseline.entries.filter((entry) => entry.file === file);
    if (metrics.length !== old.length) throw new Error(`function count changed for ${file}`);
    verifyMetricEntries(old, metrics);
    entries.push(...old);
  }
  return {
    files: files.length,
    functions: entries.length,
    metricsDigest: createHash("sha256").update(JSON.stringify(entries)).digest("hex"),
  };
}

if (import.meta.main) {
  const root = new URL("../..", import.meta.url).pathname;
  const commit = process.argv[2];
  if (!commit || commit === "HEAD" || commit === expectedCommit + "-working-tree")
    throw new Error(`usage: bun scripts/crap/verify-baseline.ts ${expectedCommit}`);
  const baseline = JSON.parse(
    readFileSync(`${root}/quality/crap-baseline.json`, "utf8"),
  ) as BaselineDocument;
  console.log(JSON.stringify({ commit, ...verifyBaseline(baseline, commit, root) }));
}
