import ts from "typescript";
import { isFunction } from "./complexity.js";

/** Canonical AST identity: trivia, semicolons, optional parentheses, and layout are ignored. */
export function functionFingerprint(
  node: ts.FunctionLikeDeclaration,
  source: ts.SourceFile,
): string {
  const parents = new Map<ts.Node, ts.Node>();
  const collectParents = (current: ts.Node): void => {
    ts.forEachChild(current, (child) => {
      parents.set(child, current);
      collectParents(child);
    });
  };
  collectParents(source);
  const nestedSignature = (current: ts.FunctionLikeDeclaration): string => {
    const parent = parents.get(current);
    const binding =
      parent && ts.isVariableDeclaration(parent)
        ? `binding:${parent.name.getText(source)}`
        : parent && ts.isPropertyAssignment(parent)
          ? `binding:${parent.name.getText(source)}`
          : "";
    const children: string[] = binding ? [binding] : [];
    ts.forEachChild(current, (child) => {
      // A nested function has its own metric. Its body must not make the
      // enclosing function look changed, but its declaration semantics do.
      if (child !== current.body) children.push(serialize(child));
    });
    return `<nested-function>[${children.join(",")}]`;
  };
  function serialize(current: ts.Node): string {
    if (current !== node && isFunction(current)) return nestedSignature(current);
    if (ts.isParenthesizedExpression(current)) return serialize(current.expression);
    const children: string[] = [];
    ts.forEachChild(current, (child) => {
      children.push(serialize(child));
    });
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
