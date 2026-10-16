import ts from "typescript";
import { isFunction } from "./complexity.js";

/** Canonical AST identity: trivia, semicolons, optional parentheses, and layout are ignored. */
export function functionFingerprint(
  node: ts.FunctionLikeDeclaration,
  source: ts.SourceFile,
): string {
  function serialize(current: ts.Node): string {
    if (current !== node && isFunction(current)) return "<nested-function>";
    if (ts.isParenthesizedExpression(current)) return serialize(current.expression);
    const children: string[] = [];
    ts.forEachChild(current, (child) => children.push(serialize(child)));
    if (!children.length) {
      if (ts.isStringLiteralLike(current)) return `${current.kind}:${JSON.stringify(current.text)}`;
      if (ts.isNumericLiteral(current)) return `${current.kind}:${current.text}`;
      if (ts.isIdentifier(current)) return `${current.kind}:${current.text}`;
      return String(current.kind);
    }
    return `${current.kind}[${children.join(",")}]`;
  }
  return serialize(node);
}
