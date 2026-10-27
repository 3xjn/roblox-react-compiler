import ts from 'typescript';

interface Context {
  readonly checker: ts.TypeChecker;
  readonly binding: (
    symbol: ts.Symbol | undefined,
    name: string,
  ) => string | undefined;
}

/** Follow source declarations, never a collection's spelling or method names.
 * The final native checker still owns generic constraints and narrowing. */
export function sourceIteratorMethod(
  expression: ts.Expression,
  context: Context,
): string | undefined {
  const seen = new Set<ts.Node>();
  function type(node: ts.TypeNode): string | undefined {
    if (seen.has(node)) return;
    seen.add(node);
    if (ts.isParenthesizedTypeNode(node)) return type(node.type);
    if (ts.isUnionTypeNode(node)) {
      const methods = node.types
        .filter(
          (t) =>
            t.kind !== ts.SyntaxKind.UndefinedKeyword &&
            !(
              ts.isLiteralTypeNode(t) &&
              t.literal.kind === ts.SyntaxKind.NullKeyword
            ),
        )
        .map(type);
      return methods.length &&
        methods.every((method) => method && method === methods[0])
        ? methods[0]
        : undefined;
    }
    if (!ts.isTypeReferenceNode(node) || !ts.isIdentifier(node.typeName))
      return;
    const symbol = context.checker.getSymbolAtLocation(node.typeName);
    const method = context.binding(symbol, node.typeName.text);
    if (method) return method;
    for (const declaration of symbol?.declarations ?? []) {
      if (ts.isTypeAliasDeclaration(declaration)) return type(declaration.type);
      if (ts.isTypeParameterDeclaration(declaration) && declaration.constraint)
        return type(declaration.constraint);
    }
  }
  function declaration(node: ts.Declaration): string | undefined {
    if (
      ts.isVariableDeclaration(node) ||
      ts.isParameter(node) ||
      ts.isPropertyDeclaration(node) ||
      ts.isPropertySignature(node) ||
      ts.isGetAccessorDeclaration(node)
    ) {
      if (node.type) return type(node.type);
      if ('initializer' in node && node.initializer)
        return value(node.initializer as ts.Expression);
    }
  }
  function value(node: ts.Expression): string | undefined {
    if (seen.has(node)) return;
    seen.add(node);
    if (ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node))
      return value(node.expression);
    if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node))
      return type(node.type);
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression))
      return context.binding(
        context.checker.getSymbolAtLocation(node.expression),
        node.expression.text,
      );
    if (ts.isCallExpression(node)) {
      const signature = context.checker.getResolvedSignature(node)?.declaration;
      if (signature?.type && ts.isTypeNode(signature.type))
        return type(signature.type);
    }
    const name = ts.isPropertyAccessExpression(node)
      ? node.name
      : ts.isIdentifier(node)
        ? node
        : undefined;
    if (!name) return;
    const symbol = context.checker.getSymbolAtLocation(name);
    for (const item of symbol?.declarations ?? []) {
      const method = declaration(item);
      if (method) return method;
    }
  }
  return value(expression);
}
