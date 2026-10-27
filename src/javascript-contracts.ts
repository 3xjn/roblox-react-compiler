import ts from 'typescript';

/** Type-only trust at the public boundary of declaration-paired erased JS.
 * Internal reads remain unknown. No runtime validation is implied. */
export function trustedJavaScriptReturns(trusted: (node: ts.SignatureDeclaration) => boolean,
  projectType?: (type:ts.TypeNode,owner:ts.SignatureDeclaration)=>ts.TypeNode) {
  const active = new WeakSet<ts.Node>();
  return (node: ts.Node, visit: ts.Visitor): ts.VisitResult<ts.Node> | undefined => {
    if (active.has(node)) return undefined;
    const value = ts.isReturnStatement(node) ? node.expression
      : ts.isExpression(node) && node.parent && ts.isArrowFunction(node.parent) && node.parent.body === node ? node : undefined;
    if (!value) return undefined;
    let owner: ts.Node | undefined = node.parent;
    while (owner && !ts.isFunctionLike(owner)) owner = owner.parent;
    if (!owner || !ts.isFunctionLike(owner) || !owner.type || !trusted(owner)) return undefined;
    active.add(node);
    try {
      const next = ts.visitNode(node, visit)!;
      const type = projectType?projectType(owner.type,owner):ts.visitNode(owner.type, visit) as ts.TypeNode;
      return ts.isReturnStatement(next) ? ts.factory.updateReturnStatement(next,
        next.expression && ts.factory.createAsExpression(next.expression, type))
        : ts.factory.createAsExpression(next as ts.Expression, type);
    } finally { active.delete(node); }
  };
}
