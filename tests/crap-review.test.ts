import { describe, expect, test } from "bun:test";
import ts from "typescript";
import { analyzeFile } from "../scripts/crap/analyze.js";
import { crapScore } from "../scripts/crap/model.js";
import { evaluate } from "../scripts/crap/policy.js";

const source = (text: string) =>
  ts.createSourceFile("fixture.ts", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

describe("CRAP quality checker regression cases", () => {
  test("uses unrounded CRAP at the quality gate", () => {
    const rawScore = crapScore(3, 0.306635);
    expect(rawScore).toBeGreaterThan(6);
    expect(
      evaluate(
        {
          id: "fixture.ts:0",
          name: "f",
          file: "fixture.ts",
          start: 0,
          end: 1,
          complexity: 3,
          coverage: 0.306635,
          crap: rawScore,
          executableStatements: 437,
          coveredStatements: 134,
          fingerprint: "fixture",
        },
        undefined,
        false,
      ).status,
    ).toBe("fail");

    const statements = Array.from({ length: 432 }, (_, index) => `void ${index};`).join(" ");
    const text = `function f(a: boolean, b: boolean) { ${statements} if (a) return 1; if (b) return 2; return 3 }`;
    const file = source(text);
    const fn = file.statements[0] as ts.FunctionDeclaration;
    const executable: ts.Statement[] = [];
    const visit = (node: ts.Node) => {
      if (node !== fn && ts.isStatement(node) && !ts.isBlock(node)) executable.push(node);
      ts.forEachChild(node, visit);
    };
    visit(fn.body!);
    expect(executable).toHaveLength(437);
    const statementMap = Object.fromEntries(
      executable.map((statement, index) => [
        String(index),
        {
          start: (() => {
            const position = file.getLineAndCharacterOfPosition(statement.getStart(file));
            return { line: position.line + 1, column: position.character };
          })(),
          end: (() => {
            const position = file.getLineAndCharacterOfPosition(statement.end);
            return { line: position.line + 1, column: position.character };
          })(),
        },
      ]),
    );
    const s = Object.fromEntries(
      executable.map((_, index) => [String(index), index < 134 ? 1 : 0]),
    );

    const metric = analyzeFile("fixture.ts", text, { statementMap, s })[0];
    expect(metric.complexity).toBe(3);
    expect(metric.coverage).toBeCloseTo(134 / 437, 4);
    expect(metric.crap).toBeGreaterThan(6);
    expect(evaluate(metric, undefined, false).status).toBe("fail");
  });

  test("rejects an Istanbul record with invalid statement counters", () => {
    const text = "function f() { return 1 }";
    const statementMap = { "0": { start: { line: 1, column: 15 }, end: { line: 1, column: 23 } } };
    expect(() =>
      analyzeFile("fixture.ts", text, {
        statementMap,
        s: { "0": "not-a-counter" },
      } as never),
    ).toThrow();
    expect(() =>
      analyzeFile("fixture.ts", text, {
        statementMap,
        s: { "1": 1 },
      } as never),
    ).toThrow();
  });

  test("fails unchanged functions whose score worsens even below the CRAP gate", () => {
    const metric = {
      id: "fixture.ts:0",
      name: "f",
      file: "fixture.ts",
      start: 0,
      end: 20,
      complexity: 2,
      coverage: 0.9,
      crap: 5.5,
      executableStatements: 10,
      coveredStatements: 9,
      fingerprint: "stable",
    };
    const baseline = { ...metric, coverage: 0.95, crap: 5, identity: "fixture.ts:f:stable" };
    expect(evaluate(metric, baseline, false).status).toBe("fail");
  });
});
