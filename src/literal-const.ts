import ts from 'typescript';

export function constAssertion(
  node: ts.Node,
): node is ts.AsExpression | ts.TypeAssertion {
  return (
    (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) &&
    ts.isTypeReferenceNode(node.type) &&
    ts.isIdentifier(node.type.typeName) &&
    node.type.typeName.text === 'const'
  );
}

/** Const context descends through literal entries, not calls, spreads or
 * arbitrary expressions. Inspect the source tree before instrumentation. */
export function constLiteral(node: ts.Node): boolean {
  let current = ts.getOriginalNode(node);
  while (current.parent) {
    const parent = current.parent;
    if (constAssertion(parent) && parent.expression === current) return true;
    if (
      ts.isParenthesizedExpression(parent) ||
      ts.isArrayLiteralExpression(parent)
    ) {
      current = parent;
    } else if (
      ts.isPropertyAssignment(parent) &&
      parent.initializer === current &&
      ts.isObjectLiteralExpression(parent.parent)
    ) {
      current = parent.parent;
    } else return false;
  }
  return false;
}

export function preserveConst<T extends ts.Expression>(
  literal: T,
  original: ts.Node,
): ts.Expression {
  return constLiteral(original)
    ? ts.factory.createAsExpression(
        literal,
        ts.factory.createTypeReferenceNode('const'),
      )
    : literal;
}
