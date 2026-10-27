import ts from 'typescript';

/** Module-local declarations have no initialization effects. Keep every
 * declaration reachable from an export, initializer, statement or type query;
 * an unreachable recursive declaration cluster is safe to omit. */
export function unreachableFunctions(source:ts.SourceFile,checker:ts.TypeChecker):ReadonlySet<ts.FunctionDeclaration>{
  if(!ts.isExternalModule(source))return new Set();
  const declarations=new Map<ts.Symbol,ts.FunctionDeclaration[]>();
  for(const statement of source.statements)if(ts.isFunctionDeclaration(statement)&&statement.name){
    const symbol=checker.getSymbolAtLocation(statement.name);
    if(symbol){const list=declarations.get(symbol)??[];list.push(statement);declarations.set(symbol,list);}
  }
  const reachable=new Set<ts.Symbol>();
  const edges=new Map<ts.Symbol,Set<ts.Symbol>>();
  const references=(node:ts.Node,into:Set<ts.Symbol>)=>{
    if(ts.isIdentifier(node)){
      const parent=node.parent;
      if(!(ts.isFunctionDeclaration(parent)&&parent.name===node)){
        const symbol=ts.isExportSpecifier(parent)?checker.getExportSpecifierLocalTargetSymbol(parent)
          :ts.isShorthandPropertyAssignment(parent)?checker.getShorthandAssignmentValueSymbol(parent):checker.getSymbolAtLocation(node);
        if(symbol&&declarations.has(symbol))into.add(symbol);
      }
    }
    ts.forEachChild(node,child=>references(child,into));
  };
  for(const statement of source.statements){
    const symbol=ts.isFunctionDeclaration(statement)&&statement.name&&checker.getSymbolAtLocation(statement.name);
    if(symbol&&declarations.has(symbol)){
      const used=edges.get(symbol)??new Set<ts.Symbol>();references(statement,used);edges.set(symbol,used);
      if(statement.modifiers?.some(modifier=>modifier.kind===ts.SyntaxKind.ExportKeyword||modifier.kind===ts.SyntaxKind.DeclareKeyword))reachable.add(symbol);
    }else references(statement,reachable);
  }
  const queue=[...reachable];
  for(let index=0;index<queue.length;index++)for(const dependency of edges.get(queue[index]!)??[])
    if(!reachable.has(dependency)){reachable.add(dependency);queue.push(dependency);}
  return new Set([...declarations].flatMap(([symbol,nodes])=>reachable.has(symbol)?[]:nodes));
}
