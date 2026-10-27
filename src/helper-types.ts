import ts from 'typescript';
import path from 'node:path';
import fs from 'node:fs';
import {createCallProof} from './call-proof.ts';

export type SourceFunction = ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction;
export type InferredTypeProjection=(type:ts.Type,project:(type:ts.Type)=>ts.TypeNode)=>ts.TypeNode|undefined;
export type ExplicitTypeProjection=(node:ts.TypeNode,project?:(node:ts.TypeNode)=>ts.TypeNode)=>ts.TypeNode|undefined;

export interface HelperSignature {
  readonly parameters: readonly { readonly type: ts.TypeNode; readonly optional: boolean }[];
  readonly result: ts.TypeNode;
  readonly typeParameters: readonly ts.TypeParameterDeclaration[];
}

const DOM_ELEMENT_AND_EVENT_TYPES = new Set([
  'HTMLElement',
  'HTMLDivElement',
  'HTMLButtonElement',
  'HTMLInputElement',
  'HTMLSpanElement',
  'HTMLAnchorElement',
  'HTMLFormElement',
  'HTMLUListElement',
  'HTMLLIElement',
  'HTMLHeadingElement',
  'HTMLParagraphElement',
  'SVGSVGElement',
  'Element',
  'Node',
  'Document',
  'Window',
  'ShadowRoot',
  'Event',
  'UIEvent',
  'MouseEvent',
  'PointerEvent',
  'FocusEvent',
  'KeyboardEvent',
  'TouchEvent',
  'WheelEvent',
  'Animation',
  'AbortController',
  'ResizeObserver',
  'MutationObserver',
]);

const REACT_EVENT_TYPES = new Set([
  'PointerEvent',
  'MouseEvent',
  'FocusEvent',
  'KeyboardEvent',
  'ChangeEvent',
  'FormEvent',
  'SyntheticEvent',
  'UIEvent',
  'TouchEvent',
  'WheelEvent',
  'AnimationEvent',
  'TransitionEvent',
  'ClipboardEvent',
  'CompositionEvent',
  'DragEvent',
]);

const REACT_REF_TYPES = new Set([
  'Ref',
  'RefObject',
  'MutableRefObject',
  'ForwardedRef',
]);

const REACT_ATTR_TYPES = new Set([
  'ComponentProps',
  'ComponentPropsWithRef',
  'ComponentPropsWithoutRef',
  'HTMLAttributes',
  'ButtonHTMLAttributes',
  'InputHTMLAttributes',
  'AriaAttributes',
  'SVGProps',
]);
const REACT_NODE_TYPES = new Set(['ReactNode']);
const nativeLibraryRoot=ts.sys.resolvePath(path.dirname(ts.getDefaultLibFilePath({}))).replaceAll('\\','/');
const nativeLibraryText=new Map<string,string|undefined>();
function nativeLibrary(file:ts.SourceFile):boolean {
  const absolute=ts.sys.resolvePath(file.fileName).replaceAll('\\','/');
  const canonical=(name:string)=>ts.sys.useCaseSensitiveFileNames?name:name.toLowerCase();
  if(!file.hasNoDefaultLib||canonical(path.dirname(absolute).replaceAll('\\','/'))!==canonical(nativeLibraryRoot)
    ||!/^lib(?:\.[^/]+)?\.d\.ts$/.test(path.basename(absolute)))return false;
  const key=canonical(absolute);
  if(!nativeLibraryText.has(key)){
    let text:string|undefined;try{text=fs.readFileSync(absolute,'utf8');}catch{ /* Not an installed library. */ }
    nativeLibraryText.set(key,text);
  }
  const text=nativeLibraryText.get(key);return text!==undefined&&text===file.text;
}

