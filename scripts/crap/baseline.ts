import { execFileSync } from "node:child_process";
import { analyzeFile } from "./analyze.js";
import type { FunctionMetric } from "./model.js";

export type BaselineEntry = Pick<
  FunctionMetric,
  "file" | "name" | "complexity" | "crap" | "coverage" | "fingerprint" | "identity"
>;

export function baselineSource(commit: string, file: string): string {
  return execFileSync("git", ["show", `${commit}:${file}`], {
    cwd: process.env.CRAP_REPO_ROOT ?? process.cwd(),
    encoding: "utf8",
  });
}

/** Build a baseline only from analyzed coverage. This intentionally has no zero-score seed path. */
export function baselineEntries(
  commit: string,
  files: readonly string[],
  coverage: ReadonlyMap<string, unknown>,
): BaselineEntry[] {
  return files.flatMap((file) => {
    const text = baselineSource(commit, file);
    return analyzeFile(file, text, coverage.get(file)).map(
      ({
        line: _line,
        start: _start,
        end: _end,
        id: _id,
        executableStatements: _total,
        coveredStatements: _covered,
        ...metric
      }) => metric,
    );
  });
}

export function assertUniqueBaseline(entries: readonly BaselineEntry[]): void {
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.identity))
      throw new Error(`Duplicate baseline function identity: ${entry.file}:${entry.identity}`);
    seen.add(entry.identity);
  }
}
