import ts from 'typescript';
import type {ImportBinding} from './index.ts';

/** Implementation language and rendering capability are independent. */
export function sourceFrontend(source:ts.SourceFile):'javascript'|'typescript' {
  return /\.[cm]?jsx?$/i.test(source.fileName)?'javascript':'typescript';
}
export function containsJsx(source:ts.SourceFile):boolean {
  let found=false;
  const visit=(node:ts.Node):void=>{
    if(found||ts.isTypeNode(node))return;
    if(ts.isJsxElement(node)||ts.isJsxSelfClosingElement(node)||ts.isJsxFragment(node)){found=true;return;}
    ts.forEachChild(node,visit);
  };visit(source);return found;
}

/** Classic factories have the same rendering ownership as the JSX runtime.
 * Resolve their imported identity, including immutable aliases; an unrelated
 * object with a createElement method is still ordinary source data. */
export function reactCreateElement(expression:ts.Node,checker:ts.TypeChecker):boolean {
  const active=new Set<ts.Node>();
  function unwrap(node:ts.Node):ts.Node {
    while(ts.isParenthesizedExpression(node)||ts.isAsExpression(node)||ts.isSatisfiesExpression(node)||ts.isTypeAssertionExpression(node))node=node.expression;
    if(ts.isBinaryExpression(node)&&node.operatorToken.kind===ts.SyntaxKind.CommaToken
      &&ts.isNumericLiteral(node.left)&&Number(node.left.text)===0)return unwrap(node.right);
    return node;
  }
  function imported(node:ts.Node,namespace:boolean):boolean {
    node=unwrap(node);
    if(active.has(node)||!ts.isIdentifier(node))return false;
    active.add(node);
    const symbol=checker.getSymbolAtLocation(node);
    for(const declaration of symbol?.declarations??[]){
      const owner=ts.findAncestor(declaration,ts.isImportDeclaration);
      if(owner&&ts.isStringLiteral(owner.moduleSpecifier)&&owner.moduleSpecifier.text==='react'
        &&owner.importClause&&!owner.importClause.isTypeOnly){
        if(namespace&&(ts.isNamespaceImport(declaration)||ts.isImportClause(declaration)))return true;
        if(namespace&&ts.isImportSpecifier(declaration)&&!declaration.isTypeOnly
          &&(declaration.propertyName??declaration.name).text==='default')return true;
        if(!namespace&&ts.isImportSpecifier(declaration)&&!declaration.isTypeOnly
          &&(declaration.propertyName??declaration.name).text==='createElement')return true;
      }
      if(ts.isVariableDeclaration(declaration)&&declaration.initializer&&declaration.parent
        &&ts.isVariableDeclarationList(declaration.parent)&&declaration.parent.flags&ts.NodeFlags.Const){
        if(namespace?imported(declaration.initializer,true):factory(declaration.initializer))return true;
      }
      if(!namespace&&ts.isBindingElement(declaration)&&!declaration.initializer&&!declaration.dotDotDotToken
        &&ts.isObjectBindingPattern(declaration.parent)&&ts.isVariableDeclaration(declaration.parent.parent)){
        const owner=declaration.parent.parent,key=declaration.propertyName??declaration.name;
        if((ts.isIdentifier(key)||ts.isStringLiteralLike(key))&&key.text==='createElement'&&owner.initializer
          &&ts.isVariableDeclarationList(owner.parent)&&owner.parent.flags&ts.NodeFlags.Const
          &&imported(owner.initializer,true))return true;
      }
    }
    return false;
  }
  function factory(node:ts.Node):boolean {
    node=unwrap(node);
    if(ts.isIdentifier(node))return imported(node,false);
    if(ts.isPropertyAccessExpression(node)||ts.isElementAccessExpression(node)){
      const member=ts.isPropertyAccessExpression(node)?node.name.text
        :ts.isStringLiteralLike(node.argumentExpression)?node.argumentExpression.text:undefined;
      return member==='createElement'&&imported(node.expression,true);
    }
    return false;
  }
  return factory(expression);
}

