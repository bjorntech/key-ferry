const DEFAULT_LINES = 0.9;
const DEFAULT_FUNCTIONS = 0.75;

type FileCoverage = {
  functionsFound: number;
  functionsHit: number;
  lines: Map<number, number>;
};

export type CoverageMetrics = {
  lineTotal: number;
  lineHit: number;
  functionTotal: number;
  functionHit: number;
  lineRatio: number;
  functionRatio: number;
};

const normalizePath = (file: string) => file.replaceAll("\\", "/").replace(/^\.\//, "");

const isRuntimeSource = (file: string) => {
  const normalized = normalizePath(file);
  return (
    normalized.startsWith("src/") &&
    !/(?:^|\/)(?:generated|__tests__|tests?)(?:\/|$)/.test(normalized) &&
    !/\.(?:test|spec)\.[^/]+$/.test(normalized)
  );
};

const integer = (value: string, label: string) => {
  if (!/^\d+$/.test(value)) throw new Error(`Malformed LCOV ${label}: ${value}`);
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw new Error(`Malformed LCOV ${label}: ${value}`);
  return result;
};

/** Parse LCOV records, retaining only runtime sources under src/. */
export const parseLcov = (text: string): Map<string, FileCoverage> => {
  if (!text.trim()) throw new Error("Coverage file is empty");
  const files = new Map<string, FileCoverage>();
  let current:
    | { file: string; coverage: FileCoverage; seenFNF: boolean; seenFNH: boolean; seenDA: boolean }
    | undefined;
  let sawRecord = false;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line === "end_of_record") {
      if (!current) throw new Error("LCOV end_of_record has no source filename");
      if (!current.seenFNF || !current.seenFNH || !current.seenDA)
        throw new Error(`Malformed LCOV record for ${current.file}: missing FNF/FNH/DA`);
      if (current.coverage.functionsHit > current.coverage.functionsFound)
        throw new Error(`Malformed LCOV function counts for ${current.file}`);
      current = undefined;
      continue;
    }
    const separator = line.indexOf(":");
    if (separator < 1) throw new Error(`Malformed LCOV record: ${line}`);
    const tag = line.slice(0, separator);
    const value = line.slice(separator + 1);
    if (tag === "TN") {
      if (value && value.includes("\0")) throw new Error("Malformed LCOV test name");
      continue;
    }
    if (tag === "SF") {
      if (current)
        throw new Error(`LCOV source record for ${current.file} is missing end_of_record`);
      if (!value) throw new Error("Malformed LCOV source filename");
      const file = normalizePath(value);
      current = {
        file,
        coverage: files.get(file) ?? { functionsFound: 0, functionsHit: 0, lines: new Map() },
        seenFNF: false,
        seenFNH: false,
        seenDA: false,
      };
      files.set(file, current.coverage);
      sawRecord = true;
      continue;
    }
    if (!current) throw new Error(`LCOV record precedes source filename: ${line}`);
    if (tag === "FNF" || tag === "FNH") {
      const count = integer(value, tag);
      if (tag === "FNF")
        current.coverage.functionsFound = Math.max(current.coverage.functionsFound, count);
      else current.coverage.functionsHit = Math.max(current.coverage.functionsHit, count);
      if (tag === "FNF") current.seenFNF = true;
      else current.seenFNH = true;
    } else if (tag === "DA") {
      const [lineNumber, hits, ...rest] = value.split(",");
      if (!lineNumber || !hits || rest.length > 1)
        throw new Error(`Malformed LCOV DA record: ${line}`);
      const number = integer(lineNumber, "DA line");
      if (number < 1) throw new Error(`Malformed LCOV DA line: ${lineNumber}`);
      const count = integer(hits, "DA hits");
      current.coverage.lines.set(number, Math.max(current.coverage.lines.get(number) ?? 0, count));
      current.seenDA = true;
    } else if (["FN", "FNDA", "BRDA", "BRF", "BRH"].includes(tag)) {
      // Function/branch detail is intentionally not used for totals; DA and
      // FNF/FNH are the portable LCOV aggregate records used by this gate.
    } else if (tag === "LF" || tag === "LH") {
      integer(value, tag);
    } else {
      throw new Error(`Unsupported or malformed LCOV record: ${line}`);
    }
  }
  if (current) throw new Error(`LCOV record for ${current.file} is missing end_of_record`);
  if (!sawRecord) throw new Error("Coverage file contains no source records");
  return new Map([...files].filter(([file]) => isRuntimeSource(file)));
};

export const evaluateCoverage = (
  files: Map<string, FileCoverage>,
  linesThreshold = DEFAULT_LINES,
  functionsThreshold = DEFAULT_FUNCTIONS,
): CoverageMetrics => {
  if (
    !(linesThreshold >= 0 && linesThreshold <= 1) ||
    !(functionsThreshold >= 0 && functionsThreshold <= 1)
  )
    throw new Error("Coverage thresholds must be between 0 and 1");
  let lineTotal = 0;
  let lineHit = 0;
  let functionTotal = 0;
  let functionHit = 0;
  for (const coverage of files.values()) {
    lineTotal += coverage.lines.size;
    lineHit += [...coverage.lines.values()].filter((hits) => hits > 0).length;
    functionTotal += coverage.functionsFound;
    functionHit += coverage.functionsHit;
  }
  if (!lineTotal || !functionTotal)
    throw new Error("Coverage contains no executable runtime lines or functions");
  return {
    lineTotal,
    lineHit,
    functionTotal,
    functionHit,
    lineRatio: lineHit / lineTotal,
    functionRatio: functionHit / functionTotal,
  };
};

if (import.meta.main) {
  const path = Bun.argv[2] ?? "coverage/lcov.info";
  try {
    const metrics = evaluateCoverage(parseLcov(await Bun.file(path).text()));
    const lines = `${(metrics.lineRatio * 100).toFixed(2)}% (${metrics.lineHit}/${metrics.lineTotal})`;
    const functions = `${(metrics.functionRatio * 100).toFixed(2)}% (${metrics.functionHit}/${metrics.functionTotal})`;
    console.log(`Aggregate runtime coverage: lines ${lines}, functions ${functions}`);
    if (metrics.lineRatio < DEFAULT_LINES || metrics.functionRatio < DEFAULT_FUNCTIONS) {
      throw new Error(`Coverage gate failed (required lines >= 90.00%, functions >= 75.00%)`);
    }
  } catch (error) {
    console.error(
      `Coverage check failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
