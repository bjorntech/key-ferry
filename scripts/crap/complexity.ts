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
  const childIndex = (container: ts.Node, child: ts.Node): number => {
    let index = -1;
    let found = -1;
    ts.forEachChild(container, (candidate) => {
      index += 1;
      if (candidate === child) found = index;
      return undefined;
    });
    return found;
  };
  const owner = [...ancestors]
    .reverse()
    .find(
      (ancestor) =>
        ts.isClassDeclaration(ancestor) ||
        ts.isClassExpression(ancestor) ||
        ts.isObjectLiteralExpression(ancestor),
    );
  const ownerName =
    owner && (ts.isClassDeclaration(owner) || ts.isClassExpression(owner)) && owner.name
      ? owner.name.text
      : owner
        ? "object"
        : "module";
  let local = functionName(node, source);
  const parent = ancestors.at(-1);
  if (ts.isVariableDeclaration(parent)) local = parent.name.getText(source);
  if (local === "<anonymous>") {
    const parentChildren = parent
      ? [...parent.getChildren(source)].filter((child) => isFunction(child))
      : [];
    local = `callback#${Math.max(0, parentChildren.indexOf(node))}`;
  }
  const path: string[] = [];
  for (let index = 1; index < ancestors.length; index += 1) {
    const container = ancestors[index - 1];
    const child = ancestors[index];
    const sibling = childIndex(container, child);
    path.push(`${container.kind}-${sibling}`);
  }
  const sibling = parent ? childIndex(parent, node) : 0;
  path.push(`${node.kind}-${sibling}`);
  return `${ownerName}.${local}@${path.join("/")}`;
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