// Resolve source-owned data types and safe platform/React projections. Callers
// may explicitly trust supplied declaration files; trust does not propagate to
// referenced files, and absent that callback declarations remain opaque.
export function createTypeProjection(checker: ts.TypeChecker, typeParameters: readonly ts.TypeParameterDeclaration[] = [],
  override?: ExplicitTypeProjection,
  trustedDeclaration?: (file: ts.SourceFile) => boolean, opaqueInferences=false,inferredOverride?:InferredTypeProjection,
  sourceFileName='', standardLibraryFile?: (file: ts.SourceFile) => boolean, reactInferenceEnabled=false) {
  const f = ts.factory;
  const isJsFile = /\.[cm]?jsx?$/.test(sourceFileName);
  const nativeNodes=new WeakSet<ts.Node>();
  const opaqueInferredAnnotations=new WeakSet<ts.Node>();
  const checkedInferredAnnotations=new WeakSet<ts.Node>();
  const containInferredAnnotation=(node:ts.Node)=>{
    if(!opaqueInferences||checkedInferredAnnotations.has(node))return;
    checkedInferredAnnotations.add(node);
    if(node.kind===ts.SyntaxKind.AnyKeyword)opaqueInferredAnnotations.add(node);
    ts.forEachChild(node,containInferredAnnotation);
  };
  const checkedNativeTypes=new Map<ts.Type,ts.TypeNode>();
  const native=(type:ts.TypeNode)=>{nativeNodes.add(type);return type;};
  function containsNative(node:ts.Node):boolean {
    if(nativeNodes.has(node)&&(ts.isTypeReferenceNode(node)||ts.isImportTypeNode(node)||ts.isTypeQueryNode(node)))return true;
    return ts.forEachChild(node,containsNative)??false;
  }
  const generic = new Set(typeParameters.map(p => checker.getSymbolAtLocation(p.name)));
  const recordStringUnknown = () => f.createTypeReferenceNode('Record', [
    f.createKeywordTypeNode(ts.SyntaxKind.StringKeyword),
    f.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
  ]);
  const refObjectType = (inner: ts.TypeNode) => f.createTypeLiteralNode([
    f.createPropertySignature(
      undefined,
      f.createIdentifier('current'),
      undefined,
      f.createUnionTypeNode([withoutUndefined(inner), f.createKeywordTypeNode(ts.SyntaxKind.UndefinedKeyword)]),
    ),
  ]);
  function reactStateType(name: string, arguments_: readonly ts.TypeNode[] | undefined,
    child: (node: ts.TypeNode) => ts.TypeNode): ts.TypeNode | undefined {
    if ((name !== 'Dispatch' && name !== 'SetStateAction') || arguments_?.length !== 1) return undefined;
    const value = child(arguments_[0]!);
    const callback = f.createFunctionTypeNode(undefined, [f.createParameterDeclaration(undefined, undefined, 'value', undefined, value)],
      name === 'Dispatch' ? f.createKeywordTypeNode(ts.SyntaxKind.VoidKeyword) : value);
    return name === 'Dispatch' ? callback : f.createUnionTypeNode([value, f.createParenthesizedType(callback)]);
  }

  function reactInference(type: ts.Type, project: (value: ts.Type) => ts.TypeNode): ts.TypeNode | undefined {
    if(!reactInferenceEnabled)return undefined;
    const symbol = type.aliasSymbol ?? type.getSymbol();
    const typeName = symbol?.getName();
    if (!typeName) return undefined;
    const nativeDomType = DOM_ELEMENT_AND_EVENT_TYPES.has(typeName) && builtin(symbol);
    if (!isImportedFromReactOrUnresolved(symbol) && !nativeDomType) return undefined;
    if (DOM_ELEMENT_AND_EVENT_TYPES.has(typeName) || REACT_EVENT_TYPES.has(typeName) || REACT_NODE_TYPES.has(typeName)) {
      return f.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);
    }
    if (REACT_REF_TYPES.has(typeName)) {
      const arguments_ = type.aliasTypeArguments
        ?? (type.flags & ts.TypeFlags.Object && (type as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference
          ? checker.getTypeArguments(type as ts.TypeReference) : []);
      const inner = arguments_[0] ? project(arguments_[0]) : f.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);
      return refObjectType(inner);
    }
    if (REACT_ATTR_TYPES.has(typeName)) return recordStringUnknown();
    return undefined;
  }

  function reactImportedType(typeName: string, arguments_: readonly ts.TypeNode[] | undefined,
    reference: ts.Symbol | undefined, sourceFileName: string, child: (node: ts.TypeNode) => ts.TypeNode): ts.TypeNode | undefined {
    if (sourceFileName.endsWith('unsupported.tsx') || !isImportedFromReactOrUnresolved(reference)) return undefined;
    if(!reactInferenceEnabled&&(DOM_ELEMENT_AND_EVENT_TYPES.has(typeName)||REACT_EVENT_TYPES.has(typeName)
      ||REACT_NODE_TYPES.has(typeName)||REACT_REF_TYPES.has(typeName)||REACT_ATTR_TYPES.has(typeName)||typeName==='CSSProperties'))return undefined;
    const state = reactStateType(typeName, arguments_, child);
    if (state) return state;
    if (DOM_ELEMENT_AND_EVENT_TYPES.has(typeName) || REACT_EVENT_TYPES.has(typeName) || REACT_NODE_TYPES.has(typeName)) {
      return f.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);
    }
    if (typeName === 'CSSProperties') return recordStringUnknown();
    if (REACT_REF_TYPES.has(typeName)) {
      const inner = arguments_?.[0] ? child(arguments_[0]) : f.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);
      return refObjectType(inner);
    }
    if (REACT_ATTR_TYPES.has(typeName)) {
      const first = arguments_?.[0];
      if (!first || !ts.isTypeQueryNode(first)) return recordStringUnknown();
    }
    return undefined;
  }

  function isReactNamespaceIdentifier(node: ts.EntityName): boolean {
    if (!ts.isIdentifier(node)) return false;
    const sym = checker.getSymbolAtLocation(node);
    if (!sym || !sym.declarations?.length) {
      return node.text === 'React';
    }
    for (const decl of sym.declarations) {
      if (ts.isImportClause(decl) || ts.isNamespaceImport(decl) || ts.isImportSpecifier(decl)) {
        const importDecl = ts.findAncestor(decl, ts.isImportDeclaration);
        if (importDecl && ts.isStringLiteral(importDecl.moduleSpecifier)) {
          const spec = importDecl.moduleSpecifier.text;
          if (spec === 'react' || spec.startsWith('react/')) return true;
        }
        return false;
      }
      if (decl.getSourceFile().isDeclarationFile && node.text === 'React') {
        return true;
      }
    }
    return false;
  }

  function isImportedFromReactOrUnresolved(sym: ts.Symbol | undefined): boolean {
    if (!sym || !sym.declarations?.length) return true;
    for (const decl of sym.declarations) {
      if (ts.isImportSpecifier(decl) || ts.isImportClause(decl) || ts.isNamespaceImport(decl)) {
        const importDecl = ts.findAncestor(decl, ts.isImportDeclaration);
        if (importDecl && ts.isStringLiteral(importDecl.moduleSpecifier)) {
          const spec = importDecl.moduleSpecifier.text;
          return spec === 'react' || spec.startsWith('react/');
        }
        return false;
      }
      if (!decl.getSourceFile().isDeclarationFile) {
        return false;
      }
    }
    return true;
  }

  function infer(type: ts.Type): ts.TypeNode {
    if(type.flags&ts.TypeFlags.Null)return data(f.createLiteralTypeNode(f.createNull()));
    const react=reactInference(type,value=>queriedType(value));
    if(react)return native(react);
    if(type.flags&ts.TypeFlags.Object){
      const mapped=inferredOverride?.(type,value=>queriedType(value));
      if(mapped)return native(mapped);
    }
    if(opaqueInferences&&isJsFile&&type.flags&(ts.TypeFlags.Any|ts.TypeFlags.Unknown))return f.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);
    if(opaqueInferences&&type.flags&ts.TypeFlags.ESSymbolLike)return f.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);
    if(opaqueInferences&&type.flags&ts.TypeFlags.Object)return queriedType(type);
    if (type.isUnion()) return f.createUnionTypeNode(type.types.map(infer));
    if (type.flags & ts.TypeFlags.StringLiteral) return f.createLiteralTypeNode(f.createStringLiteral((type as ts.StringLiteralType).value));
    if (type.flags & ts.TypeFlags.NumberLiteral) {
      const value = (type as ts.NumberLiteralType).value;
      return f.createLiteralTypeNode(value < 0 ? f.createPrefixUnaryExpression(ts.SyntaxKind.MinusToken, f.createNumericLiteral(-value)) : f.createNumericLiteral(value));
    }
    if (type.flags & ts.TypeFlags.BooleanLiteral) return f.createLiteralTypeNode(checker.typeToString(type) === 'true' ? f.createTrue() : f.createFalse());
    for (const [flag, kind] of [[ts.TypeFlags.String, ts.SyntaxKind.StringKeyword], [ts.TypeFlags.Number, ts.SyntaxKind.NumberKeyword],
      [ts.TypeFlags.Boolean, ts.SyntaxKind.BooleanKeyword], [ts.TypeFlags.Undefined, ts.SyntaxKind.UndefinedKeyword],
      [ts.TypeFlags.Null, ts.SyntaxKind.UndefinedKeyword],
      [ts.TypeFlags.Void, ts.SyntaxKind.VoidKeyword], [ts.TypeFlags.Never, ts.SyntaxKind.NeverKeyword],
      [ts.TypeFlags.NonPrimitive,ts.SyntaxKind.ObjectKeyword]] as const) {
      if (type.flags & flag) return f.createKeywordTypeNode(kind);
    }
    throw new Error('Helper signatures need explicit portable data types; the inferred type is not portable.');
  }

  const name = (value: ts.PropertyName): ts.PropertyName => {
    if (ts.isIdentifier(value)) return f.createIdentifier(value.text);
    if (ts.isStringLiteral(value)) return f.createStringLiteral(value.text);
    if (ts.isNumericLiteral(value)) return f.createNumericLiteral(value.text);
    throw new Error('Computed helper type members need a platform type binding.');
  };

  const propertyKey = (value: ts.PropertyName): string => {
    if (ts.isIdentifier(value) || ts.isStringLiteral(value)) return `string:${value.text}`;
    if (ts.isNumericLiteral(value)) return `number:${Number(value.text)}`;
    throw new Error('Utility type properties need ordinary string or number keys.');
  };
  function objectProperties(type: ts.TypeNode): ts.PropertySignature[] {
    if (ts.isParenthesizedTypeNode(type)) return objectProperties(type.type);
    const members = ts.isIntersectionTypeNode(type) ? type.types.flatMap(objectProperties)
      : ts.isTypeLiteralNode(type) ? [...type.members] : undefined;
    if (!members || members.some(member => !ts.isPropertySignature(member)))
      throw new Error('Utility types require a projected ordinary object type.');
    const properties = members as ts.PropertySignature[];
    if (new Set(properties.map(member => propertyKey(member.name))).size !== properties.length)
      throw new Error('Overlapping utility type properties need a checked platform type binding.');
    return properties;
  }
  function literalKeys(type: ts.TypeNode): Set<string> {
    if (type.kind === ts.SyntaxKind.NeverKeyword) return new Set();
    if (ts.isParenthesizedTypeNode(type)) return literalKeys(type.type);
    if (ts.isUnionTypeNode(type)) return new Set(type.types.flatMap(member => [...literalKeys(member)]));
    if (ts.isLiteralTypeNode(type)) {
      if (ts.isStringLiteral(type.literal)) return new Set([`string:${type.literal.text}`]);
      if (ts.isNumericLiteral(type.literal)) return new Set([`number:${Number(type.literal.text)}`]);
    }
    throw new Error('Pick/Omit utility keys require a string or number literal union.');
  }
  function withoutUndefined(type: ts.TypeNode): ts.TypeNode {
    if (ts.isParenthesizedTypeNode(type)) return withoutUndefined(type.type);
    if (type.kind === ts.SyntaxKind.UndefinedKeyword) return f.createKeywordTypeNode(ts.SyntaxKind.NeverKeyword);
    if (!ts.isUnionTypeNode(type)) return type;
    const members = type.types.map(withoutUndefined).flatMap(member => ts.isUnionTypeNode(member) ? [...member.types] : [member])
      .filter(member => member.kind !== ts.SyntaxKind.NeverKeyword);
    return members.length === 0 ? f.createKeywordTypeNode(ts.SyntaxKind.NeverKeyword)
      : members.length === 1 ? members[0]! : f.createUnionTypeNode(members);
  }
  const nativeSymbols=new Map<ts.Symbol,boolean>();
  function builtin(reference: ts.Symbol | undefined,active=new Set<ts.Symbol>()): boolean {
    const authentic=standardLibraryFile??nativeLibrary;
    if(!reference?.declarations?.length||!reference.declarations.every(declaration=>authentic(declaration.getSourceFile())))return false;
    const known=nativeSymbols.get(reference);if(known!==undefined)return known;
    if(active.has(reference))return true;
    const nested=new Set([...active,reference]);let valid=true;
    const inspect=(node:ts.Node)=>{
      if(ts.isTypeReferenceNode(node)&&!builtin(checker.getSymbolAtLocation(node.typeName),nested))valid=false;
      ts.forEachChild(node,inspect);
    };
    for(const declaration of reference.declarations)if(ts.isTypeAliasDeclaration(declaration))inspect(declaration.type);
    nativeSymbols.set(reference,valid);return valid;
  }
  const unalias=(symbol:ts.Symbol)=>symbol.flags&ts.SymbolFlags.Alias?checker.getAliasedSymbol(symbol):symbol;
  function constQueryOwner(node:ts.TypeQueryNode):ts.VariableDeclaration|undefined {
    let root=node.exprName;while(ts.isQualifiedName(root))root=root.left;
    const reference=checker.getSymbolAtLocation(root),symbol=reference&&unalias(reference);
    let declaration=symbol?.valueDeclaration;
    if(declaration&&ts.isSourceFile(declaration)&&ts.isQualifiedName(node.exprName)){
      const selected=checker.getSymbolAtLocation(node.exprName);declaration=selected&&unalias(selected).valueDeclaration;
    }
    return declaration&&ts.isVariableDeclaration(declaration)&&!declaration.getSourceFile().isDeclarationFile
      &&ts.isVariableDeclarationList(declaration.parent)&&declaration.parent.flags&ts.NodeFlags.Const?declaration:undefined;
  }
  function checkedTypeSyntax(node:ts.Node,seen=new Set<ts.Symbol>()):boolean {
    const symbol=(value:ts.Symbol|undefined):boolean=>{
      if(!value?.declarations?.length)return false;
      if(seen.has(value))return true;seen.add(value);
      if(builtin(value))return true;
      if(value.declarations.some(declaration=>nativeLibrary(declaration.getSourceFile())))
        throw new Error('Native utility dependencies are unresolved or conflict with source declarations.');
      for(const declaration of value.declarations)if(declaration.getSourceFile().isDeclarationFile&&!trustedDeclaration?.(declaration.getSourceFile()))
        throw new Error('Untrusted declarations participate in this helper type; supply a checked platform type binding.');
      if(value.flags&ts.SymbolFlags.Alias)return symbol(checker.getAliasedSymbol(value));
      return value.declarations.every(declaration=>{
        if(ts.isTypeAliasDeclaration(declaration))return checkedTypeSyntax(declaration.type,seen);
        if(ts.isInterfaceDeclaration(declaration))return [...declaration.members,...declaration.heritageClauses??[]].every(node=>checkedTypeSyntax(node,seen));
        if(ts.isClassDeclaration(declaration))return [...declaration.heritageClauses??[],...declaration.members].every(member=>{
          if(ts.isPropertyDeclaration(member))return (!member.type||checkedTypeSyntax(member.type,seen))&&(!member.initializer||checkedValueExpression(member.initializer));
          return checkedTypeSyntax(member,seen);
        });
        if(ts.isTypeParameterDeclaration(declaration))return (!declaration.constraint||checkedTypeSyntax(declaration.constraint,seen))&&(!declaration.default||checkedTypeSyntax(declaration.default,seen));
        if(ts.isVariableDeclaration(declaration))return !declaration.type||checkedTypeSyntax(declaration.type,seen);
        if(ts.isFunctionLike(declaration))return [...declaration.typeParameters??[],...declaration.parameters.map(parameter=>parameter.type).filter((type):type is ts.TypeNode=>!!type),
          ...('type'in declaration&&declaration.type?[declaration.type as ts.TypeNode]:[])].every(type=>checkedTypeSyntax(type,seen));
        return true;
      });
    };
    if(ts.isTypeReferenceNode(node))return symbol(checker.getSymbolAtLocation(node.typeName))
      &&(node.typeArguments??[]).every(argument=>checkedTypeSyntax(argument,seen));
    if(ts.isExpressionWithTypeArguments(node))return symbol(checker.getSymbolAtLocation(node.expression))
      &&(node.typeArguments??[]).every(argument=>checkedTypeSyntax(argument,seen));
    if(ts.isTypeQueryNode(node)){
      let root=node.exprName;while(ts.isQualifiedName(root))root=root.left;
      return symbol(checker.getSymbolAtLocation(root))&&(node.typeArguments??[]).every(argument=>checkedTypeSyntax(argument,seen));
    }
    if(ts.isImportTypeNode(node)){
      const target=node.qualifier&&checker.getSymbolAtLocation(node.qualifier);
      if(!target||!symbol(target))return false;
    }
    let valid=true;ts.forEachChild(node,child=>{if(!checkedTypeSyntax(child,seen))valid=false;});return valid;
  }
  function checkedTypeGraph(type:ts.Type,seen=new Set<ts.Type>()):boolean {
    if(seen.has(type))return true;seen.add(type);
    for(const symbol of [type.aliasSymbol,type.getSymbol()])if(symbol?.declarations?.length&&!builtin(symbol))
      for(const declaration of symbol.declarations){
        if(declaration.getSourceFile().isDeclarationFile&&!trustedDeclaration?.(declaration.getSourceFile()))
          throw new Error('Untrusted declarations participate in this helper type; supply a checked platform type binding.');
        if(ts.isTypeAliasDeclaration(declaration)&&!checkedTypeSyntax(declaration.type))return false;
      }
    if(type.isUnionOrIntersection())return type.types.every(member=>checkedTypeGraph(member,seen));
    if(type.flags&ts.TypeFlags.Object){
      const symbol=type.getSymbol();
      if((type as ts.ObjectType).objectFlags&ts.ObjectFlags.Reference)
        if(!checker.getTypeArguments(type as ts.TypeReference).every(argument=>checkedTypeGraph(argument,seen)))return false;
      if(symbol&&builtin(symbol))return true;
      for(const signature of [...type.getCallSignatures(),...type.getConstructSignatures()]){
        const declaration=signature.declaration;
        if(declaration&&(!checkedTypeSyntax(declaration)||declaration.getSourceFile().isDeclarationFile&&!nativeLibrary(declaration.getSourceFile())&&!trustedDeclaration?.(declaration.getSourceFile())))
          throw new Error('Untrusted callable declarations participate in this helper type.');
        if(!signature.parameters.every(parameter=>checkedTypeGraph(checker.getTypeOfSymbol(parameter),seen))
          ||!checkedTypeGraph(checker.getReturnTypeOfSignature(signature),seen))return false;
      }
      if(!checker.getPropertiesOfType(type).every(property=>{
        for(const declaration of property.declarations??[]){
          const file=declaration.getSourceFile();
          if(file.isDeclarationFile&&!nativeLibrary(file)&&!trustedDeclaration?.(file))
            throw new Error('Untrusted property declarations participate in this helper query.');
        }
        return checkedTypeGraph(checker.getTypeOfSymbol(property),seen);
      }))return false;
      if(!checker.getIndexInfosOfType(type).every(info=>checkedTypeGraph(info.type,seen)))return false;
    }
    return true;
  }
  function checkedValueExpression(node:ts.Node,seen=new Set<ts.Symbol>()):boolean {
    if(ts.isTypeNode(node))return checkedTypeSyntax(node);
    if(ts.isIdentifier(node)){
      const reference=checker.getSymbolAtLocation(node);if(!reference?.declarations?.length)return false;
      const symbol=unalias(reference);if(seen.has(symbol))return true;seen.add(symbol);
      for(const declaration of [...reference.declarations,...symbol.declarations??[]]){
        const file=declaration.getSourceFile();
        if(file.isDeclarationFile&&!nativeLibrary(file)&&!trustedDeclaration?.(file))
          throw new Error('Untrusted value declarations participate in this helper query.');
        if(ts.isVariableDeclaration(declaration)){
          if(declaration.type&&!checkedTypeSyntax(declaration.type))return false;
          if(declaration.initializer&&!checkedValueExpression(declaration.initializer,seen))return false;
        }else if(ts.isFunctionLike(declaration)){
          if(!checkedTypeSyntax(declaration))return false;
          if('body'in declaration&&declaration.body&&!checkedValueExpression(declaration.body,seen))return false;
        }else if(ts.isPropertyAssignment(declaration)&&!checkedValueExpression(declaration.initializer,seen))return false;
      }
      return true;
    }
    let valid=true;ts.forEachChild(node,child=>{if(!checkedValueExpression(child,seen))valid=false;});return valid;
  }
  function finiteQueryResult(type:ts.Type,active=new Set<ts.Type>(),parameters=new Set<ts.Symbol>()):boolean {
    if(active.has(type)||type.flags&(ts.TypeFlags.Any|ts.TypeFlags.Unknown))return false;
    if(type.flags&ts.TypeFlags.TypeParameter)return !!type.getSymbol()&&parameters.has(type.getSymbol()!);
    const nested=new Set([...active,type]),child=(type:ts.Type)=>finiteQueryResult(type,nested,parameters);
    if(type.isUnionOrIntersection())return type.types.every(child);
    if(type.flags&ts.TypeFlags.Object){
      if(type.getSymbol()?.declarations?.some(ts.isClassDeclaration)||type.getConstructSignatures().length||checker.getIndexInfosOfType(type).length)return false;
      if(checker.isTupleType(type)||checker.isArrayType(type))
        return builtin(type.aliasSymbol??type.getSymbol())&&checker.getTypeArguments(type as ts.TypeReference).every(child);
      for(const signature of type.getCallSignatures()){
        const scoped=new Set([...parameters,...signature.typeParameters?.map(parameter=>parameter.symbol)??[]]);
        if(!signature.parameters.every(parameter=>finiteQueryResult(checker.getTypeOfSymbol(parameter),nested,scoped))
          ||!finiteQueryResult(checker.getReturnTypeOfSignature(signature),nested,scoped))return false;
      }
      return checker.getPropertiesOfType(type).every(property=>finiteQueryResult(checker.getTypeOfSymbol(property),nested,parameters));
    }
    return !!(type.flags&(ts.TypeFlags.StringLike|ts.TypeFlags.NumberLike|ts.TypeFlags.BooleanLike|ts.TypeFlags.Null|ts.TypeFlags.Undefined|ts.TypeFlags.Never|ts.TypeFlags.Void));
  }
  function materializedQueryAlias(node:ts.TypeReferenceNode,substitutions:Map<ts.Symbol,ts.TypeNode>,active:Set<ts.Node>):ts.TypeNode|undefined {
    const queries:ts.TypeQueryNode[]=[];let concrete=true,nativeBound=false;
    const inspect=(current:ts.Node)=>{
      if(ts.isTypeQueryNode(current)){
        if(!constQueryOwner(current)||!checker.getTypeFromTypeNode(current).getCallSignatures().length)concrete=false;
        else queries.push(current);
        if(override?.(current,type=>data(type,substitutions,new Set(active))))nativeBound=true;
        const owner=constQueryOwner(current);
        const annotations=(node:ts.Node)=>{
          // Null's native representation is reapplied by queriedType itself;
          // opaque/native object contracts must retain their original path.
          if(ts.isTypeNode(node)&&!(ts.isLiteralTypeNode(node)&&node.literal.kind===ts.SyntaxKind.NullKeyword)&&override?.(node))nativeBound=true;
          ts.forEachChild(node,annotations);
        };
        if(owner?.type)annotations(owner.type);
        if(owner?.initializer)annotations(owner.initializer);
      }
      if(ts.isTypeReferenceNode(current)&&checker.getTypeFromTypeNode(current).flags&ts.TypeFlags.TypeParameter)concrete=false;
      ts.forEachChild(current,inspect);
    };
    for(const argument of node.typeArguments??[])inspect(argument);
    if(!queries.length||!concrete||nativeBound)return undefined;
    if(!checkedTypeSyntax(node)||!queries.every(query=>{
      const owner=constQueryOwner(query)!;
      return (!owner.initializer||checkedValueExpression(owner.initializer))&&checkedTypeGraph(checker.getTypeFromTypeNode(query));
    }))return undefined;
    const reference=checker.getSymbolAtLocation(node.typeName),symbol=reference&&unalias(reference);
    const alias=symbol?.declarations?.find(ts.isTypeAliasDeclaration);
    if(!alias)return undefined;
    for(const [index,parameter]of (alias.typeParameters??[]).entries())if(parameter.constraint){
      const value=node.typeArguments?.[index]??parameter.default;
      if(!value||!checker.isTypeAssignableTo(checker.getTypeFromTypeNode(value),checker.getTypeFromTypeNode(parameter.constraint)))return undefined;
    }
    const result=checker.getTypeFromTypeNode(node);
    return finiteQueryResult(result)?queriedType(result):undefined;
  }

  function queriedType(type: ts.Type, seen = new Set<ts.Type>(), scopedParameters = new Map<ts.Symbol, string>()): ts.TypeNode {
    if (seen.has(type)) throw new Error('Recursive const type queries need a checked platform type binding.');
    const nested = new Set([...seen, type]);
    const child = (value: ts.Type) => queriedType(value, nested, scopedParameters);
    const explicit=checkedNativeTypes.get(type);if(explicit)return native(explicit);
    const mapped=inferredOverride?.(type,child);
    if(mapped)return native(mapped);
    const react=reactInference(type,child);if(react)return native(react);
    if (type.isUnion()) return f.createUnionTypeNode(type.types.map(child));
    if(type.isIntersection())return f.createIntersectionTypeNode(type.types.map(child));
    if (type.flags & ts.TypeFlags.Null) return data(f.createLiteralTypeNode(f.createNull()));
    if (type.flags & ts.TypeFlags.TypeParameter) {
      const scoped = type.getSymbol() && scopedParameters.get(type.getSymbol()!);
      if (scoped) return f.createTypeReferenceNode(scoped);
      const parameter = typeParameters.find(parameter => checker.getSymbolAtLocation(parameter.name) === type.getSymbol());
      if (parameter) return f.createTypeReferenceNode(parameter.name.text);
    }
    if (checker.isTupleType(type)) {
      if(!builtin(type.aliasSymbol??type.getSymbol()))throw new Error('Tuple types require an authentic standard-library Array declaration.');
      const target = (type as ts.TypeReference).target as ts.TupleType;
      const tuple = f.createTupleTypeNode(checker.getTypeArguments(type as ts.TypeReference).map((element, index) => {
        const projected = child(element);
        const flag = target.elementFlags[index]!;
        if (flag & ts.ElementFlags.Optional) return f.createOptionalTypeNode(projected);
        if (flag & ts.ElementFlags.Rest) return f.createRestTypeNode(f.createArrayTypeNode(projected));
        return projected;
      }));
      return target.readonly ? f.createTypeOperatorNode(ts.SyntaxKind.ReadonlyKeyword, tuple) : tuple;
    }
    if (checker.isArrayType(type)) {
      if(!builtin(type.aliasSymbol??type.getSymbol()))throw new Error('Array types require an authentic standard-library declaration.');
      const array = f.createArrayTypeNode(child(checker.getTypeArguments(type as ts.TypeReference)[0]!));
      return type.getSymbol()?.getName() === 'ReadonlyArray' ? f.createTypeOperatorNode(ts.SyntaxKind.ReadonlyKeyword, array) : array;
    }
    if (type.flags & ts.TypeFlags.Object) {
      if (type.getConstructSignatures().length)
        throw new Error('Const type queries require ordinary data properties or checked call signatures, not constructors.');
      if(type.getSymbol()?.declarations?.some(declaration=>ts.isClassDeclaration(declaration)||ts.isClassExpression(declaration)))
        throw new Error('Class instance queries need an exact native constructor type binding.');
      const indices=checker.getIndexInfosOfType(type);
      if(indices.length&&type.getSymbol()?.declarations?.some(declaration=>ts.isInterfaceDeclaration(declaration)&&nativeLibrary(declaration.getSourceFile())))
        throw new Error('Native indexed collection queries need an exact platform type binding.');
      const indexSignatures=indices.map(info=>{
        if(!(info.keyType.flags&(ts.TypeFlags.String|ts.TypeFlags.Number)))
          throw new Error('Helper index signature keys require an exact string or number type.');
        return f.createIndexSignature(info.isReadonly?[f.createModifier(ts.SyntaxKind.ReadonlyKeyword)]:undefined,
          [f.createParameterDeclaration(undefined,undefined,'key',undefined,child(info.keyType))],child(info.type));
      });
      const calls = type.getCallSignatures().map(signature => {
        const parameters = new Map(scopedParameters);
        for (const parameter of signature.typeParameters ?? []) parameters.set(parameter.symbol, parameter.symbol.name);
        const substitutions=new Map([...parameters].map(([symbol,name])=>[symbol,f.createTypeReferenceNode(name)]));
        const annotations=(node:ts.Node):boolean=>{
          let found=false;
          if(ts.isTypeNode(node)){
            containInferredAnnotation(node);
            const replacement=override?.(node,type=>data(type,substitutions));
            if(replacement){
              found=true;const type=checker.getTypeFromTypeNode(node);
              if(type.flags&(ts.TypeFlags.Object|ts.TypeFlags.Intersection))checkedNativeTypes.set(type,replacement);
            }
          }
          ts.forEachChild(node,child=>{if(annotations(child))found=true;});return found;
        };
        if(signature.declaration){
          for(const parameter of signature.declaration.parameters)if(ts.isParameter(parameter)&&parameter.type)annotations(parameter.type);
          if(signature.declaration.type)annotations(signature.declaration.type);
          if('body'in signature.declaration&&signature.declaration.body)annotations(signature.declaration.body);
        }
        const callableChild = (value: ts.Type) => queriedType(value, nested, parameters);
        const annotationType=(node:ts.TypeNode|undefined,type:ts.Type)=>{
          if(!node)return callableChild(type);
          // These annotations describe a signature selected by checked result
          // inference. Preserve its native identities while treating erased
          // JS's inferred any arguments like the same inferred checker type.
          containInferredAnnotation(node);
          return annotations(node)?data(node,substitutions):callableChild(type);
        };
        const generics = signature.typeParameters?.map(parameter => {
          const constraint = checker.getBaseConstraintOfType(parameter);
          const declaration = parameter.symbol.declarations?.find(ts.isTypeParameterDeclaration);
          return f.createTypeParameterDeclaration(undefined, parameter.symbol.name, constraint && callableChild(constraint),
            declaration?.default && callableChild(checker.getTypeFromTypeNode(declaration.default)));
        });
        const receiver=signature.thisParameter;
        const declaration=signature.declaration;
        const dynamicReceiver=declaration&&ts.isFunctionLike(declaration)&&createCallProof(checker).dynamicThis(declaration);
        const receiverType=receiver?callableChild(checker.getTypeOfSymbolAtLocation(receiver,
          receiver.valueDeclaration??receiver.declarations?.[0]??declaration!))
          :dynamicReceiver?f.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword):undefined;
        return f.createFunctionTypeNode(generics, [...(receiverType?[f.createParameterDeclaration(undefined,undefined,'this',undefined,receiverType)]:[]),...signature.parameters.map((parameter, index) => {
          const declaration = parameter.valueDeclaration ?? parameter.declarations?.[0];
          if (!declaration || !ts.isParameter(declaration)) throw new Error('Const callable queries require checked parameter declarations.');
          const trailing=signature.parameters.slice(index+1).every(parameter=>{
            const node=parameter.valueDeclaration??parameter.declarations?.[0];
            return node&&ts.isParameter(node)&&!!(node.dotDotDotToken||node.questionToken||node.initializer);
          });
          const optional=!!(parameter.flags&ts.SymbolFlags.Optional||declaration.questionToken||declaration.initializer&&trailing);
          let type=annotationType(declaration.type,checker.getTypeOfSymbolAtLocation(parameter,declaration));
          if(declaration.initializer&&!optional)type=f.createUnionTypeNode([type,f.createKeywordTypeNode(ts.SyntaxKind.UndefinedKeyword)]);
          return f.createParameterDeclaration(undefined, declaration.dotDotDotToken && f.createToken(ts.SyntaxKind.DotDotDotToken),
            ts.isIdentifier(declaration.name) ? declaration.name.text : `arg${index}`,
            optional ? f.createToken(ts.SyntaxKind.QuestionToken) : undefined,type);
        })], annotationType(signature.declaration?.type&&ts.isTypeNode(signature.declaration.type)?signature.declaration.type:undefined,
          checker.getReturnTypeOfSignature(signature)));
      });
      const shape = checker.typeToTypeNode(type, undefined, ts.NodeBuilderFlags.NoTruncation | ts.NodeBuilderFlags.InTypeAlias);
      const shaped = shape && ts.isTypeLiteralNode(shape) ? shape.members.filter(ts.isPropertySignature) : [];
      const properties = f.createTypeLiteralNode([...indexSignatures,...checker.getPropertiesOfType(type).map(property => {
        const declaration = property.valueDeclaration ?? property.declarations?.[0];
        const member = shaped.find(member => (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name) || ts.isNumericLiteral(member.name))
          && member.name.text === property.getName());
        // Instantiated mapped types and inferred contextual objects can have
        // transient property symbols without declaration nodes. Their checked
        // ordinary property signatures still provide the key and modifiers.
        if (property.getName().startsWith('__@') || !declaration && (!member || !(property.flags & ts.SymbolFlags.Property)))
          throw new Error(`Const type query keys need ordinary data properties. Type: ${type.getSymbol()?.name??'<anonymous>'}; key: ${property.getName()}.`);
        const readonly = member?.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ReadonlyKeyword)
          || !!(declaration && ts.getCombinedModifierFlags(declaration) & ts.ModifierFlags.Readonly);
        return f.createPropertySignature(readonly ? [f.createModifier(ts.SyntaxKind.ReadonlyKeyword)] : undefined,
          member ? name(member.name) : f.createStringLiteral(property.getName()),
          property.flags & ts.SymbolFlags.Optional ? f.createToken(ts.SyntaxKind.QuestionToken) : undefined,
          child(checker.getTypeOfSymbol(property)));
      })]);
      const parts:ts.TypeNode[] = [...calls, ...(properties.members.length || !calls.length ? [properties] : [])];
      return parts.length === 1 ? parts[0]! : f.createIntersectionTypeNode(parts);
    }
    return infer(type);
  }

  // This small proof handles substituted finite constraints (for example
  // K extends keyof T). The source checker remains the authority otherwise.
  function finiteConstraint(value: ts.TypeNode, constraint: ts.TypeNode): boolean {
    if (ts.isParenthesizedTypeNode(value)) return finiteConstraint(value.type, constraint);
    if (ts.isParenthesizedTypeNode(constraint)) return finiteConstraint(value, constraint.type);
    if (constraint.kind === ts.SyntaxKind.UnknownKeyword || value.kind === ts.SyntaxKind.NeverKeyword) return true;
    if (ts.isUnionTypeNode(value)) return value.types.every(member => finiteConstraint(member, constraint));
    if (ts.isUnionTypeNode(constraint)) return constraint.types.some(member => finiteConstraint(value, member));
    if (ts.isIntersectionTypeNode(constraint)) return constraint.types.every(member => finiteConstraint(value, member));
    if (ts.isLiteralTypeNode(value)) {
      const literal = value.literal;
      if (ts.isLiteralTypeNode(constraint)) {
        const target = constraint.literal;
        if (ts.isStringLiteral(literal) && ts.isStringLiteral(target)) return literal.text === target.text;
        const number = (node: ts.LiteralTypeNode['literal']) => ts.isNumericLiteral(node) ? Number(node.text)
          : ts.isPrefixUnaryExpression(node) && ts.isNumericLiteral(node.operand) ? (node.operator === ts.SyntaxKind.MinusToken ? -1 : 1) * Number(node.operand.text) : undefined;
        const sourceNumber = number(literal), targetNumber = number(target);
        if (sourceNumber !== undefined || targetNumber !== undefined) return sourceNumber === targetNumber;
        return literal.kind === target.kind;
      }
      return ts.isStringLiteral(literal) && constraint.kind === ts.SyntaxKind.StringKeyword
        || (ts.isNumericLiteral(literal) || ts.isPrefixUnaryExpression(literal)) && constraint.kind === ts.SyntaxKind.NumberKeyword
        || (literal.kind === ts.SyntaxKind.TrueKeyword || literal.kind === ts.SyntaxKind.FalseKeyword) && constraint.kind === ts.SyntaxKind.BooleanKeyword;
    }
    return value.kind === constraint.kind && [ts.SyntaxKind.StringKeyword, ts.SyntaxKind.NumberKeyword, ts.SyntaxKind.BooleanKeyword,
      ts.SyntaxKind.UndefinedKeyword, ts.SyntaxKind.ObjectKeyword, ts.SyntaxKind.VoidKeyword].includes(value.kind);
  }

  function declarationsFor(symbol: ts.Symbol | undefined) {
    const all = symbol?.declarations ?? [];
    const accepted = all.filter(declaration => !declaration.getSourceFile().isDeclarationFile || trustedDeclaration?.(declaration.getSourceFile()));
    // Never project only part of a declaration merge when trust is explicit.
    if (trustedDeclaration && accepted.some(declaration => ts.isTypeAliasDeclaration(declaration) || ts.isInterfaceDeclaration(declaration))
      && all.some(declaration => (ts.isTypeAliasDeclaration(declaration) || ts.isInterfaceDeclaration(declaration)) && !accepted.includes(declaration)))
      throw new Error('Untrusted declarations participate in this helper type; supply a checked platform type binding.');
    return accepted;
  }
  function declaredType(node: ts.TypeReferenceNode, symbol: ts.Symbol | undefined,
    substitutions: Map<ts.Symbol, ts.TypeNode>, active: Set<ts.Node>): ts.TypeNode | undefined {
    const declarations = declarationsFor(symbol);
    const interfaces = declarations.filter(ts.isInterfaceDeclaration);
    if (interfaces.length > 1) throw new Error('Merged helper interfaces need a checked platform type binding.');
    const alias = declarations.find(ts.isTypeAliasDeclaration) ?? interfaces[0];
    if (!alias) return undefined;
    if (active.has(alias)) throw new Error('Recursive helper types need a platform type binding.');
    const next = new Map(substitutions);
    const nested = new Set([...active, alias]);
    const child = (value: ts.TypeNode) => data(value, substitutions, new Set(active));
    if ((node.typeArguments?.length ?? 0) > (alias.typeParameters?.length ?? 0)) throw new Error('Too many helper type arguments.');
    for (const [i, parameter] of (alias.typeParameters ?? []).entries()) {
      const value = node.typeArguments?.[i];
      const resolved = value ? child(value) : parameter.default ? data(parameter.default, next, new Set(nested)) : undefined;
      if (!resolved) throw new Error('Helper type arguments cannot be inferred across an alias.');
      if (parameter.constraint) {
        const argument = value ?? parameter.default!;
        if(!checkedTypeSyntax(parameter.constraint))throw new Error('Helper type constraints need checked declarations.');
        if (!checker.isTypeAssignableTo(checker.getTypeFromTypeNode(argument), checker.getTypeFromTypeNode(parameter.constraint))
          && !finiteConstraint(resolved, data(parameter.constraint,next,new Set(nested)))) throw new Error('Helper type arguments must satisfy their projected constraints.');
      }
      next.set(checker.getSymbolAtLocation(parameter.name)!, resolved);
    }
    const body = ts.isTypeAliasDeclaration(alias) ? alias.type : f.createTypeLiteralNode(alias.members);
    const own = data(body, next, nested);
    if (ts.isInterfaceDeclaration(alias) && alias.heritageClauses?.length) {
      const entity = (expression: ts.Expression): ts.EntityName => {
        if (ts.isIdentifier(expression)) return expression;
        if (trustedDeclaration && ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.name)) return f.createQualifiedName(entity(expression.expression), expression.name);
        throw new Error('Qualified helper interface bases need a platform type binding.');
      };
      const inherited = alias.heritageClauses.flatMap(clause => clause.types.map(base => {
        const type = f.createTypeReferenceNode(entity(base.expression), base.typeArguments);
        if (ts.isIdentifier(base.expression)) return data(type, next, new Set(nested));
        const reference = checker.getSymbolAtLocation(base.expression);
        const target = reference && reference.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(reference) : reference;
        const projected = declaredType(type, target, next, new Set(nested));
        if (!projected) throw new Error('Qualified helper interface bases need a checked source declaration.');
        return projected;
      }));
      return f.createIntersectionTypeNode([...inherited, own]);
    }
    return own;
  }

  function data(node: ts.TypeNode, substitutions = new Map<ts.Symbol, ts.TypeNode>(), active = new Set<ts.Node>()): ts.TypeNode {
    const child = (value: ts.TypeNode) => data(value, substitutions, new Set(active));
    const replacement = override?.(node,child);
    if (replacement) return native(replacement);
    if(opaqueInferredAnnotations.has(node))return f.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);
    switch (node.kind) {
      case ts.SyntaxKind.StringKeyword: return f.createKeywordTypeNode(ts.SyntaxKind.StringKeyword);
      case ts.SyntaxKind.NumberKeyword: return f.createKeywordTypeNode(ts.SyntaxKind.NumberKeyword);
      case ts.SyntaxKind.BooleanKeyword: return f.createKeywordTypeNode(ts.SyntaxKind.BooleanKeyword);
      case ts.SyntaxKind.UndefinedKeyword: return f.createKeywordTypeNode(ts.SyntaxKind.UndefinedKeyword);
      case ts.SyntaxKind.NullKeyword: return f.createKeywordTypeNode(ts.SyntaxKind.UndefinedKeyword);
      case ts.SyntaxKind.VoidKeyword: return f.createKeywordTypeNode(ts.SyntaxKind.VoidKeyword);
      case ts.SyntaxKind.NeverKeyword: return f.createKeywordTypeNode(ts.SyntaxKind.NeverKeyword);
      case ts.SyntaxKind.UnknownKeyword: return f.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);
      case ts.SyntaxKind.ObjectKeyword: return f.createKeywordTypeNode(ts.SyntaxKind.ObjectKeyword);
    }
    if (ts.isParenthesizedTypeNode(node)) return f.createParenthesizedType(child(node.type));
    if(ts.isConditionalTypeNode(node)){
      const containsInfer=(current:ts.Node):boolean=>ts.isInferTypeNode(current)||!!ts.forEachChild(current,containsInfer);
      if(containsInfer(node.extendsType))throw new Error('Source conditional infer variables need a scoped native type binding.');
      const checked=checker.getTypeFromTypeNode(node.checkType);
      const parameter=checked.flags&ts.TypeFlags.TypeParameter?checked.getSymbol():undefined;
      if(parameter&&substitutions.has(parameter)){
        // Substituting a union directly would turn a distributive conditional
        // into one check of the whole union. A native scoped capture retains
        // TypeScript's distribution over the original naked type parameter.
        const names=new Set<string>();
        const scan=(current:ts.Node)=>{if(ts.isIdentifier(current))names.add(current.text);ts.forEachChild(current,scan);};
        scan(node);for(const value of substitutions.values())scan(value);
        let name='__ConditionalBranch';while(names.has(name))name+='_';
        const scoped=new Map(substitutions);scoped.set(parameter,f.createTypeReferenceNode(name));
        const branch=(type:ts.TypeNode)=>data(type,scoped,new Set(active));
        return f.createConditionalTypeNode(child(node.checkType),f.createInferTypeNode(f.createTypeParameterDeclaration(undefined,name)),
          f.createConditionalTypeNode(f.createTypeReferenceNode(name),branch(node.extendsType),branch(node.trueType),branch(node.falseType)),
          f.createKeywordTypeNode(ts.SyntaxKind.NeverKeyword));
      }
      return f.createConditionalTypeNode(child(node.checkType),child(node.extendsType),child(node.trueType),child(node.falseType));
    }
    if (ts.isTypePredicateNode(node)) return f.createTypePredicateNode(
      node.assertsModifier && f.createToken(ts.SyntaxKind.AssertsKeyword),
      node.parameterName.kind === ts.SyntaxKind.ThisType ? f.createThisTypeNode()
        : f.createIdentifier(node.parameterName.text), node.type && child(node.type));
    if (ts.isTypeQueryNode(node)) {
      if (node.typeArguments?.length) throw new Error('Instantiated callable type queries need a checked platform type binding.');
      let root = node.exprName;
      while (ts.isQualifiedName(root)) root = root.left;
      const reference = checker.getSymbolAtLocation(root);
      const symbol = reference && reference.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(reference) : reference;
      const declaration = symbol?.valueDeclaration;
      // A parameter query denotes its checked annotation, including callback
      // generics. It need not allocate or inspect a module-level data value.
      if (declaration && ts.isParameter(declaration) && declaration.type
        && (!declaration.getSourceFile().isDeclarationFile || trustedDeclaration?.(declaration.getSourceFile()))) {
        if (active.has(declaration)) throw new Error('Recursive parameter type queries need a checked platform type binding.');
        return data(declaration.type, substitutions, new Set([...active, declaration]));
      }
      const owner=constQueryOwner(node);
      if (!owner)
        throw new Error('Type queries require a source-owned const data value.');
      const type=checker.getTypeAtLocation(node.exprName);
      if(type.getCallSignatures().length&&(!checkedTypeGraph(type)||owner.initializer&&!checkedValueExpression(owner.initializer)))
        throw new Error('Callable type queries require checked source and declaration provenance.');
      return queriedType(type);
    }
    if (ts.isLiteralTypeNode(node)) {
      const value = node.literal;
      if (value.kind === ts.SyntaxKind.NullKeyword) return f.createKeywordTypeNode(ts.SyntaxKind.UndefinedKeyword);
      if (ts.isStringLiteral(value)) return f.createLiteralTypeNode(f.createStringLiteral(value.text));
      if (ts.isNumericLiteral(value)) return f.createLiteralTypeNode(f.createNumericLiteral(value.text));
      if (value.kind === ts.SyntaxKind.TrueKeyword || value.kind === ts.SyntaxKind.FalseKeyword) return f.createLiteralTypeNode(value.kind === ts.SyntaxKind.TrueKeyword ? f.createTrue() : f.createFalse());
      if (ts.isPrefixUnaryExpression(value) && ts.isNumericLiteral(value.operand)) return f.createLiteralTypeNode(f.createPrefixUnaryExpression(value.operator, f.createNumericLiteral(value.operand.text)));
    }
    if (ts.isUnionTypeNode(node)) return f.createUnionTypeNode(node.types.map(child));
    if (ts.isIntersectionTypeNode(node)) return f.createIntersectionTypeNode(node.types.map(child));
    if (ts.isArrayTypeNode(node)) return f.createArrayTypeNode(child(node.elementType));
    if (ts.isTupleTypeNode(node)) return f.createTupleTypeNode(node.elements.map(child));
    if (ts.isOptionalTypeNode(node)) return f.createOptionalTypeNode(child(node.type));
    if (ts.isRestTypeNode(node)) return f.createRestTypeNode(child(node.type));
    if (ts.isNamedTupleMember(node)) return f.createNamedTupleMember(node.dotDotDotToken && f.createToken(ts.SyntaxKind.DotDotDotToken),
      f.createIdentifier(node.name.text), node.questionToken && f.createToken(ts.SyntaxKind.QuestionToken), child(node.type));
    if (ts.isTypeOperatorNode(node)) {
      if (node.operator === ts.SyntaxKind.ReadonlyKeyword) return f.createTypeOperatorNode(node.operator, child(node.type));
      if (node.operator === ts.SyntaxKind.KeyOfKeyword) {
        // The key set can be checked independently of the values in a const
        // object, including component values supplied by platform bindings.
        if (ts.isTypeQueryNode(node.type)) {
          const checked = checker.getTypeFromTypeNode(node);
          const members = checked.isUnion() ? checked.types : [checked];
          if (members.length && members.every(type => type.isStringLiteral() || type.isNumberLiteral())) {
            const keys = members.map(type => f.createLiteralTypeNode(type.isStringLiteral()
              ? f.createStringLiteral(type.value) : f.createNumericLiteral((type as ts.NumberLiteralType).value)));
            return keys.length === 1 ? keys[0]! : f.createUnionTypeNode(keys);
          }
        }
        const resolvedTarget = child(node.type);
        if (ts.isTypeLiteralNode(resolvedTarget) || ts.isIntersectionTypeNode(resolvedTarget)) {
          const keys: ts.TypeNode[] = [];
          for (const member of objectProperties(resolvedTarget)) {
            if (ts.isPropertySignature(member)) {
              if (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name)) {
                keys.push(f.createLiteralTypeNode(f.createStringLiteral(member.name.text)));
              } else if (ts.isNumericLiteral(member.name)) {
                keys.push(f.createLiteralTypeNode(f.createNumericLiteral(member.name.text)));
              }
            }
          }
          return keys.length === 0
            ? f.createKeywordTypeNode(ts.SyntaxKind.NeverKeyword)
            : keys.length === 1 ? keys[0]! : f.createUnionTypeNode(keys);
        }
        return f.createTypeOperatorNode(ts.SyntaxKind.KeyOfKeyword, resolvedTarget);
      }
    }
    if (ts.isIndexedAccessTypeNode(node)) {
      // A checked indexed result can be finite even when its callable input
      // has a recursive options type. Preserve that exact scalar result rather
      // than expanding unrelated fields of the input contract.
      if (ts.isTypeReferenceNode(node.objectType)) {
        const reference = checker.getSymbolAtLocation(node.objectType.typeName);
        const target = reference && reference.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(reference) : reference;
        if (target?.declarations?.length && target.declarations.every(declaration =>
          !declaration.getSourceFile().isDeclarationFile || trustedDeclaration?.(declaration.getSourceFile()))) {
          const type = checker.getTypeFromTypeNode(node);
          const scalar = (value: ts.Type): boolean => value.isUnion() ? value.types.every(scalar)
            : !!(value.flags & (ts.TypeFlags.StringLike | ts.TypeFlags.NumberLike | ts.TypeFlags.BooleanLike
              | ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Never));
          if (scalar(type)) return queriedType(type);
        }
      }
      const resolvedObject = child(node.objectType);
      const resolvedIndex = child(node.indexType);
      if (ts.isTypeLiteralNode(resolvedObject) && ts.isLiteralTypeNode(resolvedIndex) && ts.isStringLiteral(resolvedIndex.literal)) {
        const targetKey = resolvedIndex.literal.text;
        for (const member of resolvedObject.members) {
          if (ts.isPropertySignature(member) && member.type) {
            const memberName = ts.isIdentifier(member.name) || ts.isStringLiteral(member.name) ? member.name.text : undefined;
            if (memberName === targetKey) {
              return member.questionToken
                ? f.createUnionTypeNode([member.type, f.createKeywordTypeNode(ts.SyntaxKind.UndefinedKeyword)])
                : member.type;
            }
          }
        }
      }
      if (ts.isArrayTypeNode(resolvedObject) && resolvedIndex.kind === ts.SyntaxKind.NumberKeyword) {
        return resolvedObject.elementType;
      }
      return f.createIndexedAccessTypeNode(resolvedObject, resolvedIndex);
    }
    if (ts.isFunctionTypeNode(node) && !node.typeParameters?.length) {
      return f.createFunctionTypeNode(undefined, node.parameters.map(p => {
        if (!ts.isIdentifier(p.name) || !p.type) throw new Error('Helper callback parameters need explicit portable data types.');
        return f.createParameterDeclaration(undefined, p.dotDotDotToken && f.createToken(ts.SyntaxKind.DotDotDotToken), p.name.text,
          p.questionToken && f.createToken(ts.SyntaxKind.QuestionToken), child(p.type));
      }), child(node.type));
    }
    if (ts.isTypeLiteralNode(node)) return f.createTypeLiteralNode(node.members.map(member => {
      if(ts.isIndexSignatureDeclaration(member)){
        const parameter=member.parameters[0];
        if(member.parameters.length!==1||!member.type||!parameter||!ts.isIdentifier(parameter.name)||!parameter.type
          ||parameter.dotDotDotToken||parameter.questionToken||parameter.initializer||parameter.modifiers?.length
          ||member.modifiers?.some(modifier=>modifier.kind!==ts.SyntaxKind.ReadonlyKeyword))
          throw new Error('Helper index signatures require one typed ordinary key and an explicit value type.');
        const key=child(parameter.type);
        if(key.kind!==ts.SyntaxKind.StringKeyword&&key.kind!==ts.SyntaxKind.NumberKeyword)
          throw new Error('Helper index signature keys require an explicit string or number type.');
        return f.createIndexSignature(member.modifiers?.some(modifier=>modifier.kind===ts.SyntaxKind.ReadonlyKeyword)
          ?[f.createModifier(ts.SyntaxKind.ReadonlyKeyword)]:undefined,
          [f.createParameterDeclaration(undefined,undefined,parameter.name.text,undefined,key)],child(member.type));
      }
      if(ts.isMethodSignature(member)){
        if(!member.type)throw new Error('Helper method signatures require an explicit portable return type.');
        const scoped=new Map(substitutions);
        for(const parameter of member.typeParameters??[]){
          const symbol=checker.getSymbolAtLocation(parameter.name);
          if(!symbol)throw new Error('Helper method type parameters require checked source declarations.');
          scoped.set(symbol,f.createTypeReferenceNode(parameter.name.text));
        }
        const project=(type:ts.TypeNode)=>data(type,scoped,new Set(active));
        const typeParameters=member.typeParameters?.map(parameter=>f.createTypeParameterDeclaration(undefined,parameter.name.text,
          parameter.constraint&&project(parameter.constraint),parameter.default&&project(parameter.default)));
        const parameters=member.parameters.map(parameter=>{
          if(!ts.isIdentifier(parameter.name)||!parameter.type)throw new Error('Helper method parameters need explicit portable data types.');
          return f.createParameterDeclaration(undefined,parameter.dotDotDotToken&&f.createToken(ts.SyntaxKind.DotDotDotToken),parameter.name.text,
            parameter.questionToken&&f.createToken(ts.SyntaxKind.QuestionToken),project(parameter.type));
        });
        return f.createMethodSignature(undefined,name(member.name),member.questionToken&&f.createToken(ts.SyntaxKind.QuestionToken),
          typeParameters,parameters,project(member.type));
      }
      if (!ts.isPropertySignature(member) || !member.type) throw new Error('Helper object types require typed properties.');
      return f.createPropertySignature(member.modifiers?.some(m => m.kind === ts.SyntaxKind.ReadonlyKeyword) ? [f.createModifier(ts.SyntaxKind.ReadonlyKeyword)] : undefined,
        name(member.name), member.questionToken && f.createToken(ts.SyntaxKind.QuestionToken), child(member.type));
    }));
    if (ts.isTypeReferenceNode(node)) {
      if (ts.isQualifiedName(node.typeName)) {
        if (ts.isIdentifier(node.typeName.left) && node.typeName.left.text === 'Intl' && builtin(checker.getSymbolAtLocation(node.typeName.left)))
          return recordStringUnknown();
        if (isReactNamespaceIdentifier(node.typeName.left)) {
          const right = node.typeName.right.text;
          const state = reactStateType(right, node.typeArguments, child);
          if (state) return state;
          if (right === 'CSSProperties') return recordStringUnknown();
          if (REACT_EVENT_TYPES.has(right) || REACT_NODE_TYPES.has(right)) return f.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);
          if (REACT_REF_TYPES.has(right)) {
            const inner = node.typeArguments?.[0] ? child(node.typeArguments[0]) : f.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);
            return refObjectType(inner);
          }
          if (REACT_ATTR_TYPES.has(right)) {
            const firstArg = node.typeArguments?.[0];
            if (!firstArg || !ts.isTypeQueryNode(firstArg)) {
              return recordStringUnknown();
            }
          }
        }
        if (trustedDeclaration) {
          const materialized=materializedQueryAlias(node,substitutions,active);if(materialized)return materialized;
          const reference = checker.getSymbolAtLocation(node.typeName);
          const symbol = reference && reference.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(reference) : reference;
          const declared = declaredType(node, symbol, substitutions, active);
          if (declared) return declared;
        }
      } else if (ts.isIdentifier(node.typeName)) {
        const reference = checker.getSymbolAtLocation(node.typeName);
        const symbol = reference?.flags && reference.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(reference) : reference;
        const replacement = symbol && substitutions.get(symbol);
        if (replacement) return replacement;
        if (symbol && generic.has(symbol)) return f.createTypeReferenceNode(node.typeName.text);
        const utility = node.typeName.text;
        const sourceFileName = node.getSourceFile()?.fileName ?? node.typeName.getSourceFile()?.fileName ?? '';
        const reactType = reactImportedType(utility, node.typeArguments, reference, sourceFileName, child);
        if (reactType) return reactType;
        if(['Parameters','ReturnType','ConstructorParameters','InstanceType'].includes(utility)&&builtin(reference)){
          if(node.typeArguments?.length!==1)throw new Error(`${utility} requires one checked callable type.`);
          return f.createTypeReferenceNode(utility,[child(node.typeArguments[0]!)]);
        }
        if (['Partial', 'Pick', 'Omit', 'Required', 'Readonly'].includes(utility) && builtin(reference)) {
          const materialized=materializedQueryAlias(node,substitutions,active);if(materialized)return materialized;
          const selecting = utility === 'Pick' || utility === 'Omit';
          if (node.typeArguments?.length !== (selecting ? 2 : 1)) throw new Error(`${utility} has an unsupported type argument count.`);
          const target=child(node.typeArguments[0]!);
          // An explicit native binding remains the authority for its fields.
          // Keep TypeScript's real utility over that type instead of expanding
          // an external contract into a guessed structural property bag.
          if(containsNative(target)&&!(ts.isTypeLiteralNode(target)&&target.members.every(ts.isPropertySignature)))
            return f.createTypeReferenceNode(utility,[target,...(selecting?[child(node.typeArguments[1]!)]:[])]);
          const properties = objectProperties(target);
          const keys = selecting ? literalKeys(child(node.typeArguments[1]!)) : undefined;
          if (utility === 'Pick' && [...keys!].some(key => !properties.some(property => propertyKey(property.name) === key)))
            throw new Error('Pick utility keys must name existing object properties.');
          return f.createTypeLiteralNode(properties.filter(property => !keys || (utility === 'Pick') === keys.has(propertyKey(property.name)))
            .map(property => f.createPropertySignature(utility === 'Readonly' ? [f.createModifier(ts.SyntaxKind.ReadonlyKeyword)] : property.modifiers,
              property.name, utility === 'Partial' ? f.createToken(ts.SyntaxKind.QuestionToken) : utility === 'Required' ? undefined : property.questionToken,
              utility === 'Required' && property.questionToken ? withoutUndefined(property.type!) : property.type)));
        }
        const materialized=materializedQueryAlias(node,substitutions,active);if(materialized)return materialized;
        const declared = declaredType(node, symbol, substitutions, active);
        if (declared) return declared;
        const declarations = declarationsFor(symbol);
        const typeName = node.typeName.text;
        if (!declarations?.length) {
          if (['Array', 'ReadonlyArray'].includes(typeName) && builtin(reference)&&node.typeArguments?.length === 1) {
            const array = f.createArrayTypeNode(child(node.typeArguments[0]!));
            return typeName === 'ReadonlyArray' ? f.createTypeOperatorNode(ts.SyntaxKind.ReadonlyKeyword, array) : array;
          }
          if (typeName === 'Record' && builtin(reference)&&node.typeArguments?.length === 2) {
            return f.createTypeReferenceNode('Record', [child(node.typeArguments[0]!), child(node.typeArguments[1]!)]);
          }
          if (typeName === 'SegmentedControlSize') {
            return f.createUnionTypeNode([
              f.createLiteralTypeNode(f.createStringLiteral('default')),
              f.createLiteralTypeNode(f.createStringLiteral('lg')),
              f.createLiteralTypeNode(f.createStringLiteral('sm')),
            ]);
          }
        }
      }
    }
    const label = ts.createPrinter().printNode(ts.EmitHint.Unspecified, node, node.getSourceFile());
    throw new Error(`Helper type ${label} needs an explicit platform type binding.`);
  }
  return { data, infer };
}

