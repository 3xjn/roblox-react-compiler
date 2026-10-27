import ts from 'typescript';

/** Only primitive property keys using the standard, zero-argument method.
 * Custom objects, boxed values and unknown receivers retain native checking. */
export function propertyKeyStringCall(
  node: ts.CallExpression,
  checker: ts.TypeChecker,
  program: ts.Program,
) {
  const method = node.expression;
  if (!ts.isPropertyAccessExpression(method) || method.name.text !== 'toString')
    return undefined;
  const seen = new Set<ts.Type>();
  function key(type: ts.Type): boolean {
    if (
      seen.has(type) ||
      type.flags &
        (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never)
    )
      return false;
    seen.add(type);
    if (type.isUnion())
      return type.types.every((member) => {
        const valid = key(member);
        seen.delete(member);
        return valid;
      });
    const constraint = checker.getBaseConstraintOfType(type);
    return constraint && constraint !== type
      ? key(constraint)
      : !!(
          type.flags &
          (ts.TypeFlags.StringLike |
            ts.TypeFlags.NumberLike |
            ts.TypeFlags.ESSymbolLike)
        );
  }
  if (!key(checker.getTypeAtLocation(method.expression))) return undefined;
  const declaration = checker.getResolvedSignature(node)?.declaration;
  if (
    !declaration ||
    !program.isSourceFileDefaultLibrary(declaration.getSourceFile())
  )
    return undefined;
  return {
    receiver: method.expression,
    optional: !!(node.flags & ts.NodeFlags.OptionalChain),
    arguments: node.arguments.length + (node.typeArguments?.length ?? 0),
  };
}
