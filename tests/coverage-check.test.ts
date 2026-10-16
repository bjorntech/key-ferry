import { describe, expect, test } from "bun:test";
import { evaluateCoverage, parseLcov } from "../scripts/check-coverage";

const record = (body: string) => `TN:\nSF:src/example.ts\n${body}\nend_of_record\n`;

describe("aggregate LCOV coverage checker", () => {
  test("accepts the minimum valid aggregate", () => {
    const metrics = evaluateCoverage(
      parseLcov(record("FNF:4\nFNH:3\nDA:1,1\nDA:2,1\nDA:3,1\nDA:4,0")),
    );
    expect(metrics.lineRatio).toBe(0.75);
    expect(metrics.functionRatio).toBe(0.75);
    expect(metrics.lineTotal).toBe(4);
  });

  test("deduplicates source records and merges DA hits", () => {
    const lcov = `${record("FNF:2\nFNH:1\nDA:1,1\nDA:2,0")}${record("FNF:2\nFNH:2\nDA:1,0\nDA:2,2")}`;
    const metrics = evaluateCoverage(parseLcov(lcov));
    expect(metrics).toMatchObject({ lineTotal: 2, lineHit: 2, functionTotal: 2, functionHit: 2 });
  });

  test.each([
    ["below lines", 0.5, 1],
    ["below functions", 1, 0.5],
  ])("reports %s without rounding", (_, lines, functions) => {
    const metrics = evaluateCoverage(
      parseLcov(record("FNF:2\nFNH:1\nDA:1,1\nDA:2,0")),
      lines,
      functions,
    );
    expect(metrics.lineRatio < lines || metrics.functionRatio < functions).toBe(true);
  });

  test.each([
    "",
    "SF:src/x.ts\nFNF:1",
    "SF:src/x.ts\nFNF:-1\nFNH:0\nDA:1,1\nend_of_record",
    "SF:src/x.ts\nFNF:1\nFNH:2\nDA:1,1\nend_of_record",
  ])("rejects malformed or empty LCOV: %s", (input) => {
    expect(() => parseLcov(input)).toThrow();
  });

  test("filters non-runtime paths and does not claim branch coverage", () => {
    const files = parseLcov(
      `${record("FNF:1\nFNH:1\nDA:1,1\nBRF:1\nBRH:1")}${record("FNF:1\nFNH:0\nDA:1,0").replace("src/example.ts", "tests/example.test.ts")}`,
    );
    expect(files.size).toBe(1);
  });
});