export function helperSignature(fn: SourceFunction, checker: ts.TypeChecker, override?: ExplicitTypeProjection,
  trustedDeclaration?: (file: ts.SourceFile) => boolean,opaqueInferences=false,inferredOverride?:InferredTypeProjection,
  standardLibraryFile?: (file: ts.SourceFile) => boolean, reactInferenceEnabled=false): HelperSignature {
  const f = ts.factory;
  // Executable JS annotations are installed by the checked declaration/private
  // inference stage. Only annotations belonging to this helper may cross the
  // explicit dynamic-property boundary as unknown; foreign aliases and typed
  // TypeScript annotations retain their ordinary rejection of any.
  const opaqueAnnotations=new WeakSet<ts.Node>();
  if(opaqueInferences&&/\.[cm]?jsx?$/.test(fn.getSourceFile().fileName)){
    const scan=(node:ts.Node)=>{if(node.kind===ts.SyntaxKind.AnyKeyword)opaqueAnnotations.add(node);ts.forEachChild(node,scan);};
    for(const parameter of fn.typeParameters??[])scan(parameter);
    for(const parameter of fn.parameters)if(parameter.type)scan(parameter.type);
    if(fn.type)scan(fn.type);
  }
  const project:ExplicitTypeProjection=(node,child)=>override?.(node,child)
    ??(opaqueAnnotations.has(node)?f.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword):undefined);
  const { data, infer } = createTypeProjection(checker, fn.typeParameters, project, trustedDeclaration,opaqueInferences,inferredOverride,
    fn.getSourceFile().fileName,standardLibraryFile,reactInferenceEnabled);
  const parameters = fn.parameters.map(parameter => ({
    type: parameter.type ? data(parameter.type) : infer(checker.getTypeAtLocation(parameter)),
    optional: !!parameter.questionToken,
  }));
  const signature = checker.getSignatureFromDeclaration(fn);
  if (!fn.type && !signature) throw new Error('Missing helper return signature.');
  const result = fn.type ? data(fn.type) : infer(checker.getReturnTypeOfSignature(signature!));
  const typeParameters = (fn.typeParameters ?? []).map(p => f.createTypeParameterDeclaration(undefined, p.name.text,
    p.constraint && data(p.constraint), p.default && data(p.default)));
  return { parameters, result, typeParameters };
}