/** These imports are compiler syntax. Never run a browser React JSX runtime. */
export function jsxRuntimeExport(expression: ts.Node, checker: ts.TypeChecker): 'jsx' | 'jsxs' | 'jsxDEV' | 'Fragment' | undefined {
  while (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) || ts.isSatisfiesExpression(expression)) expression = expression.expression;
  if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.CommaToken
    && ts.isNumericLiteral(expression.left) && Number(expression.left.text) === 0) return jsxRuntimeExport(expression.right, checker);
  let root: ts.Identifier, member: string | undefined;
  if (ts.isIdentifier(expression)) root = expression;
  else if ((ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) && ts.isIdentifier(expression.expression)) {
    root = expression.expression;
    member = ts.isPropertyAccessExpression(expression) ? expression.name.text
      : ts.isStringLiteral(expression.argumentExpression) ? expression.argumentExpression.text : undefined;
    if (member === undefined) return undefined;
  } else return undefined;
  for (const declaration of checker.getSymbolAtLocation(root)?.declarations ?? []) {
    const owner = ts.findAncestor(declaration, ts.isImportDeclaration);
    if (!owner || !ts.isStringLiteral(owner.moduleSpecifier) || !owner.importClause || owner.importClause.isTypeOnly) continue;
    const module = owner.moduleSpecifier.text;
    if (module !== 'react/jsx-runtime' && module !== 'react/jsx-dev-runtime') continue;
    let name: string | undefined;
    if (ts.isImportSpecifier(declaration) && !declaration.isTypeOnly && member === undefined) name = (declaration.propertyName ?? declaration.name).text;
    else if ((ts.isNamespaceImport(declaration) || ts.isImportClause(declaration)) && member !== undefined) name = member;
    if (name === 'Fragment' || module === 'react/jsx-runtime' && (name === 'jsx' || name === 'jsxs')
      || module === 'react/jsx-dev-runtime' && name === 'jsxDEV') return name;
  }
  return undefined;
}

/** Select a frontend by syntax/capabilities, never by .ts versus .tsx. Ordinary
 * helpers retain data types and module initialization even beside JSX files. */
export function sourceMode(source:ts.SourceFile,checker:ts.TypeChecker,bindings:readonly ImportBinding[]):'data'|'component' {
  const react=new Map<ts.Symbol,string>();
  for(const statement of source.statements){
    if(!ts.isImportDeclaration(statement)||!ts.isStringLiteral(statement.moduleSpecifier)||!statement.importClause||statement.importClause.isTypeOnly)continue;
    const module=statement.moduleSpecifier.text,clause=statement.importClause;
    const runtime=(name:string)=>bindings.some(binding=>binding.module===module&&binding.name===name&&binding.kind!=='value');
    if(clause.name&&runtime('default'))return 'component';
    if(clause.namedBindings&&ts.isNamespaceImport(clause.namedBindings)){
      if(runtime('*'))return 'component';
      if(module==='react'){const symbol=checker.getSymbolAtLocation(clause.namedBindings.name);if(symbol)react.set(symbol,'*');}
    }else if(clause.namedBindings)for(const item of clause.namedBindings.elements){
      if(item.isTypeOnly)continue;
      const name=(item.propertyName??item.name).text;
      if(runtime(name))return 'component';
      if(module==='react'){const symbol=checker.getSymbolAtLocation(item.name);if(symbol)react.set(symbol,name);}
    }
    if(module==='react'&&clause.name){const symbol=checker.getSymbolAtLocation(clause.name);if(symbol)react.set(symbol,'*');}
  }
  let component=false;
  function visit(node:ts.Node){
    if(component||ts.isTypeNode(node))return;
    if(ts.isJsxElement(node)||ts.isJsxSelfClosingElement(node)||ts.isJsxFragment(node)){component=true;return;}
    if(ts.isCallExpression(node)){
      const callee=node.expression;
      if(jsxRuntimeExport(callee,checker)||reactCreateElement(callee,checker)){component=true;return;}
      if(ts.isIdentifier(callee)){
        const symbol=checker.getSymbolAtLocation(callee);
        if(symbol&&['forwardRef','memo'].includes(react.get(symbol)??''))component=true;
      }else if(ts.isPropertyAccessExpression(callee)&&ts.isIdentifier(callee.expression)){
        const symbol=checker.getSymbolAtLocation(callee.expression);
        if(symbol&&react.get(symbol)==='*'&&['forwardRef','memo'].includes(callee.name.text))component=true;
      }
    }
    if(!component)ts.forEachChild(node,visit);
  }
  visit(source);
  return component?'component':'data';
}
