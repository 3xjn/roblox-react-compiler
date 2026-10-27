import ts from 'typescript';

const f = ts.factory;
function unwrap(node: ts.Expression): ts.Expression {
  return ts.isParenthesizedExpression(node) ? unwrap(node.expression) : node;
}
function entity(node: ts.Expression): ts.EntityName | undefined {
  if (ts.isIdentifier(node)) return node;
  if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.name)) {
    const left = entity(node.expression);
    if (left) return f.createQualifiedName(left, node.name);
  }
  return undefined;
}

/** An explicit any escape initialized from a known constructor can use that
 * constructor's instance type. This adds no fields, closures or runtime writes. */
export function initializedProperty(
  node: ts.Node,
): ts.BinaryExpression | undefined {
  if (
    !ts.isBinaryExpression(node) ||
    node.operatorToken.kind !== ts.SyntaxKind.QuestionQuestionEqualsToken
  )
    return undefined;
  const left = unwrap(node.left);
  if (
    !ts.isPropertyAccessExpression(left) ||
    !ts.isIdentifier(left.name) ||
    left.questionDotToken
  )
    return undefined;
  const receiver = unwrap(left.expression),
    initializer = unwrap(node.right);
  if (
    !(ts.isAsExpression(receiver) || ts.isTypeAssertionExpression(receiver)) ||
    receiver.type.kind !== ts.SyntaxKind.AnyKeyword ||
    !ts.isNewExpression(initializer)
  )
    return undefined;
  const constructor = entity(initializer.expression);
  if (!constructor) return undefined;
  const shape = f.createTypeLiteralNode([
    f.createPropertySignature(
      undefined,
      left.name,
      f.createToken(ts.SyntaxKind.QuestionToken),
      f.createTypeReferenceNode(constructor, initializer.typeArguments),
    ),
  ]);
  const checked = f.createParenthesizedExpression(
    f.createAsExpression(
      f.createAsExpression(
        receiver.expression,
        f.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
      ),
      shape,
    ),
  );
  return f.updateBinaryExpression(
    node,
    f.updatePropertyAccessExpression(left, checked, left.name),
    node.operatorToken,
    node.right,
  );
}
