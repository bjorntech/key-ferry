import { readFileSync } from "node:fs";
import ts from "typescript";
import {
  cyclomaticComplexity,
  functionIdentity,
  functionName,
  isFunction,
  ownStatements,
} from "./complexity.js";
import { sourceCoverage, statementsFromIstanbul } from "./coverage.js";
import { functionFingerprint } from "./fingerprint.js";
import { crapScore, type FunctionMetric } from "./model.js";

export function analyzeFile(
  file: string,
  text: string,
  instrumentedCoverage: unknown,
): FunctionMetric[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const statements = statementsFromIstanbul(instrumentedCoverage, source);
  const result: FunctionMetric[] = [];
  function visit(node: ts.Node, ancestors: ts.Node[] = []): void {
    if (isFunction(node)) {
      const own = ownStatements(node, statements);
      const coverage = sourceCoverage(own);
      const complexity = cyclomaticComplexity(node);
      const start = node.getStart(source);
      const end = node.end;
      const identity = functionIdentity(node, source, ancestors);
      result.push({
        id: `${file}:${start}`,
        name: functionName(node, source),
        file,
        start,
        end,
        line: source.getLineAndCharacterOfPosition(start).line + 1,
        complexity,
        coverage: coverage.coverage,
        crap: crapScore(complexity, coverage.coverage),
        executableStatements: coverage.total,
        coveredStatements: coverage.covered,
        fingerprint: functionFingerprint(node, source),
        identity,
      });
      ts.forEachChild(node, (child) => visit(child, [...ancestors, node]));
      return;
    }
    ts.forEachChild(node, (child) => visit(child, [...ancestors, node]));
  }
  visit(source);
  return result;
}

export function analyzeSource(file: string, coverage: unknown): FunctionMetric[] {
  return analyzeFile(file, readFileSync(file, "utf8"), coverage);
}
