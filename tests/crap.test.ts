import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { analyzeFile } from "../scripts/crap/analyze.js";
import { baselineEntries } from "../scripts/crap/baseline.js";
import {
  cyclomaticComplexity,
  functionIdentity,
  ownStatements,
} from "../scripts/crap/complexity.js";
import { statementsFromIstanbul } from "../scripts/crap/coverage.js";
import { functionFingerprint } from "../scripts/crap/fingerprint.js";
import { crapScore, round } from "../scripts/crap/model.js";
import { evaluate } from "../scripts/crap/policy.js";

const source = (text: string) =>
  ts.createSourceFile("fixture.ts", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

describe("CRAP metrics", () => {
  test("uses the standard formula", () => {
    expect(crapScore(3, 1)).toBe(3);
    expect(crapScore(3, 0)).toBe(12);
    expect(crapScore(3, 0.306635)).toBeGreaterThan(6);
    expect(round(crapScore(3, 0.306635))).toBe(6);
  });

  test("counts decisions and logical operators, excluding nested functions", () => {
    const file = source(
      `function outer(a: boolean) { if (a && true) return () => a || false; return false }`,
    );
    const fn = file.statements[0] as ts.FunctionDeclaration;
    expect(cyclomaticComplexity(fn)).toBe(3);
    expect(
      cyclomaticComplexity((fn.body!.statements[0] as ts.IfStatement).thenStatement as never),
    ).toBeDefined();
  });

  test("fingerprints survive formatting changes", () => {
    const a = source(`function f(a:number){ return a ? 1 : 2 }`)
      .statements[0] as ts.FunctionDeclaration;
    const b = source(`function f( a: number ) {\n  return a ? 1 : 2;\n};`)
      .statements[0] as ts.FunctionDeclaration;
    expect(functionFingerprint(a, a.getSourceFile())).toBe(
      functionFingerprint(b, b.getSourceFile()),
    );
  });

  test("qualified identities distinguish same-body arrows", () => {
    const file = source(`const first = () => 1; const second = () => 1`);
    const first = (file.statements[0] as ts.VariableStatement).declarationList.declarations[0]
      .initializer as ts.ArrowFunction;
    const second = (file.statements[1] as ts.VariableStatement).declarationList.declarations[0]
      .initializer as ts.ArrowFunction;
    expect(
      functionIdentity(first, file, [
        file,
        file.statements[0],
        (file.statements[0] as ts.VariableStatement).declarationList.declarations[0],
      ]),
    ).not.toBe(
      functionIdentity(second, file, [
        file,
        file.statements[1],
        (file.statements[1] as ts.VariableStatement).declarationList.declarations[0],
      ]),
    );
  });

  test("rejects malformed counters but accepts an explicitly unloaded file", () => {
    const file = source("function f() { return 1 }");
    expect(statementsFromIstanbul(undefined, file)).toEqual([]);
    expect(() =>
      statementsFromIstanbul(
        {
          statementMap: { "0": { start: { line: 1, column: 0 }, end: { line: 1, column: 1 } } },
          s: {},
        },
        file,
      ),
    ).toThrow("Malformed Istanbul coverage");
    expect(() =>
      statementsFromIstanbul(
        {
          statementMap: { "0": { start: { line: 1, column: 0 }, end: { line: 1, column: 1 } } },
          s: { "0": -1 },
        },
        file,
      ),
    ).toThrow("Malformed Istanbul coverage");
    expect(() =>
      statementsFromIstanbul({ statementMap: {}, s: {}, fnMap: { "0": {} }, f: {} }, file),
    ).toThrow("Malformed Istanbul coverage");
  });

  test("baseline entries read an immutable commit in a shallow-safe fixture repo", () => {
    const repo = mkdtempSync(join(tmpdir(), "crap-baseline-"));
    try {
      const fixture = "function f(value: boolean) { if (value) return 1; return 0 }\n";
      writeFileSync(join(repo, "fixture.ts"), fixture);
      execFileSync("git", ["init", "-q"], { cwd: repo });
      execFileSync("git", ["add", "fixture.ts"], { cwd: repo });
      execFileSync(
        "git",
        [
          "-c",
          "user.name=CRAP test fixture",
          "-c",
          "user.email=crap-fixture@example.invalid",
          "commit",
          "-qm",
          "fixture",
        ],
        { cwd: repo },
      );
      const commit = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: repo,
        encoding: "utf8",
      }).trim();

      const baseline = baselineEntries(commit, ["fixture.ts"], new Map(), repo);
      expect(baseline.length).toBeGreaterThan(0);
      expect(
        baseline.every(
          (entry) => entry.crap > 0 && entry.fingerprint.length > 0 && entry.identity.length > 0,
        ),
      ).toBe(true);

      const changed =
        "function changed(value: boolean) { if (value) return 1; if (!value) return 2; return 0 }\n";
      writeFileSync(join(repo, "fixture.ts"), changed);
      const workingTreeMetric = analyzeFile("fixture.ts", changed, undefined)[0];
      const unchangedBaseline = baselineEntries(commit, ["fixture.ts"], new Map(), repo);
      expect(workingTreeMetric.fingerprint).not.toBe(baseline[0].fingerprint);
      expect(unchangedBaseline).toEqual(baseline);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("attributes statements to the function owning them", () => {
    const text = `function f() { const x = 1; return () => x }`;
    const file = source(text);
    const fn = file.statements[0] as ts.FunctionDeclaration;
    const nested = (fn.body!.statements[1] as ts.ReturnStatement).expression as ts.ArrowFunction;
    const statements = [
      { start: fn.body!.statements[0].getStart(), end: fn.body!.statements[0].end, count: 1 },
      { start: nested.getStart(), end: nested.end, count: 0 },
    ];
    expect(ownStatements(fn, statements)).toHaveLength(1);
  });

  test("reports an untested complex function above the gate", () => {
    const text = `function f(a: boolean, b: boolean) { if (a && b) return 1; if (a || b) return 2; return 3 }`;
    const file = source(text);
    const fn = file.statements[0] as ts.FunctionDeclaration;
    const statements = Object.fromEntries([]);
    const metric = analyzeFile("fixture.ts", text, { statementMap: {}, s: statements });
    expect(metric[0].coverage).toBe(0);
    expect(metric[0].crap).toBeGreaterThan(6);
    expect(cyclomaticComplexity(fn)).toBe(5);
  });

  test("ratchets unchanged legacy violations but fails changes and regressions", () => {
    const metric = {
      id: "x",
      name: "f",
      file: "x.ts",
      start: 1,
      end: 2,
      complexity: 4,
      coverage: 0,
      crap: 16,
      executableStatements: 1,
      coveredStatements: 0,
      fingerprint: "stable",
      identity: "module.f",
    };
    const baseline = { ...metric, identity: "x.ts:f:stable", coverage: 0, crap: 16 };
    expect(evaluate(metric, baseline, false).status).toBe("warn");
    expect(evaluate(metric, baseline, true).status).toBe("fail");
    expect(evaluate({ ...metric, crap: 17 }, baseline, false).status).toBe("fail");
    expect(
      evaluate(
        { ...metric, crap: 5.5, coverage: 0.5 },
        { ...baseline, crap: 5, coverage: 0.6 },
        false,
      ).status,
    ).toBe("fail");
    expect(
      evaluate(
        { ...metric, crap: 5.5, coverage: 0.7 },
        { ...baseline, crap: 5.5, coverage: 0.6 },
        false,
      ).status,
    ).toBe("pass");
  });
});
