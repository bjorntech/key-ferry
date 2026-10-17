import ts from "typescript";

const decisions = new Set([
  ts.SyntaxKind.IfStatement,
  ts.SyntaxKind.ForStatement,
  ts.SyntaxKind.ForInStatement,
  ts.SyntaxKind.ForOfStatement,
  ts.SyntaxKind.WhileStatement,
  ts.SyntaxKind.DoStatement,
  ts.SyntaxKind.ConditionalExpression,
  ts.SyntaxKind.CatchClause,
  ts.SyntaxKind.CaseClause,
]);

const logical = new Set([
  ts.SyntaxKind.AmpersandAmpersandToken,
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.QuestionQuestionToken,
]);

export function isFunction(node: ts.Node): node is ts.FunctionLikeDeclaration {
  const declaration =
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node);
  if (!declaration) return false;
  if (!("body" in node) || !node.body) return false;
  return !node.modifiers?.some(
    (modifier) =>
      modifier.kind === ts.SyntaxKind.DeclareKeyword ||
      modifier.kind === ts.SyntaxKind.AbstractKeyword,
  );
}

export function cyclomaticComplexity(node: ts.FunctionLikeDeclaration): number {
  let result = 1;
  function visit(child: ts.Node): void {
    if (child !== node && isFunction(child)) return;
    if (decisions.has(child.kind)) result += 1;
    if (ts.isBinaryExpression(child) && logical.has(child.operatorToken.kind)) result += 1;
    ts.forEachChild(child, visit);
  }
  ts.forEachChild(node, visit);
  return result;
}

export function functionName(node: ts.FunctionLikeDeclaration, source: ts.SourceFile): string {
  if (ts.isConstructorDeclaration(node)) return "constructor";
  if (
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  ) {
    return node.name.getText(source);
  }
  if (ts.isFunctionDeclaration(node) && node.name) return node.name.text;
  if (ts.isVariableDeclaration(node)) return node.name.getText(source);
  return "<anonymous>";
}

export function functionIdentity(
  node: ts.FunctionLikeDeclaration,
  source: ts.SourceFile,
  ancestors: readonly ts.Node[],
): string {
  const parent = ancestors.at(-1);
  const nodeParent = new Map<ts.Node, ts.Node | undefined>();
  const functionParent = new Map<ts.Node, ts.FunctionLikeDeclaration | undefined>();
  const allFunctions: ts.FunctionLikeDeclaration[] = [];
  const collectFunctions = (current: ts.Node, enclosing?: ts.FunctionLikeDeclaration): void => {
    const next = isFunction(current) ? current : enclosing;
    if (isFunction(current)) {
      functionParent.set(current, enclosing);
      allFunctions.push(current);
    }
    ts.forEachChild(current, (child) => {
      nodeParent.set(child, current);
      collectFunctions(child, next);
    });
  };
  collectFunctions(source);
  const findParent = (candidate: ts.Node): ts.Node | undefined => nodeParent.get(candidate);
  const className = (ancestor: ts.Node): string | undefined =>
    (ts.isClassDeclaration(ancestor) || ts.isClassExpression(ancestor)) && ancestor.name
      ? ancestor.name.text
      : undefined;
  const named = (candidate: ts.FunctionLikeDeclaration, immediate: ts.Node | undefined): string => {
    if (ts.isFunctionDeclaration(candidate) && candidate.name) return candidate.name.text;
    if (
      (ts.isMethodDeclaration(candidate) ||
        ts.isGetAccessorDeclaration(candidate) ||
        ts.isSetAccessorDeclaration(candidate)) &&
      candidate.name
    )
      return candidate.name.getText(source);
    if (ts.isConstructorDeclaration(candidate)) return "constructor";
    if (ts.isVariableDeclaration(immediate)) return immediate.name.getText(source);
    return "";
  };
  const callbackRole = (candidate: ts.Node, immediate: ts.Node | undefined): string => {
    if (immediate && ts.isCallExpression(immediate)) {
      const index = immediate.arguments.findIndex((argument) => argument === candidate);
      return `call:${immediate.expression.getText(source)}:arg:${index}`;
    }
    if (immediate && ts.isNewExpression(immediate)) {
      const index = (immediate.arguments ?? []).findIndex((argument) => argument === candidate);
      return `new:${immediate.expression.getText(source)}:arg:${index}`;
    }
    if (immediate && ts.isPropertyAssignment(immediate))
      return `property:${immediate.name.getText(source)}`;
    return "callback";
  };
  const label = (candidate: ts.FunctionLikeDeclaration, immediate: ts.Node | undefined): string => {
    const name = named(candidate, immediate);
    if (name) return name;
    const role = callbackRole(candidate, immediate);
    // Ordinal is only among callbacks with the same semantic role. Inserting a
    // different declaration therefore cannot rename an existing callback.
    const enclosing = functionParent.get(candidate);
    const ordinal = allFunctions
      .filter(
        (peer) =>
          functionParent.get(peer) === enclosing && callbackRole(peer, findParent(peer)) === role,
      )
      .sort((a, b) => a.getStart(source) - b.getStart(source))
      .indexOf(candidate);
    return `${role}#${Math.max(0, ordinal)}`;
  };
  const scope: string[] = [];
  for (let index = 0; index < ancestors.length; index += 1) {
    const ancestor = ancestors[index];
    if (isFunction(ancestor)) scope.push(label(ancestor, ancestors[index - 1]));
    const owner = className(ancestor);
    if (owner && !scope.includes(owner)) scope.push(owner);
  }
  const owner = scope.length ? scope : ["module"];
  owner.push(label(node, parent));
  return `${source.fileName}:${owner.join(".")}`;
}

export function ownStatements(
  node: ts.FunctionLikeDeclaration,
  statements: readonly { start: number; end: number; count: number }[],
): readonly { start: number; end: number; count: number }[] {
  const nested = new Set<number>();
  function visit(child: ts.Node): void {
    if (child !== node && isFunction(child)) {
      nested.add(child.getStart());
      return;
    }
    ts.forEachChild(child, visit);
  }
  ts.forEachChild(node, visit);
  return statements.filter((statement) => {
    if (statement.start < node.getStart() || statement.end > node.end) return false;
    return ![...nested].some((start) => statement.start >= start);
  });
}
