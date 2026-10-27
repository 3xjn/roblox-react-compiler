import ts from 'typescript';

export interface ModuleBindingWrite {
  readonly identifier:ts.Identifier;
  readonly symbol:ts.Symbol;
  readonly deferred:boolean;
}

/** Factories expose module bindings after direct evaluation completes. A write
 * in a function or an instance-field initializer may happen after that boundary
 * and therefore requires a live binding even when its caller looks immediate. */
export function moduleBindingStability(source:ts.SourceFile,checker:ts.TypeChecker){
  const writes:ModuleBindingWrite[]=[],seen=new Set<ts.Identifier>();
  function target(node:ts.Node,deferred:boolean):void {
    if(ts.isIdentifier(node)){
      if(seen.has(node))return;seen.add(node);
      const symbol=ts.isShorthandPropertyAssignment(node.parent)?checker.getShorthandAssignmentValueSymbol(node.parent):checker.getSymbolAtLocation(node);
      if(symbol)writes.push({identifier:node,symbol,deferred});
    }else if(ts.isParenthesizedExpression(node)||ts.isAsExpression(node)||ts.isTypeAssertionExpression(node)||ts.isNonNullExpression(node)||ts.isSatisfiesExpression(node)
      ||ts.isSpreadElement(node)||ts.isSpreadAssignment(node))target(node.expression,deferred);
    else if(ts.isBinaryExpression(node)&&node.operatorToken.kind===ts.SyntaxKind.EqualsToken)target(node.left,deferred);
    else if(ts.isArrayLiteralExpression(node))node.elements.forEach(element=>target(element,deferred));
    else if(ts.isObjectLiteralExpression(node))for(const property of node.properties){
      if(ts.isShorthandPropertyAssignment(property))target(property.name,deferred);
      else if(ts.isPropertyAssignment(property))target(property.initializer,deferred);
      else if(ts.isSpreadAssignment(property))target(property.expression,deferred);
    }
    else if(ts.isVariableDeclarationList(node))for(const declaration of node.declarations)target(declaration.name,deferred);
    else if(ts.isArrayBindingPattern(node)||ts.isObjectBindingPattern(node))for(const element of node.elements)
      if(ts.isBindingElement(element))target(element.name,deferred);
  }
  function visit(node:ts.Node,deferred:boolean):void {
    // A class's extends expression is runtime code despite its TypeNode shape.
    if(ts.isExpressionWithTypeArguments(node)&&ts.isHeritageClause(node.parent)&&node.parent.token===ts.SyntaxKind.ExtendsKeyword
      &&ts.isClassLike(node.parent.parent)){visit(node.expression,deferred);return;}
    if(ts.isTypeNode(node))return;
    if(ts.isBinaryExpression(node)&&node.operatorToken.kind>=ts.SyntaxKind.FirstAssignment&&node.operatorToken.kind<=ts.SyntaxKind.LastAssignment)
      target(node.left,deferred);
    else if((ts.isPrefixUnaryExpression(node)||ts.isPostfixUnaryExpression(node))
      &&(node.operator===ts.SyntaxKind.PlusPlusToken||node.operator===ts.SyntaxKind.MinusMinusToken))target(node.operand,deferred);
    else if(ts.isForOfStatement(node)||ts.isForInStatement(node))target(node.initializer,deferred);
    if(ts.isFunctionLike(node)){
      ts.forEachChild(node,child=>{
        const entry='body'in node&&child===node.body||node.parameters.some(parameter=>parameter===child);
        visit(child,deferred||entry);
      });return;
    }
    if(ts.isPropertyDeclaration(node)){
      const instance=!node.modifiers?.some(modifier=>modifier.kind===ts.SyntaxKind.StaticKeyword);
      ts.forEachChild(node,child=>visit(child,deferred||instance&&child===node.initializer));return;
    }
    ts.forEachChild(node,child=>visit(child,deferred));
  }
  visit(source,false);
  const deferred=new Map<ts.Symbol,ModuleBindingWrite[]>();
  for(const write of writes)if(write.deferred){const entries=deferred.get(write.symbol)??[];entries.push(write);deferred.set(write.symbol,entries);}
  return {writes,stable:(symbol:ts.Symbol)=>!deferred.has(symbol),deferredWrites:(symbol:ts.Symbol)=>deferred.get(symbol)??[]};
}
