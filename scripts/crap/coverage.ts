import ts from "typescript";
import type { CoverageUnit } from "./model.js";

type IstanbulFile = {
  statementMap: Record<
    string,
    { start: { line: number; column: number }; end: { line: number; column: number } }
  >;
  s: Record<string, number>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(message: string): never {
  throw new Error(`Malformed Istanbul coverage: ${message}`);
}

export function statementsFromIstanbul(file: unknown, source: ts.SourceFile): CoverageUnit[] {
  // A valid instrumented file which was never imported has no coverage entry.
  if (file === undefined) return [];
  if (!isRecord(file) || !isRecord(file.statementMap) || !isRecord(file.s))
    fail("statementMap and s must be objects");
  const map = file.statementMap as Record<string, unknown>;
  const counters = file.s as Record<string, unknown>;
  for (const id of Object.keys(counters))
    if (!(id in map)) fail(`counter ${id} has no statement map entry`);
  const lineCount = source.getLineStarts().length;
  const functionMap = file.fnMap;
  const functionCounters = file.f;
  if ((functionMap === undefined) !== (functionCounters === undefined))
    fail("fnMap and f must be provided together");
  if (functionMap !== undefined || functionCounters !== undefined) {
    if (!isRecord(functionMap) || !isRecord(functionCounters)) fail("fnMap and f must be objects");
    for (const id of Object.keys(functionCounters))
      if (!(id in functionMap)) fail(`function counter ${id} has no function map entry`);
    for (const id of Object.keys(functionMap))
      if (!(id in functionCounters)) fail(`function map ${id} has no counter`);
    for (const [id, value] of Object.entries(functionMap)) {
      const fn = value as Record<string, unknown>;
      const location = fn.loc;
      if (!isRecord(location) || !isRecord(location.start) || !isRecord(location.end))
        fail(`function ${id} has an invalid location`);
      for (const point of [location.start, location.end]) {
        if (
          !isRecord(point) ||
          typeof point.line !== "number" ||
          !Number.isInteger(point.line) ||
          point.line < 1 ||
          point.line > lineCount ||
          typeof point.column !== "number" ||
          !Number.isInteger(point.column) ||
          point.column < 0
        )
          fail(`function ${id} has invalid coordinates`);
      }
      const count = functionCounters[id];
      if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0)
        fail(`function ${id} has an invalid counter`);
    }
  }
  return Object.entries(map).map(([id, value]) => {
    if (!isRecord(value) || !isRecord(value.start) || !isRecord(value.end))
      fail(`statement ${id} has an invalid location`);
    const start = value.start as Record<string, unknown>;
    const end = value.end as Record<string, unknown>;
    if (
      ![start.line, start.column, end.line, end.column].every(
        (n) => typeof n === "number" && Number.isInteger(n) && n >= 0,
      )
    )
      fail(`statement ${id} has invalid coordinates`);
    if (
      (start.line as number) < 1 ||
      (end.line as number) < 1 ||
      (start.line as number) > lineCount ||
      (end.line as number) > lineCount
    )
      fail(`statement ${id} is outside the source`);
    const starts = source.getLineStarts();
    const lineLength = (line: number) => {
      const lineStart = starts[line - 1];
      const next = line < starts.length ? starts[line] : source.text.length;
      return source.text.slice(lineStart, next).replace(/[\r\n]+$/, "").length;
    };
    if (
      (start.column as number) > lineLength(start.line as number) ||
      (end.column as number) > lineLength(end.line as number)
    )
      fail(`statement ${id} is outside its line in ${source.fileName}`);
    if (
      (end.line as number) < (start.line as number) ||
      ((end.line as number) === (start.line as number) &&
        (end.column as number) < (start.column as number))
    )
      fail(`statement ${id} has reversed coordinates`);
    const count = counters[id];
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0)
      fail(`statement ${id} has an invalid counter`);
    return {
      start: source.getPositionOfLineAndCharacter(
        (start.line as number) - 1,
        start.column as number,
      ),
      end: source.getPositionOfLineAndCharacter((end.line as number) - 1, end.column as number),
      count,
    };
  });
}

export function sourceCoverage(statements: readonly CoverageUnit[]): {
  total: number;
  covered: number;
  coverage: number;
} {
  const total = statements.length;
  const covered = statements.filter((statement) => statement.count > 0).length;
  return { total, covered, coverage: total === 0 ? 0 : covered / total };
}
