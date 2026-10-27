import crypto from 'node:crypto';
import ts from 'typescript';
import { createTypeProjection, helperSignature, type HelperSignature, type SourceFunction } from './helper-types.ts';
import { createSourceTypes, preserveTypes, typeOnlyNamespace, type TypeProofs } from './preserve-types.ts';
import { createIdentifierHygiene } from './data-identifiers.ts';
import { privateFunctionExpression, updateSourceFunction } from './function-forms.ts';
import { sourceProgram, type TypeSource, type SourceResolution } from './source-program.ts';
import { jsxRuntimeExport, reactCreateElement } from './source-mode.ts';
import { renderNulls } from './render-values.ts';
import { scalarString, stringCall, validStringArguments, type StringCall } from './string-methods.ts';
import { compileVariants, type VariantMetadata } from './variants.ts';
import { compileStyleObject, type StyleObject } from './style-object.ts';
import { compileNumericStyle, type NumericStyleTemplate } from './numeric-style.ts';
import { numericTemplateValue } from './numeric-template.ts';
import {createSourceValues,type SourceValueOptions} from './source-values.ts';
import {implicitArgumentsOwner,sourceArgumentsType} from './data-arguments.ts';
import {transformDataRecords} from './data-records.ts';
import { compileStaticSvg, staticSvgAssetAttribute, type StaticSvgOptions, type StaticSvgElement, type StaticSvgAsset } from './static-svg.ts';
import type { DataTypeBinding } from './data-module.ts';
import {trustedJavaScriptReturns} from './javascript-contracts.ts';
import type {JavaScriptContract} from './javascript-types.ts';
export { type StaticSvgInput, type StaticSvgOptions, type StaticSvgAsset, staticSvgAssetAttribute } from './static-svg.ts';
export { compileVariants, variantClassLists, type VariantMetadata } from './variants.ts';
export { compileStyleObject, type StyleObject, type StyleValue } from './style-object.ts';
export { compileDataModule, type DataModuleOptions, type DataModuleResult, type DataImportBinding, type DataTypeBinding, type TypeSource } from './data-module.ts';
export { compileProject, type ProjectOptions, type ProjectResult, type ProjectModule, type ProjectFile } from './project.ts';
export type { TypeProofs } from './preserve-types.ts';
export type {SourceValueOptions} from './source-values.ts';

export type BindingKind = 'component' | 'className' | 'variants' | 'mergeProps' | 'render' | 'value';
export interface ComponentTypeBinding {
  /** Type-only import in the emitted module; no runtime dependency is added. */
  readonly module: string;
  readonly name: string;
  readonly member?: string;
}
export interface ValueTypeBinding extends ComponentTypeBinding {
  /** Query an exported value's type, for example a native React hook. */
  readonly typeOf?: boolean;
}
export interface GlobalBinding {
  readonly name: string;
  readonly valueType: ValueTypeBinding;
  readonly members?: readonly string[];
}
export interface ImportBinding {
  readonly module: string;
  readonly name: string;
  readonly kind: BindingKind;
  /** Explicit component members exported by an imported namespace object. */
  readonly members?: readonly string[];
  /** Checked platform component function, or a parts object for namespace bindings. */
  readonly componentType?: ComponentTypeBinding;
  /** Required for value bindings; the caller supplies the actual platform value. */
  readonly valueType?: ValueTypeBinding;
}
export interface CompileOptions {
  readonly filename: string;
  readonly exports: readonly string[];
  readonly bindings: readonly ImportBinding[];
  /** Source dependencies establish types; their runtime implementations are linked separately. */
  readonly typeSources?: readonly TypeSource[];
  /** Explicit native type contracts, shared with ordinary source modules. */
  readonly types?: readonly DataTypeBinding[];
  readonly sourceResolution?: SourceResolution;
  /** Explicit unbound source names; no browser/global implementation is inferred. */
  readonly globals?: readonly GlobalBinding[];
  /** Source tags handled by explicit components in the application's Html map. */
  readonly nativeTags?: readonly string[];
  /** Opt-in static SVG assets using a supplied compiler and an explicit svg host adapter. */
  readonly staticSvg?: StaticSvgOptions;
  /** Only these imported calls may be discarded with an unselected initializer. */
  readonly pureCalls?: readonly { readonly module: string; readonly name: string }[];
  readonly typesModule?: string;
  /** Shared source-value passes used by ordinary modules and JSX bodies. */
  readonly values?:SourceValueOptions;
  readonly nodes?:Pick<GlobalBinding,'name'|'valueType'>;
  /** Preserve all module initialization/state inside a once-owned project factory. */
  readonly factoryModuleState?: boolean;
  /** Html.normalizeStyle owns ordinary mutable style records at runtime. */
  readonly runtimeStyleRecords?: boolean;
  /** Allow the bounded React DOM/type projection used by inferred helper APIs. */
  readonly reactInference?: boolean;
}
export interface Diagnostic {
  /** Present when a supplementary source, rather than the compiled root, failed. */
  readonly filename?: string;
  readonly code: string;
  readonly message: string;
  readonly line: number;
  readonly column: number;
}
export interface CompileResult {
  readonly trustedJavaScriptContracts: readonly JavaScriptContract[];
  readonly source?: string;
  readonly diagnostics: readonly Diagnostic[];
  readonly imports: readonly (ImportBinding & { readonly local: string })[];
  readonly globals: readonly GlobalBinding[];
  readonly exports: readonly string[];
  readonly intrinsics: readonly string[];
  readonly sourceSha256: string;
  readonly svgAssets: readonly StaticSvgAsset[];
  readonly variantDefinitions: readonly { readonly line: number; readonly column: number; readonly metadata: VariantMetadata }[];
  readonly typeProofs: TypeProofs;
  readonly renamedIdentifiers: number;
  readonly sourceValueContext?:{readonly name:string;readonly bindings:readonly Pick<GlobalBinding,'name'|'valueType'>[]};
  readonly sourceFeatures: { readonly fragments: boolean; readonly booleanCoercions: number; readonly typeofExpressions: number; readonly styleObjects: number; readonly numericStyles: number; readonly helperFunctions: number; readonly renderNulls: number; readonly stringMethods: number };
}

// TypeScript lowers JSX; roblox-ts handles JS semantics and Luau emission.
// This pass selects declarations and makes platform dependencies explicit.
export function compileComponent(text: string, options: CompileOptions): CompileResult {
  const filename = options.filename.replaceAll('\\', '/');
  const scriptKind = /\.(?:js|mjs|cjs)$/.test(filename) ? ts.ScriptKind.JS : filename.endsWith('.jsx') ? ts.ScriptKind.JSX : ts.ScriptKind.TSX;
  const { source, program, duplicates, pairingDiagnostics, originalPosition, trustedJavaScriptContracts, trustedPublicFunction, standardLibraryFile } = sourceProgram(text, filename,options.values!==undefined, options.typeSources, options.sourceResolution, scriptKind);
  const svgElements = new Map<ts.Node, StaticSvgElement>();
  const svgSpreadTags=new Map<string,StaticSvgElement>();
  const checker = program.getTypeChecker();
  const canonicalSource = (filename: string) => {
    const absolute = ts.sys.resolvePath(filename).replaceAll('\\', '/');
    return ts.sys.useCaseSensitiveFileNames ? absolute : absolute.toLowerCase();
  };
  const suppliedTypes = new Set(options.typeSources?.map(input => canonicalSource(input.filename)));
  const trustedDeclaration = options.sourceResolution?.declarationFiles && options.typeSources?.length
    ? (file: ts.SourceFile) => file.isDeclarationFile && suppliedTypes.has(canonicalSource(file.fileName)) : undefined;
  const declarationCompanions = new Map(Object.entries(options.sourceResolution?.declarationFiles ?? {})
    .map(([source, declaration]) => [canonicalSource(source), canonicalSource(declaration)]));
  const diagnostics: Diagnostic[] = [...pairingDiagnostics];
  const report = (node: ts.Node, code: string, message: string) => {
    const position = originalPosition(node.getStart(source));
    diagnostics.push({ code, message, line: position.line + 1, column: position.character + 1 });
  };
  for (const duplicate of duplicates) report(source, 'source-input', `Duplicate source input: ${duplicate}`);
  for (const diagnostic of program.getSyntacticDiagnostics(source)) {
    const position = originalPosition(diagnostic.start ?? 0);
    diagnostics.push({ code: 'syntax', message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'), line: position.line + 1, column: position.character + 1 });
  }
  type PublicDeclaration = ts.FunctionDeclaration | ts.VariableDeclaration | ts.Identifier;
  const exported = new Map<string, PublicDeclaration>();
  const moduleStatements = new Set<ts.Statement>();
  const bindingNames = (name: ts.BindingName): readonly ts.Identifier[] => ts.isIdentifier(name) ? [name]
    : name.elements.flatMap(element => ts.isOmittedExpression(element) ? [] : bindingNames(element.name));
  function moduleVariable(declaration: ts.Node | undefined): ts.VariableDeclaration | undefined {
    let current = declaration;
    while (current && (ts.isBindingElement(current) || ts.isObjectBindingPattern(current) || ts.isArrayBindingPattern(current))) current = current.parent;
    return current && ts.isVariableDeclaration(current) && ts.isVariableDeclarationList(current.parent)
      && ts.isVariableStatement(current.parent.parent) && current.parent.parent.parent === source ? current : undefined;
  }
  const moduleEffect = (statement: ts.Statement) => ts.isExpressionStatement(statement) || ts.isIfStatement(statement) || ts.isBlock(statement)
    || ts.isForStatement(statement) || ts.isForInStatement(statement) || ts.isForOfStatement(statement) || ts.isWhileStatement(statement)
    || ts.isDoStatement(statement) || ts.isSwitchStatement(statement) || ts.isTryStatement(statement) || ts.isThrowStatement(statement)
    || ts.isLabeledStatement(statement) || ts.isEmptyStatement(statement);
  const moduleFunctions = new Set<SourceFunction>();
  const functionVariables = new Map<SourceFunction, ts.VariableDeclaration>();
  const variableFunctions = new Map<ts.VariableDeclaration, SourceFunction>();
  function functionName(fn: SourceFunction): string | undefined {
    const name = functionVariables.get(fn)?.name ?? (!ts.isArrowFunction(fn) ? fn.name : undefined);
    return name && ts.isIdentifier(name) ? name.text : undefined;
  }
  function initializerFunction(expression: ts.Expression): ts.FunctionExpression | ts.ArrowFunction | undefined {
    while (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) || ts.isSatisfiesExpression(expression)) expression = expression.expression;
    return ts.isFunctionExpression(expression) || ts.isArrowFunction(expression) ? expression : undefined;
  }
  const imported = new Map<ts.Symbol, { module: string; name: string; local: string; node: ts.Node }>();
  type ReactFactory = 'forwardRef' | 'memo';
  const factoryFunctions = new Map<SourceFunction, ReactFactory>();
  const factoryProps = new Map<SourceFunction, ts.TypeNode>();
  function reactFragment(tag: ts.Node): boolean {
    if (jsxRuntimeExport(tag, checker) === 'Fragment') return true;
    if (ts.isIdentifier(tag)) {
      if (/^[a-z]/.test(tag.text)) return false; // Lowercase JSX names are intrinsic tags.
      const dependency = imported.get(checker.getSymbolAtLocation(tag)!);
      return dependency?.module === 'react' && dependency.name === 'Fragment';
    }
    if (!ts.isPropertyAccessExpression(tag) || !ts.isIdentifier(tag.expression) || tag.name.text !== 'Fragment') return false;
    const dependency = imported.get(checker.getSymbolAtLocation(tag.expression)!);
    return dependency?.module === 'react' && (dependency.name === '*' || dependency.name === 'default');
  }
  function reactFactory(expression: ts.Expression, active = new Set<ts.Node>()): ReactFactory | undefined {
    if (active.has(expression)) return undefined;
    active.add(expression);
    if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) || ts.isSatisfiesExpression(expression)) {
      return reactFactory(expression.expression, active);
    }
    if (ts.isIdentifier(expression)) {
      const symbol = checker.getSymbolAtLocation(expression);
      const dependency = symbol && imported.get(symbol);
      if (dependency?.module === 'react' && (dependency.name === 'forwardRef' || dependency.name === 'memo')) return dependency.name;
      const declaration = symbol?.valueDeclaration;
      if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer
        && ts.isVariableDeclarationList(declaration.parent) && declaration.parent.flags & ts.NodeFlags.Const) {
        return reactFactory(declaration.initializer, active);
      }
    } else if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
      if (!ts.isIdentifier(expression.expression)) return undefined;
      const dependency = imported.get(checker.getSymbolAtLocation(expression.expression)!);
      const member = ts.isPropertyAccessExpression(expression) ? expression.name.text
        : ts.isStringLiteral(expression.argumentExpression) ? expression.argumentExpression.text : undefined;
      if (dependency?.module === 'react' && (dependency.name === '*' || dependency.name === 'default')
        && (member === 'forwardRef' || member === 'memo')) return member;
    }
    return undefined;
  }
  function componentInitializer(expression: ts.Expression): { fn: SourceFunction; factory?: ReactFactory } | undefined {
    const fn = initializerFunction(expression);
    if (fn) return { fn };
    if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) || ts.isSatisfiesExpression(expression)) return componentInitializer(expression.expression);
    if (!ts.isCallExpression(expression)) return undefined;
    const factory = reactFactory(expression.expression);
    const inner = factory && expression.arguments[0] && componentInitializer(expression.arguments[0]);
    return inner ? { fn: inner.fn, factory: inner.factory ?? factory } : undefined;
  }
  const names = new Set<string>();
  function indexNames(node: ts.Node) {
    if (ts.isIdentifier(node)) names.add(node.text);
    ts.forEachChild(node, indexNames);
  }
  indexNames(source);
  function fresh(base: string) {
    let name = base;
    for (let suffix = 1; names.has(name); suffix++) name = `${base}${suffix}`;
    names.add(name);
    return name;
  }
  const html = fresh('__CssHtml');
  const element = fresh('__cssElement');
  const fragment = fresh('__cssFragment');
  const jsxProps = fresh('__cssJsxProps');
  const typeQuery = fresh('__cssTypeOf');
  const stringMethods = fresh('__cssStrings');
  const styleData = fresh('__cssStyleObjects');
  const dependencies = fresh('__cssDependencies');
  const svgPropsHelper=fresh('__cssStaticSvgProps');
  const valueContextName=fresh('__sourceValues');
  const valueBindings=new Map<string,{binding:Pick<GlobalBinding,'name'|'valueType'>;local:string}>();
  const componentTypes = new Map<string, { module: string; name: string; alias: string }>();
  const classConstructors=new Map<string,{name:string;type:ts.TypeNode}>();
  const classIdentities=new Map<ts.Symbol,ts.Identifier|undefined>();
  function nativeValueType(type:ValueTypeBinding):ts.TypeNode {
    const key=JSON.stringify([type.module,type.name]);
    let imported=componentTypes.get(key);
    if(!imported){imported={module:type.module,name:type.name,alias:fresh('__CssValueType')};componentTypes.set(key,imported);}
    const base=type.typeOf?ts.factory.createTypeQueryNode(ts.factory.createIdentifier(imported.alias)):ts.factory.createTypeReferenceNode(imported.alias);
    return type.member===undefined?base:ts.factory.createIndexedAccessTypeNode(base,ts.factory.createLiteralTypeNode(ts.factory.createStringLiteral(type.member)));
  }
  const aliasedClass=(symbol:ts.Symbol)=>symbol.flags&ts.SymbolFlags.Alias?checker.getAliasedSymbol(symbol):symbol;
  function nativeClassConstructor(target:ts.Symbol):ts.Identifier|undefined {
    if(classIdentities.has(target))return classIdentities.get(target);
    const declaration=target.declarations?.find(ts.isClassDeclaration);
    if(!declaration)return undefined;
    const exportedNames=(symbol:ts.Symbol,file:ts.SourceFile)=>{
      const module=checker.getSymbolAtLocation(file);
      return module?checker.getExportsOfModule(module).filter(value=>aliasedClass(value)===symbol).map(value=>value.name):[];
    };
    const sameClass=(other:ts.Symbol)=>{
      if(target===other)return true;
      const otherDeclaration=other.declarations?.find(ts.isClassDeclaration);if(!otherDeclaration)return false;
      const left=declaration.getSourceFile(),right=otherDeclaration.getSourceFile();
      const a=canonicalSource(left.fileName),b=canonicalSource(right.fileName);
      if(declarationCompanions.get(a)!==b&&declarationCompanions.get(b)!==a)return false;
      const names=new Set(exportedNames(target,left));return exportedNames(other,right).some(name=>names.has(name));
    };
    for(const [symbol,dependency]of imported){
      const binding=bindingsByKey.get(`${dependency.module}#${dependency.name}`);
      if(binding?.kind!=='value'||!binding.valueType)continue;
      const runtime=aliasedClass(symbol);
      const candidates=dependency.name==='*'?checker.getExportsOfModule(runtime).map(value=>({symbol:aliasedClass(value),members:[value.name]}))
        :[{symbol:runtime,members:[]}];
      for(const candidate of candidates){
        if(!sameClass(candidate.symbol))continue;
        const key=JSON.stringify([binding.valueType,...candidate.members]);let view=classConstructors.get(key);
        if(!view){
          let type=nativeValueType(binding.valueType);
          for(const member of candidate.members)type=ts.factory.createIndexedAccessTypeNode(type,ts.factory.createLiteralTypeNode(ts.factory.createStringLiteral(member)));
          view={name:fresh('__CssClassConstructor'),type};classConstructors.set(key,view);
        }
        const name=ts.factory.createIdentifier(view.name);classIdentities.set(target,name);return name;
      }
    }
    classIdentities.set(target,undefined);return undefined;
  }
  function nativeClassInstance(symbol:ts.Symbol,args?:readonly ts.TypeNode[]):ts.TypeNode|undefined {
    const constructor=nativeClassConstructor(symbol);
    return constructor&&ts.factory.createTypeReferenceNode('InstanceType',[ts.factory.createTypeQueryNode(constructor,args)]);
  }
  function nativeImportedType(type:ts.Type,project:(type:ts.Type)=>ts.TypeNode):ts.TypeNode|undefined {
    const candidates=[type.aliasSymbol,type.getSymbol()].filter((symbol):symbol is ts.Symbol=>!!symbol)
      .flatMap(symbol=>{
        const result=[symbol.flags&ts.SymbolFlags.Alias?checker.getAliasedSymbol(symbol):symbol];
        for(const declaration of symbol.declarations??[]){
          for(let owner:ts.Node|undefined=declaration;owner;owner=owner.parent){
            if(!ts.isTypeAliasDeclaration(owner)&&!ts.isInterfaceDeclaration(owner)&&!ts.isClassDeclaration(owner))continue;
            const identity=owner.name&&checker.getSymbolAtLocation(owner.name);
            if(identity)result.push(identity);
            break;
          }
        }
        return result;
      });
    if(!candidates.length)return undefined;
    for(const statement of source.statements){
      if(!ts.isImportDeclaration(statement)||!ts.isStringLiteral(statement.moduleSpecifier))continue;
      const module=statement.moduleSpecifier.text;
      const moduleSymbol=checker.getSymbolAtLocation(statement.moduleSpecifier);
      if(!moduleSymbol)continue;
      const exports:ts.Symbol[]=[];
      const visited=new Set<ts.Symbol>();
      const collectExports=(owner:ts.Symbol)=>{
        if(visited.has(owner))return;
        visited.add(owner);
        let values:readonly ts.Symbol[]=[];
        try{values=checker.getExportsOfModule(owner);}catch{return;}
        for(const value of values){
          exports.push(value);
          if((value.name==='export='||value.name==='default')&&value.flags&ts.SymbolFlags.Alias){
            const target=checker.getAliasedSymbol(value);
            if(target!==value)collectExports(target);
          }
        }
        if(owner.flags&ts.SymbolFlags.Alias){
          const target=checker.getAliasedSymbol(owner);
          if(target!==owner)collectExports(target);
        }
      };
      collectExports(moduleSymbol);
      for(const exported of exports){
        const identity=exported.flags&ts.SymbolFlags.Alias?checker.getAliasedSymbol(exported):exported;
        if(!candidates.includes(identity))continue;
        const binding=options.types?.find(item=>!item.local&&item.module===module&&item.name===exported.name)
          ??options.types?.find(item=>!item.local&&item.module===module&&item.name==='*');
        if(!binding)continue;
        const target=nativeValueType(binding.target);
        let typeName:ts.EntityName;
        if(ts.isTypeReferenceNode(target))typeName=target.typeName;
        else return undefined;
        if(binding.name==='*')typeName=ts.factory.createQualifiedName(typeName,exported.name);
        const referenceArguments=type.flags&ts.TypeFlags.Object&&(type as ts.ObjectType).objectFlags&ts.ObjectFlags.Reference
          ?checker.getTypeArguments(type as ts.TypeReference).map(project):type.aliasTypeArguments?.map(project);
        if(referenceArguments)return ts.factory.createTypeReferenceNode(typeName,referenceArguments);
        const declaration=identity.declarations?.find(ts.isTypeAliasDeclaration);
        const typeParameterCount=declaration?.typeParameters?.length??0;
        if(typeParameterCount){
          const signature=type.getConstructSignatures()[0]??type.getCallSignatures()[0];
          const arguments_=signature?.parameters.slice(0,typeParameterCount).map(parameter=>
            project(checker.getTypeOfSymbolAtLocation(parameter,parameter.valueDeclaration??declaration!)));
          if(arguments_?.length===typeParameterCount)return ts.factory.createTypeReferenceNode(typeName,arguments_);
        }
        return ts.factory.createTypeReferenceNode(typeName);
      }
    }
    return undefined;
  }
  function inferredValueType(type:ts.Type,project:(type:ts.Type)=>ts.TypeNode):ts.TypeNode|undefined {
    const symbol=type.getSymbol();
    if(symbol?.declarations?.some(ts.isClassDeclaration)&&!type.getConstructSignatures().length){
      const arguments_=type.flags&ts.TypeFlags.Object&&(type as ts.ObjectType).objectFlags&ts.ObjectFlags.Reference
        ?checker.getTypeArguments(type as ts.TypeReference).map(project):undefined;
      const native=nativeClassInstance(symbol,arguments_);if(native)return native;
    }
    const importedType=nativeImportedType(type,project);
    if(importedType)return importedType;
    if(!symbol?.declarations?.length||!symbol.declarations.every(declaration=>standardLibraryFile(declaration.getSourceFile())))return undefined;
    const binding=options.types?.find(binding=>!binding.module&&!binding.local&&binding.name===symbol.name);
    if(!binding)return undefined;
    const target=nativeValueType(binding.target);
    if(!ts.isTypeReferenceNode(target))return undefined;
    const arguments_=type.flags&ts.TypeFlags.Object&&(type as ts.ObjectType).objectFlags&ts.ObjectFlags.Reference
      ?checker.getTypeArguments(type as ts.TypeReference).map(project):undefined;
    return ts.factory.createTypeReferenceNode(target.typeName,arguments_);
  }
  function valueProvider(binding:Pick<GlobalBinding,'name'|'valueType'>,base:string):ts.Identifier {
    let item=valueBindings.get(binding.name);
    if(!item){item={binding,local:fresh(base)};valueBindings.set(binding.name,item);}
    else if(JSON.stringify(item.binding.valueType)!==JSON.stringify(binding.valueType))report(source,'value-binding',`Conflicting source value provider: ${binding.name}`);
    return ts.factory.createIdentifier(item.local);
  }
  const sourceGlobal=(symbol:ts.Symbol|undefined)=>!symbol?.declarations?.some(d=>
    !program.isSourceFileDefaultLibrary(d.getSourceFile()) && (d.getSourceFile()===source||ts.isExternalModule(d.getSourceFile())));
  const sourceValues=createSourceValues(options.values??{},{checker,program,report,global:sourceGlobal,provider:valueProvider,nativeType:nativeValueType,
    ...(options.sourceResolution?.sourceStrict!==undefined?{sourceStrict:options.sourceResolution.sourceStrict}:{}),
    dynamicSource:/\.[cm]?jsx?$/.test(filename)&&!!options.sourceResolution?.dynamicProperties,
    projectFunctionType(fn){
      try {
        const signature=helperSignature(fn,checker,projectedValueType,trustedDeclaration,
          Boolean(options.sourceResolution?.dynamicProperties || options.values?.dynamicProperties),inferredValueType,standardLibraryFile,options.reactInference===true);
        return ts.factory.createFunctionTypeNode(signature.typeParameters,fn.parameters.map((parameter,index)=>
          ts.factory.createParameterDeclaration(undefined,parameter.dotDotDotToken,parameter.name,
            signature.parameters[index]!.optional?ts.factory.createToken(ts.SyntaxKind.QuestionToken):undefined,
            signature.parameters[index]!.type)),signature.result);
      }catch{return undefined;}
    }});
  function reactType(node: ts.TypeReferenceNode): 'Node' | 'Element' | undefined {
    let root = node.typeName;
    const members: string[] = [];
    while (ts.isQualifiedName(root)) { members.unshift(root.right.text); root = root.left; }
    const symbol = checker.getSymbolAtLocation(root);
    const declarations = symbol?.declarations ?? [];
    let importedName: string | undefined;
    for (const declaration of declarations) {
      if (!ts.isImportClause(declaration) && !ts.isNamespaceImport(declaration) && !ts.isImportSpecifier(declaration)) continue;
      const owner = ts.findAncestor(declaration, ts.isImportDeclaration);
      if (owner && ts.isStringLiteral(owner.moduleSpecifier) && owner.moduleSpecifier.text === 'react')
        importedName = ts.isImportSpecifier(declaration) ? (declaration.propertyName ?? declaration.name).text : '*';
    }
    const ambient = declarations.length === 0 || declarations.every(declaration => declaration.getSourceFile().isDeclarationFile);
    const namespace = importedName === '*' || !importedName && ambient && root.text === 'React';
    if (namespace && members.length === 1 && members[0] === 'ReactNode' || importedName === 'ReactNode' && members.length === 0) return 'Node';
    if (namespace && (members.length === 1 && members[0] === 'ReactElement' || members.length === 2 && members[0] === 'JSX' && members[1] === 'Element')
      || importedName === 'ReactElement' && members.length === 0
      || (importedName === 'JSX' || !importedName && ambient && root.text === 'JSX') && members.length === 1 && members[0] === 'Element') return 'Element';
    return undefined;
  }
  function projectedValueType(node:ts.TypeNode,project?:(node:ts.TypeNode)=>ts.TypeNode):ts.TypeNode|undefined {
    if(ts.isLiteralTypeNode(node)&&node.literal.kind===ts.SyntaxKind.NullKeyword&&options.values?.nulls)
      return ts.factory.createIndexedAccessTypeNode(nativeValueType(options.values.nulls.valueType),ts.factory.createLiteralTypeNode(ts.factory.createStringLiteral('value')));
    if (options.values?.arrays && sourceArgumentsType(node,checker))
      return ts.factory.createArrayTypeNode(ts.factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword));
    if (ts.isTypeQueryNode(node) && !node.typeArguments?.length) {
      let root = node.exprName;
      const members: string[] = [];
      while (ts.isQualifiedName(root)) { members.unshift(root.right.text); root = root.left; }
      const dependency = imported.get(checker.getSymbolAtLocation(root)!);
      const binding = dependency && bindingsByKey.get(`${dependency.module}#${dependency.name}`);
      if (binding?.kind === 'value' && binding.valueType) {
        let type = nativeValueType(binding.valueType);
        for (const member of members) type = ts.factory.createIndexedAccessTypeNode(type,
          ts.factory.createLiteralTypeNode(ts.factory.createStringLiteral(member)));
        return type;
      }
    }
    if (options.types?.length && (ts.isTypeReferenceNode(node) || ts.isImportTypeNode(node))) {
      const parts = (name: ts.EntityName): string[] => ts.isIdentifier(name) ? [name.text] : [...parts(name.left), name.right.text];
      let module: string | undefined;
      let members: string[] = [];
      if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
        module = node.argument.literal.text;
        members = node.qualifier ? parts(node.qualifier) : [];
      } else if (ts.isTypeReferenceNode(node)) {
        const names = parts(node.typeName);
        let root = node.typeName;
        while (ts.isQualifiedName(root)) root = root.left;
        const symbol = checker.getSymbolAtLocation(root);
        for (const declaration of symbol?.declarations ?? []) {
          if (!ts.isImportSpecifier(declaration) && !ts.isNamespaceImport(declaration) && !ts.isImportClause(declaration)) continue;
          const owner = ts.findAncestor(declaration, ts.isImportDeclaration);
          if (!owner || !ts.isStringLiteral(owner.moduleSpecifier)) continue;
          module = owner.moduleSpecifier.text;
          members = [...(ts.isImportSpecifier(declaration) ? [(declaration.propertyName ?? declaration.name).text]
            : ts.isImportClause(declaration) && module !== 'react' ? ['default'] : []), ...names.slice(1)];
          break;
        }
        const globalBinding=options.types.some(binding=>!binding.module&&!binding.local&&binding.name===names[0]);
        const declarations=symbol?.declarations;
        // Empty React DOM fallback interfaces still denote platform globals.
        const platformDeclaration=(declaration:ts.Declaration)=>standardLibraryFile(declaration.getSourceFile()) ||
          ts.isInterfaceDeclaration(declaration) && declaration.members.length===0 &&
          /(?:^|\/)@types\/react\/global\.d\.ts$/i.test(declaration.getSourceFile().fileName.replaceAll('\\','/'));
        const authenticStandardLibrary=!!declarations?.length && declarations.every(platformDeclaration);
        if (!module && (globalBinding&&authenticStandardLibrary
          || !declarations?.some(declaration=>!standardLibraryFile(declaration.getSourceFile())))) members = names;
      }
      const exact = members[0] && options.types.find(binding => !binding.local && binding.module === module && binding.name === members[0]);
      const namespace = module && options.types.find(binding => !binding.local && binding.module === module && binding.name === '*');
      const binding = exact || namespace;
      if (binding) {
        const key = JSON.stringify([binding.target.module, binding.target.name]);
        let importedType = componentTypes.get(key);
        if (!importedType) {
          importedType = { ...binding.target, alias: fresh('__CssNativeType') };
          componentTypes.set(key, importedType);
        }
        let target: ts.EntityName = ts.factory.createIdentifier(importedType.alias);
        for (const member of members.slice(exact ? 1 : 0)) target = ts.factory.createQualifiedName(target, member);
        const parameters: ts.TypeParameterDeclaration[] = [];
        for (let owner: ts.Node | undefined = node; owner; owner = owner.parent)
          if (ts.isFunctionLike(owner) || ts.isTypeAliasDeclaration(owner) || ts.isInterfaceDeclaration(owner)) parameters.push(...owner.typeParameters ?? []);
        const projection = createTypeProjection(checker, parameters, projectedValueType, trustedDeclaration,false,undefined,filename,standardLibraryFile,options.reactInference===true);
        const arguments_ = node.typeArguments?.map(argument => project?project(argument):projection.data(argument));
        return ts.isImportTypeNode(node) && node.isTypeOf ? ts.factory.createTypeQueryNode(target, arguments_)
          : ts.factory.createTypeReferenceNode(target, arguments_);
      }
    }
    const react = ts.isTypeReferenceNode(node) && reactType(node);
    if (react) return ts.factory.createTypeReferenceNode(`${html}.${react}`);
    if (ts.isTypeReferenceNode(node)) {
      const reference = checker.getSymbolAtLocation(node.typeName);
      const target = reference && reference.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(reference) : reference;
      if (target?.declarations?.some(ts.isClassDeclaration)) {
        const arguments_=node.typeArguments?.map(argument=>project?project(argument):createTypeProjection(checker,[],projectedValueType,trustedDeclaration,false,undefined,filename,standardLibraryFile,options.reactInference===true).data(argument));
        const native=nativeClassInstance(target,arguments_);if(native)return native;
      }
    }
    return options.values?.nulls&&ts.isLiteralTypeNode(node)&&node.literal.kind===ts.SyntaxKind.NullKeyword
      ?ts.factory.createIndexedAccessTypeNode(nativeValueType(options.values.nulls.valueType),ts.factory.createLiteralTypeNode(ts.factory.createStringLiteral('value'))):undefined;
  }
  const bindingsByKey = new Map<string, ImportBinding>();
  const validValueType = (type: ValueTypeBinding | undefined) => !!type && typeof type === 'object'
    && typeof type.module === 'string' && !!type.module.trim()
    && typeof type.name === 'string' && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(type.name)
    && (type.member === undefined || (typeof type.member === 'string' && !!type.member.length))
    && (type.typeOf === undefined || typeof type.typeOf === 'boolean');
  const validMembers = (members: readonly string[] | undefined) => members === undefined
    || (Array.isArray(members) && members.length > 0 && members.every(name => typeof name === 'string' && name.length > 0)
      && new Set(members).size === members.length);
  const globalsByName = new Map<string, GlobalBinding>();
  const globals = new Map<string, GlobalBinding>();
  for(const binding of [...Object.values(options.values??{}),...(options.nodes?[options.nodes]:[])]){
    if(binding&&(!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(binding.name)||!validValueType(binding.valueType)))
      report(source,'value-binding','Source value capabilities need an identifier and a checked native type.');
  }
  for (const binding of options.globals ?? []) {
    if (typeof binding.name !== 'string' || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(binding.name) || binding.name === 'undefined'
      || !validValueType(binding.valueType) || !validMembers(binding.members)) {
      report(source, 'global-binding', 'Global bindings require a source identifier, platform value type and optional unique members.');
      continue;
    }
    if (globalsByName.has(binding.name)) report(source, 'duplicate-global', `Duplicate global binding: ${binding.name}`);
    globalsByName.set(binding.name, binding);
  }
  for (const binding of options.bindings) {
    const key = `${binding.module}#${binding.name}`;
    if (bindingsByKey.has(key)) report(source, 'duplicate-binding', `Duplicate binding: ${key}`);
    if (binding.members !== undefined && ((binding.kind !== 'component' && binding.kind !== 'value') || !Array.isArray(binding.members)
      || !binding.members.length || binding.members.some(name => typeof name !== 'string' || !name.length)
      || new Set(binding.members).size !== binding.members.length)) {
      report(source, binding.kind === 'value' ? 'value-members' : 'component-members', `Dependency namespace ${key} requires a nonempty list of unique member names.`);
      continue;
    }
    if ((binding.kind === 'value' && !validValueType(binding.valueType))
      || (binding.valueType !== undefined && binding.kind !== 'value')) {
      report(source, 'value-type', `Value binding ${key} requires an explicit platform value type.`);
      continue;
    }
    if (binding.componentType !== undefined) {
      const type = binding.componentType;
      if (binding.kind !== 'component' || !type || typeof type !== 'object'
        || typeof type.module !== 'string' || !type.module.trim()
        || typeof type.name !== 'string' || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(type.name)
        || (type.member !== undefined && (typeof type.member !== 'string' || !type.member.length))) {
        report(source, 'component-type', `Component type ${key} requires a type module, exported identifier and optional literal member.`);
        continue;
      }
    }
    bindingsByKey.set(key, binding);
  }
  // Imports are hoisted, including imports written after a component declaration.
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const clause = statement.importClause;
    if (!clause || clause.isTypeOnly) continue;
    const add = (local: ts.Identifier, name: string) => {
      const symbol = checker.getSymbolAtLocation(local);
      if (symbol) imported.set(symbol, { module: (statement.moduleSpecifier as ts.StringLiteral).text, name, local: local.text, node: local });
    };
    if (clause.name) add(clause.name, 'default');
    if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const item of clause.namedBindings.elements) if (!item.isTypeOnly) add(item.name, (item.propertyName ?? item.name).text);
    } else if (clause.namedBindings) add(clause.namedBindings.name, '*');
  }
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement)) {
      moduleFunctions.add(statement);
      if (statement.modifiers?.some(item => item.kind === ts.SyntaxKind.ExportKeyword)) {
        const key = statement.modifiers.some(item => item.kind === ts.SyntaxKind.DefaultKeyword) ? 'default' : statement.name?.text;
        if (key) exported.set(key, statement);
      }
    } else if (ts.isVariableStatement(statement)) {
      if (statement.declarationList.flags & ts.NodeFlags.Const) {
        for (const declaration of statement.declarationList.declarations) {
          const initializer = declaration.initializer && componentInitializer(declaration.initializer);
          const fn = initializer && initializer.fn;
          if (fn && ts.isIdentifier(declaration.name)) {
            moduleFunctions.add(fn);
            functionVariables.set(fn, declaration);
            variableFunctions.set(declaration, fn);
            if (initializer.factory) factoryFunctions.set(fn, initializer.factory);
          }
        }
      }
      if (statement.modifiers?.some(item => item.kind === ts.SyntaxKind.ExportKeyword)) {
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name)) exported.set(declaration.name.text, declaration);
          else if (options.factoryModuleState) for (const name of bindingNames(declaration.name)) exported.set(name.text, name);
        }
      }
    } else if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      if (!statement.importClause) {
        report(statement, 'side-effect-import', 'Side-effect imports need an explicit platform adapter.');
        continue;
      }
      const clause = statement.importClause;
      if (clause.isTypeOnly) continue;
    } else if (!ts.isVariableStatement(statement) && !ts.isInterfaceDeclaration(statement) && !ts.isTypeAliasDeclaration(statement)
      && !typeOnlyNamespace(statement)
      && !ts.isExportDeclaration(statement) && !(ts.isExpressionStatement(statement) && ts.isStringLiteral(statement.expression))) {
      if (options.factoryModuleState && moduleEffect(statement)) moduleStatements.add(statement);
      else report(statement, 'module-statement', 'This module statement needs platform review; it cannot be dropped by declaration selection.');
    }
  }
  // A local named export is another public name for the same declaration.
  // Resolve its symbol rather than cloning the component or importing a new
  // adapter. Re-exports and type-only exports retain their existing boundary.
  for (const statement of source.statements) {
    if (!ts.isExportDeclaration(statement) || statement.moduleSpecifier || statement.isTypeOnly
      || !statement.exportClause || !ts.isNamedExports(statement.exportClause)) continue;
    for (const specifier of statement.exportClause.elements) {
      if (specifier.isTypeOnly) continue;
      const symbol = checker.getExportSpecifierLocalTargetSymbol(specifier);
      const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
      if (declaration && ts.isFunctionDeclaration(declaration) && moduleFunctions.has(declaration)) {
        exported.set(specifier.name.text, declaration);
      } else if (declaration && ts.isVariableDeclaration(declaration)) {
        exported.set(specifier.name.text, declaration);
      } else if (options.factoryModuleState && declaration && ts.isBindingElement(declaration) && moduleVariable(declaration)) {
        exported.set(specifier.name.text, declaration.name as ts.Identifier);
      } else if (declaration && ts.isImportSpecifier(declaration) && !declaration.isTypeOnly) {
        exported.set(specifier.name.text, declaration.name);
      } else if (declaration && ts.isImportClause(declaration) && !declaration.isTypeOnly && declaration.name) {
        exported.set(specifier.name.text, declaration.name);
      } else if (declaration && ts.isNamespaceImport(declaration)) {
        exported.set(specifier.name.text, declaration.name);
      }
    }
  }
  const selected = new Set<SourceFunction>();
  const components = new Set<SourceFunction>();
  const helpers = new Map<string, HelperSignature>();
  const constants = new Set<ts.VariableStatement>();
  const imports = new Map<string, ImportBinding & { local: string }>();
  const intrinsics = new Set<string>();
  const variants = new Map<ts.CallExpression, VariantMetadata>();
  const staticConstants = new Set<ts.VariableDeclaration>();
  let needsRest = false;
  let needsFragment = false;
  let needsJsxProps = false;
  const jsxCalls = new Set<ts.CallExpression>();
  const jsxChildren = new Set<ts.Expression>();
  const jsxHostChildren = new Set<ts.Expression>();
  const jsxTags = new Set<ts.Expression>();
  const jsxFragments = new Set<ts.Node>();
  const booleanCalls = new Set<ts.CallExpression>();
  const typeofExpressions = new Set<ts.TypeOfExpression>();
  const stringCalls = new Map<ts.CallExpression, StringCall>();
  const styleExpressions = new Map<ts.Expression, { index:number; values?:readonly ts.Expression[] }>();
  const styleObjects: (StyleObject | NumericStyleTemplate)[] = [];
  const numericBuilders = new Map<number,string>();
  const runtimeStyleExpressions = new Set<ts.Expression>();
  const styleNullValues = new Set<ts.Node>();
  const numericAliases = new Set<ts.VariableDeclaration>();
  const numericAliasUses = new Set<ts.Identifier>();
  const styleDeclarations = new Set<ts.VariableDeclaration>();
  const nullValues = new Set<ts.Node>();
  const requested = new Map<string, PublicDeclaration>();
  const allowedTags = new Set(['div', 'span', 'p', 'section', 'main', 'header', 'footer', 'kbd', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'ol','table','thead','tbody','tfoot','tr','th','td','caption']);
  const nativeTags = new Set(options.nativeTags);
  for (const tag of nativeTags) {
    if (!/^[a-z][a-z0-9-]*$/.test(tag)) report(source, 'native-tag', `Invalid source tag: ${tag}`);
    else allowedTags.add(tag);
  }
  function literal(node: ts.Expression, active = new Set<ts.Node>(), declarations?: Set<ts.VariableDeclaration>): unknown {
    if (active.has(node)) throw new Error('Cyclic variant definition');
    active.add(node);
    const child = (value: ts.Expression) => literal(value, new Set(active), declarations);
    if (ts.isStringLiteralLike(node)) return node.text;
    if (ts.isNumericLiteral(node)) return Number(node.text);
    if (node.kind === ts.SyntaxKind.NullKeyword) return null;
    if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) return child(node.expression);
    if (ts.isPrefixUnaryExpression(node) && [ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken].includes(node.operator)) {
      const value = child(node.operand);
      if (typeof value !== 'number') throw new Error('Variant numeric sign requires a number');
      return node.operator === ts.SyntaxKind.MinusToken ? -value : value;
    }
    if (ts.isIdentifier(node)) {
      const symbol = ts.isShorthandPropertyAssignment(node.parent) ? checker.getShorthandAssignmentValueSymbol(node.parent) : checker.getSymbolAtLocation(node);
      const declaration = symbol?.valueDeclaration;
      if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer
        && ts.isVariableDeclarationList(declaration.parent) && declaration.parent.flags & ts.NodeFlags.Const) {
        const value = child(declaration.initializer);
        staticConstants.add(declaration);
        declarations?.add(declaration);
        return value;
      }
      if (!symbol?.declarations?.length && !declaration && node.text === 'undefined') return undefined;
      if (!symbol?.declarations?.length && !declaration && node.text === 'NaN') return NaN;
      if (!symbol?.declarations?.length && !declaration && node.text === 'Infinity') return Infinity;
    }
    if (ts.isArrayLiteralExpression(node)) {
      const values: unknown[] = [];
      for (const item of node.elements) {
        if (ts.isOmittedExpression(item)) values.push(undefined);
        else if (ts.isSpreadElement(item)) {
          const spread = child(item.expression);
          if (!Array.isArray(spread)) throw new Error('Variant array spread requires literal array data');
          values.push(...spread);
        } else values.push(child(item));
      }
      return values;
    }
    if (ts.isObjectLiteralExpression(node)) {
      const result: Record<string, unknown> = Object.create(null);
      for (const item of node.properties) {
        if (ts.isSpreadAssignment(item)) {
          const value = child(item.expression);
          if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Variant object spread requires literal record data');
          Object.assign(result, value);
        } else if (ts.isPropertyAssignment(item) && !ts.isComputedPropertyName(item.name)) {
          if (item.name.text === '__proto__') throw new Error('Prototype mutation is not variant data');
          result[item.name.text] = child(item.initializer);
        } else if (ts.isShorthandPropertyAssignment(item)) {
          const symbol = checker.getShorthandAssignmentValueSymbol(item);
          const declaration = symbol?.valueDeclaration;
          if (!declaration || !ts.isVariableDeclaration(declaration) || !declaration.initializer
            || !ts.isVariableDeclarationList(declaration.parent) || !(declaration.parent.flags & ts.NodeFlags.Const)) throw new Error('Variant shorthand requires a literal const');
          result[item.name.text] = child(declaration.initializer);
          staticConstants.add(declaration);
          declarations?.add(declaration);
        } else throw new Error('Variant definition requires literal property data');
      }
      return result;
    }
    throw new Error('Variant definitions require static literal data');
  }
  function select(fn: SourceFunction, component = false) {
    if (component || factoryFunctions.has(fn)) components.add(fn);
    if (selected.has(fn)) return;
    selected.add(fn);
    if (!functionName(fn) || !fn.body || (!ts.isArrowFunction(fn) && fn.asteriskToken) || fn.modifiers?.some(item => item.kind === ts.SyntaxKind.AsyncKeyword)) {
      report(fn, 'component-shape', 'Expected a named synchronous source function.');
      return;
    }
    const variable = functionVariables.get(fn);
    if (variable) {
      const statement = variable.parent.parent as ts.VariableStatement;
      const first = !constants.has(statement);
      constants.add(statement);
      for (const item of first ? statement.declarationList.declarations : []) {
        const callable = variableFunctions.get(item);
        if (callable && callable !== fn) select(callable);
        else if (!callable && item.initializer) scan(item.initializer);
      }
      function context(node: ts.Node) {
        if (node !== fn && (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isClassLike(node) || ts.isMethodDeclaration(node))) return;
        if (node.kind === ts.SyntaxKind.ThisKeyword || node.kind === ts.SyntaxKind.SuperKeyword || ts.isMetaProperty(node)
          || (ts.isIdentifier(node) && node.text === 'arguments' && !checker.getSymbolAtLocation(node)?.valueDeclaration
            && !(options.values?.arrays && implicitArgumentsOwner(node, checker)))) {
          report(node, 'function-context', 'Source function expressions need an explicit adapter for this, arguments, super or new.target.');
        }
        ts.forEachChild(node, context);
      }
      context(fn);
      if (factoryFunctions.has(fn)) {
        // Preserve the surrounding factory calls and their dependencies, not
        // just the render body. The selected callback is visited below.
        scan(variable.initializer!);
      }
    }
    for (const parameter of fn.parameters) if (ts.isObjectBindingPattern(parameter.name)) {
      for (const item of parameter.name.elements) {
        if (!ts.isIdentifier(item.name) || (item.propertyName && !ts.isIdentifier(item.propertyName) && !ts.isStringLiteral(item.propertyName))) {
          report(item, 'nested-props', 'Nested or computed props destructuring needs a typed adapter.');
        }
        if (item.dotDotDotToken) needsRest = true;
      }
    }
    scan(fn.body);
    for (const parameter of fn.parameters) {
      if (parameter.initializer) scan(parameter.initializer);
      if (!ts.isObjectBindingPattern(parameter.name)) continue;
      for (const item of parameter.name.elements) if (item.initializer) scan(item.initializer);
    }
  }
  function componentReference(expression: ts.Node, active = new Set<ts.Node>()) {
    if (active.has(expression)) return;
    active.add(expression);
    if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) || ts.isSatisfiesExpression(expression)) {
      componentReference(expression.expression, active); return;
    }
    if (ts.isCallExpression(expression)) {
      const role = reactFactory(expression.expression);
      const render = expression.arguments[0];
      if (role && render) {
        const resolve = (node: ts.Node): void => {
          if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) return resolve(node.expression);
          if (ts.isCallExpression(node)) return componentReference(node, active);
          const declaration = ts.isIdentifier(node) ? checker.getSymbolAtLocation(node)?.valueDeclaration : node;
          const fn = declaration && (ts.isFunctionDeclaration(declaration) ? declaration
            : ts.isVariableDeclaration(declaration) ? variableFunctions.get(declaration)
              : ts.isFunctionExpression(declaration) || ts.isArrowFunction(declaration) ? declaration : undefined);
          if (fn && moduleFunctions.has(fn)) {
            // memo takes a component, so wrapping a forwardRef component must
            // retain the inner function's two-argument contract.
            const previous = factoryFunctions.get(fn);
            if (role === 'forwardRef' && previous === 'memo') report(render, 'component-factory-role', 'forwardRef requires a render callback, not an existing memo component.');
            else if (!previous || role === 'forwardRef') {
              factoryFunctions.set(fn, role);
            }
            const props = expression.typeArguments?.[role === 'forwardRef' ? 1 : 0];
            if (factoryFunctions.get(fn) === role && props) factoryProps.set(fn, props);
            select(fn, true);
          } else if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer && !active.has(declaration)) {
            active.add(declaration); resolve(declaration.initializer);
          }
        };
        resolve(render);
      }
      return;
    }
    if (!ts.isIdentifier(expression)) return;
    const declaration = checker.getSymbolAtLocation(expression)?.valueDeclaration;
    if (declaration && ts.isFunctionDeclaration(declaration) && moduleFunctions.has(declaration)) select(declaration, true);
    else if (declaration && ts.isFunctionExpression(declaration) && moduleFunctions.has(declaration)) select(declaration, true);
    else if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer
      && ts.isVariableDeclarationList(declaration.parent) && declaration.parent.flags & ts.NodeFlags.Const) {
      const fn = variableFunctions.get(declaration);
      if (fn) select(fn, true); else componentReference(declaration.initializer, active);
    }
  }
  function reference(identifier: ts.Identifier) {
    const parent = identifier.parent;
    if ((ts.isPropertyAccessExpression(parent) && parent.name === identifier)
      || (ts.isPropertyAssignment(parent) && parent.name === identifier)
      || (ts.isJsxAttribute(parent) && parent.name === identifier)
      || (ts.isBindingElement(parent) && (parent.name === identifier || parent.propertyName === identifier))
      || (ts.isVariableDeclaration(parent) && parent.name === identifier)
      || (ts.isParameter(parent) && parent.name === identifier)
      || (ts.isFunctionDeclaration(parent) && parent.name === identifier)) return;
    const symbol = (ts.isShorthandPropertyAssignment(parent)
      ? checker.getShorthandAssignmentValueSymbol(parent) : checker.getSymbolAtLocation(identifier))
      // Internal executable exports can be intentionally absent from a
      // package's public .d.ts. The checked lexical alias still identifies
      // the explicitly supplied runtime binding, including local shadowing.
      ?? checker.resolveName(identifier.text,identifier,ts.SymbolFlags.Value|ts.SymbolFlags.Type|ts.SymbolFlags.Alias,false);
    if (options.values?.arrays && implicitArgumentsOwner(identifier, checker)) return;
    const dependency = symbol && imported.get(symbol);
    if (dependency) {
      if (dependency.module === 'react/jsx-runtime' || dependency.module === 'react/jsx-dev-runtime') {
        const expression = (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) && parent.expression === identifier ? parent : identifier;
        if (jsxRuntimeExport(expression, checker) === 'Fragment') { needsFragment = true; jsxFragments.add(expression); }
        else report(expression, 'jsx-runtime-use', 'JSX runtime helpers must be called directly; a runtime namespace or helper cannot escape as a value.');
        return;
      }
      const key = `${dependency.module}#${dependency.name}`;
      const binding = bindingsByKey.get(key);
      if (!binding) report(identifier, 'import-adapter', `Missing platform binding for ${key}.`);
      else {
        if (binding.members && ts.isPropertyAccessExpression(parent) && parent.expression === identifier
          && !binding.members.includes(parent.name.text)) {
          report(parent.name, binding.kind === 'value' ? 'value-member' : 'component-member', `Missing platform member ${key}.${parent.name.text}.`);
        }
        if (binding.members && ts.isElementAccessExpression(parent) && parent.expression === identifier) {
          const member = parent.argumentExpression;
          if (!ts.isStringLiteral(member) || !binding.members.includes(member.text)) {
            report(parent, binding.kind === 'value' ? 'value-member' : 'component-member', `Computed lookup in ${key} needs a declared literal member.`);
          }
        }
        if (binding.members && (ts.isJsxOpeningElement(parent) || ts.isJsxSelfClosingElement(parent))) {
          report(identifier, 'component-member', `Component namespace ${key} needs a member, not a direct JSX tag.`);
        }
        imports.set(dependency.local, { ...binding,
          ...(binding.members ? { members: [...binding.members] } : {}),
          ...(binding.componentType ? { componentType: { ...binding.componentType } } : {}),
          ...(binding.valueType ? { valueType: { ...binding.valueType } } : {}), local: dependency.local });
      }
      return;
    }
    const declaration = symbol?.valueDeclaration;
    if (declaration && ts.isFunctionDeclaration(declaration) && moduleFunctions.has(declaration)) {
      select(declaration);
    } else if (declaration && ts.isFunctionExpression(declaration) && moduleFunctions.has(declaration)) {
      select(declaration);
    } else if (declaration && ts.isVariableDeclaration(declaration) && ts.isVariableDeclarationList(declaration.parent)
      && ts.isVariableStatement(declaration.parent.parent) && declaration.parent.parent.parent === source) {
      const statement = declaration.parent.parent;
      if (!(declaration.parent.flags & ts.NodeFlags.Const) && !options.factoryModuleState) report(identifier, 'mutable-module-state', 'Mutable module state needs an explicit ownership adapter.');
      else if (!constants.has(statement)) {
        constants.add(statement);
        for (const item of statement.declarationList.declarations) {
          const fn = variableFunctions.get(item);
          if (fn) select(fn); else if (item.initializer) scan(item.initializer);
        }
      }
    } else if (sourceGlobal(symbol) && identifier.text !== 'undefined') {
      const binding = globalsByName.get(identifier.text);
      if (!binding) report(identifier, 'unbound-value', `No portable binding for ${identifier.text}.`);
      else {
        if (binding.members && ts.isPropertyAccessExpression(parent) && parent.expression === identifier
          && !binding.members.includes(parent.name.text)) {
          report(parent.name, 'value-member', `Missing platform value member ${binding.name}.${parent.name.text}.`);
        }
        if (binding.members && ts.isElementAccessExpression(parent) && parent.expression === identifier
          && (!ts.isStringLiteral(parent.argumentExpression) || !binding.members.includes(parent.argumentExpression.text))) {
          report(parent, 'value-member', `Computed lookup in ${binding.name} needs a declared literal member.`);
        }
        globals.set(binding.name, { ...binding, valueType: { ...binding.valueType },
          ...(binding.members ? { members: [...binding.members] } : {}) });
      }
    }
  }
  function numericType(type:ts.Type):boolean {
    const members=type.isUnion()?type.types:[type];
    return members.some(member=>!!(member.flags&ts.TypeFlags.NumberLike))&&members.every(member=>
      !!(member.flags&(ts.TypeFlags.NumberLike|ts.TypeFlags.BooleanLike|ts.TypeFlags.Undefined|ts.TypeFlags.Null|ts.TypeFlags.Void))
      || (!!(member.flags&ts.TypeFlags.StringLiteral)&&(member as ts.StringLiteralType).value===''));
  }
  // An explicitly typed native React hook preserves its source state type
  // even when React's browser declarations are intentionally absent. Follow
  // only that declared source type, never an inferred any from a missing API.
  function hookType(call: ts.Expression, hook: string): ts.Type | undefined {
    if (!ts.isCallExpression(call) || call.typeArguments?.length !== 1) return undefined;
    const callee = call.expression;
    const root = ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) ? callee.expression
      : ts.isIdentifier(callee) ? callee : undefined;
    const dependency = root && imported.get(checker.getSymbolAtLocation(root)!);
    if (!dependency || dependency.module !== 'react') return undefined;
    const member = ts.isPropertyAccessExpression(callee) ? callee.name.text : dependency.name;
    const binding = bindingsByKey.get(`${dependency.module}#${dependency.name}`);
    if (member !== hook || binding?.kind !== 'value' || binding.members && !binding.members.includes(hook)) return undefined;
    return checker.getTypeFromTypeNode(call.typeArguments[0]!);
  }
  function declaredValueType(expression: ts.Expression, active = new Set<ts.Node>()): ts.Type | undefined {
    if (active.has(expression)) return undefined;
    active.add(expression);
    if (ts.isParenthesizedExpression(expression) || ts.isNonNullExpression(expression)) return declaredValueType(expression.expression, active);
    if (ts.isIdentifier(expression)) {
      const declaration = checker.getSymbolAtLocation(expression)?.valueDeclaration;
      if (declaration && ts.isBindingElement(declaration) && ts.isArrayBindingPattern(declaration.parent)
        && declaration.parent.elements[0] === declaration && ts.isVariableDeclaration(declaration.parent.parent)) {
        const initializer = declaration.parent.parent.initializer;
        return initializer && hookType(initializer, 'useState');
      }
      if (declaration && ts.isVariableDeclaration(declaration)) {
        if (declaration.type) return checker.getTypeFromTypeNode(declaration.type);
        if (declaration.initializer) return declaredValueType(declaration.initializer, active);
      }
    }
    if (ts.isPropertyAccessExpression(expression)) {
      if (expression.name.text === 'current' && ts.isIdentifier(expression.expression)) {
        const declaration = checker.getSymbolAtLocation(expression.expression)?.valueDeclaration;
        if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer) {
          const value = hookType(declaration.initializer, 'useRef');
          if (value) return value;
        }
      }
      const owner = declaredValueType(expression.expression, active);
      const property = owner && checker.getPropertyOfType(checker.getNonNullableType(owner), expression.name.text);
      if (property) return checker.getTypeOfSymbolAtLocation(property, property.valueDeclaration ?? expression);
    }
    const type = checker.getTypeAtLocation(expression);
    return type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown) ? undefined : type;
  }
  function sourceNumber(expression: ts.Expression, nullish = false): boolean {
    if (ts.isParenthesizedExpression(expression)) return sourceNumber(expression.expression, nullish);
    if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
      return sourceNumber(expression.left, true) && sourceNumber(expression.right, nullish);
    if (ts.isConditionalExpression(expression)) return sourceNumber(expression.whenTrue, nullish) && sourceNumber(expression.whenFalse, nullish);
    if (ts.isPropertyAccessChain(expression) && !nullish) return false;
    const type = declaredValueType(expression);
    return !!type && (type.isUnion() ? type.types : [type]).every(member =>
      !!(member.flags & ts.TypeFlags.NumberLike)
      || nullish && !!(member.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void)));
  }
  function numericObject(node:ts.ObjectLiteralExpression) {
    const styles:Record<string,Parameters<typeof compileStyleObject>[0][string]>=Object.create(null);
    const bindings=new Map<string,{argument:number;unit?:string}>();
    const values:ts.Expression[]=[];
    const keys:number[]=[];
    const declarations=new Set<ts.VariableDeclaration>();
    function assign(name:string,expression:ts.Expression) {
      const dependencies=new Set<ts.VariableDeclaration>();
      try {
        styles[name]=literal(expression,new Set(),dependencies) as typeof styles[string];
        bindings.delete(name);
        for(const declaration of dependencies)declarations.add(declaration);
      } catch {
        const template=numericTemplateValue(expression,checker,sourceNumber);
        if(!template&&!numericType(checker.getTypeAtLocation(expression)))throw Error(`Style value needs a numeric type, one numeric unit template or static value: ${name}`);
        bindings.set(name,{argument:values.length,...(template?{unit:template.unit}:{})});
        values.push(template?.value??expression);styles[name]=template?`1${template.unit}`:1;
      }
    }
    for(const item of node.properties) {
      if(ts.isSpreadAssignment(item)) {
        const value=literal(item.expression,new Set(),declarations);
        if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Style spread needs a static property record');
        for(const[name,setting]of Object.entries(value)){styles[name]=setting as typeof styles[string];bindings.delete(name)}
      } else if(ts.isPropertyAssignment(item)) {
        if(ts.isComputedPropertyName(item.name)) {
          let expression=item.name.expression;
          while(ts.isParenthesizedExpression(expression)||ts.isAsExpression(expression)||ts.isSatisfiesExpression(expression))expression=expression.expression;
          const type=checker.getTypeAtLocation(expression);
          if(!(type.flags&ts.TypeFlags.StringLiteral))throw Error('Computed style keys require one checked literal string name.');
          const name=(type as ts.StringLiteralType).value;
          keys.push(values.length);
          // Retain the key read/call in source order, including errors. The
          // prepared builder checks that the native binding keeps its name.
          values.push(ts.factory.createBinaryExpression(item.name.expression,ts.SyntaxKind.EqualsEqualsEqualsToken,ts.factory.createStringLiteral(name)));
          assign(name,item.initializer);
        }else assign(item.name.text,item.initializer);
      }
      else if(ts.isShorthandPropertyAssignment(item))assign(item.name.text,item.name);
      else throw Error('Style keys require static property names');
    }
    const index=styleObjects.length;
    const packet=values.length?compileNumericStyle(styles,[...bindings].map(([name,binding])=>({name,...binding})),values.length,{from:filename,keys}):compileStyleObject(styles,{from:filename});
    styleExpressions.set(node,{index,...(values.length?{values}:{})});styleObjects.push(packet);
    if(values.length)numericBuilders.set(index,fresh('__cssNumericStyle'));
    for(const declaration of declarations)styleDeclarations.add(declaration);
    for(const value of values) {
      runtimeStyleExpressions.add(value);
      // Only a null result means "clear". Null passed to another operation
      // still needs its own platform representation.
      const mark=(child:ts.Expression):void=>{
        if(child.kind===ts.SyntaxKind.NullKeyword)styleNullValues.add(child);
        else if(ts.isParenthesizedExpression(child)||ts.isAsExpression(child)||ts.isSatisfiesExpression(child))mark(child.expression);
        else if(ts.isConditionalExpression(child)){mark(child.whenTrue);mark(child.whenFalse)}
        else if(ts.isBinaryExpression(child)&&[ts.SyntaxKind.AmpersandAmpersandToken,ts.SyntaxKind.BarBarToken,ts.SyntaxKind.QuestionQuestionToken].includes(child.operatorToken.kind)){mark(child.left);mark(child.right)}
      };mark(value);
      scan(value);
    }
  }
  function numericAlias(node:ts.Identifier,active=new Set<ts.VariableDeclaration>()):boolean {
    const declaration=(ts.isShorthandPropertyAssignment(node.parent) ? checker.getShorthandAssignmentValueSymbol(node.parent) : checker.getSymbolAtLocation(node))?.valueDeclaration;
    if(!declaration||!ts.isVariableDeclaration(declaration)||!declaration.initializer||!ts.isVariableDeclarationList(declaration.parent)
      ||!(declaration.parent.flags&ts.NodeFlags.Const)||active.has(declaration))return false;
    active.add(declaration);
    let initializer=declaration.initializer;
    while(ts.isParenthesizedExpression(initializer)||ts.isAsExpression(initializer)||ts.isSatisfiesExpression(initializer))initializer=initializer.expression;
    if(ts.isObjectLiteralExpression(initializer)) {
      if(!styleExpressions.has(initializer))numericObject(initializer);
    } else if(ts.isIdentifier(initializer)) {
      if(!numericAlias(initializer,active))return false;
    } else return false;
    numericAliases.add(declaration);numericAliasUses.add(node);
    return true;
  }
  function styleExpression(node: ts.Expression) {
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) {
      styleExpression(node.expression); return;
    }
    if (ts.isConditionalExpression(node)) { styleExpression(node.whenTrue); styleExpression(node.whenFalse); return; }
    if (ts.isBinaryExpression(node) && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(node.operatorToken.kind)) {
      styleExpression(node.right); return;
    }
    let value: unknown;
    const declarations = new Set<ts.VariableDeclaration>();
    try { value = literal(node, new Set(), declarations); }
    catch (error) {
      try {
        if(ts.isObjectLiteralExpression(node)){numericObject(node);return}
        if(ts.isIdentifier(node)&&numericAlias(node))return;
      }catch(dynamicError){
        // The opted-in native style boundary accepts ordinary mutable records.
        // Keep dynamic CSS values/spreads intact for its real normalization.
        if(options.runtimeStyleRecords)return;
        report(node,'style-object',(dynamicError as Error).message);return;
      }
      if (ts.isObjectLiteralExpression(node)) report(node, 'style-object', `Style object needs static values: ${(error as Error).message}`);
      return; // A forwarded packet is validated by the runtime adapter.
    }
    if (value === undefined) return;
    try {
      const packet = compileStyleObject(value === null ? {} : value as Parameters<typeof compileStyleObject>[0], { from: filename });
      styleExpressions.set(node, {index:styleObjects.length});
      styleObjects.push(packet);
      for (const declaration of declarations) styleDeclarations.add(declaration);
    } catch (error) { report(node, 'style-object', (error as Error).message); }
  }
  function scan(node: ts.Node) {
    if (ts.isTypeNode(node) || ts.isTypeParameterDeclaration(node)) return;
    if (selected.has(node as SourceFunction)) return;
    if ((ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) && !scalarString(node.text)) {
      report(node,'unicode-string','Runtime string literals require Unicode scalar values; lone surrogate code units need a platform representation.');
    }
    if (ts.isCallExpression(node)) {
      const runtime = jsxRuntimeExport(node.expression, checker);
      if (runtime === 'jsx' || runtime === 'jsxs' || runtime === 'jsxDEV') {
        if (node.questionDotToken || node.arguments.length < 2 || node.arguments.length > (runtime === 'jsxDEV' ? 6 : 3) || node.arguments.some(ts.isSpreadElement)) {
          report(node, 'jsx-runtime-call', 'Published JSX calls require a tag, an ordinary props object, and an optional key (plus development metadata for jsxDEV).');
          return;
        }
        jsxCalls.add(node);
        const tag = node.arguments[0]!, props = node.arguments[1]!;
        jsxTags.add(tag);
        if(options.staticSvg&&ts.isStringLiteralLike(tag)&&tag.text==='svg'){
          if(!nativeTags.has('svg'))report(tag,'static-svg-adapter','Static SVG assets require an explicit svg host adapter.');
          try{
            const compiled=compileStaticSvg(node,source,options.staticSvg,checker);
            svgElements.set(node,compiled);intrinsics.add('svg');
            for(const property of (compiled.spreadProps??compiled.props)!.properties){
              if(ts.isSpreadAssignment(property)){scan(property.expression);continue;}
              if(!ts.isPropertyAssignment(property)&&!ts.isShorthandPropertyAssignment(property))continue;
              const value=ts.isPropertyAssignment(property)?property.initializer:property.name;
              if(!ts.isComputedPropertyName(property.name)&&property.name.text==='style')styleExpression(value);else scan(value);
            }
            if(node.arguments.length>2)needsJsxProps=true;
            for(const argument of node.arguments.slice(2))scan(argument);
          }catch(error){report(node,'static-svg',(error as Error).message);}
          return;
        }
        const fragmentTag = jsxRuntimeExport(tag, checker) === 'Fragment' || (ts.isIdentifier(tag) || ts.isPropertyAccessExpression(tag)) && reactFragment(tag);
        const hostTag = ts.isStringLiteralLike(tag) ? tag.text : undefined;
        if (fragmentTag) { needsFragment = true; jsxFragments.add(tag); }
        else if (hostTag !== undefined) {
          if (!allowedTags.has(hostTag)) report(tag, 'intrinsic-adapter', `The ${hostTag} element needs a native behavior or rendering adapter.`);
          else intrinsics.add(hostTag);
          scan(tag);
        } else { componentReference(tag); scan(tag); }
        let config = props;
        while (ts.isParenthesizedExpression(config)) config = config.expression;
        if (config.kind === ts.SyntaxKind.NullKeyword || ts.isIdentifier(config) && config.text === 'undefined')
          report(config, 'jsx-runtime-props', 'Published JSX requires an ordinary props object.');
        if (ts.isObjectLiteralExpression(config)) for (const property of config.properties) {
          if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) continue;
          const name = ts.isComputedPropertyName(property.name)
            ? ts.isStringLiteral(property.name.expression) ? property.name.expression.text : undefined : property.name.text;
          const value = ts.isPropertyAssignment(property) ? property.initializer : property.name;
          if (name === 'style') styleExpression(value);
          if (name === 'children') { jsxChildren.add(value); if (fragmentTag || hostTag !== undefined) jsxHostChildren.add(value); }
          if ((name === 'ref' || name?.startsWith('on')) && hostTag !== undefined && !nativeTags.has(hostTag))
            report(property, 'host-prop-adapter', `${name} needs a host adapter; it cannot be forwarded as a CSS attribute.`);
        }
        scan(props);
        if (node.arguments.length > 2) needsJsxProps = true;
        for (const argument of node.arguments.slice(2)) scan(argument);
        return;
      }
    }
    if (options.staticSvg && (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node))) {
      const opening = ts.isJsxElement(node) ? node.openingElement : node;
      if (ts.isIdentifier(opening.tagName) && opening.tagName.text === 'svg') {
        if (!nativeTags.has('svg')) report(opening, 'static-svg-adapter', 'Static SVG assets require an explicit svg host adapter.');
        try {
          const compiled = compileStaticSvg(node, source, options.staticSvg);
          svgElements.set(node, compiled);
          intrinsics.add('svg');
          for (const attribute of compiled.attributes) {
            if (attribute.name.getText(source) === 'style' && attribute.initializer && ts.isJsxExpression(attribute.initializer)
              && attribute.initializer.expression) styleExpression(attribute.initializer.expression);
            else if (attribute.initializer) scan(attribute.initializer);
          }
          for(const attribute of compiled.rootAttributes??[])if(ts.isJsxSpreadAttribute(attribute))scan(attribute.expression);
        } catch (error) { report(opening, 'static-svg', (error as Error).message); }
        return;
      }
    }
    if (styleExpressions.has(node as ts.Expression)) return;
    if (ts.isTypeOfExpression(node)) typeofExpressions.add(node);
    if (ts.isCallExpression(node)) {
      if (reactFactory(node.expression)) componentReference(node);
      const call=stringCall(node,checker);
      if(call) {
        if(!validStringArguments(node,call)) {
          report(node,'string-method-call',`String ${call.method} calls require ${call.method === 'slice' ? 'zero to two' : 'one or two'} ordinary arguments and a direct primitive-string receiver.`);
        } else stringCalls.set(node,call);
      }
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const symbol = checker.getSymbolAtLocation(node.expression);
      if (node.expression.text === 'Boolean' && !symbol?.declarations?.length && !symbol?.valueDeclaration && !globalsByName.has('Boolean')) {
        if (node.arguments.length > 1 || node.arguments.some(ts.isSpreadElement)) {
          report(node, 'boolean-arguments', 'Boolean coercion supports zero or one non-spread argument.');
        } else booleanCalls.add(node);
        for (const argument of node.arguments) scan(argument);
        return;
      }
      const dependency = symbol && imported.get(symbol);
      const binding = dependency && bindingsByKey.get(`${dependency.module}#${dependency.name}`);
      if (binding?.kind === 'variants') {
        reference(node.expression);
        try {
          if (node.arguments.length > 2) throw new Error('Variant factories take base classes and an optional config');
          variants.set(node, compileVariants(node.arguments[0] ? literal(node.arguments[0]) : undefined,
            node.arguments[1] ? literal(node.arguments[1]) : undefined));
        } catch (error) { report(node, 'variant-definition', (error as Error).message); }
        return;
      }
    }
    if (ts.isTaggedTemplateExpression(node)) report(node, 'tagged-template-adapter', 'Tagged template behavior needs a platform adapter.');
    if (node.kind === ts.SyntaxKind.NullKeyword) nullValues.add(node);
    if (ts.isJsxFragment(node)) needsFragment = true;
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName;
      if (reactFragment(tag)) needsFragment = true;
      else if (ts.isIdentifier(tag) && /^[a-z]/.test(tag.text)) {
        if (!allowedTags.has(tag.text)) report(tag, 'intrinsic-adapter', `The ${tag.text} element needs a native behavior or rendering adapter.`);
        else intrinsics.add(tag.text);
      } else { componentReference(tag); scan(tag); }
      for (const attribute of node.attributes.properties) {
        if (ts.isJsxAttribute(attribute)) {
          const name = attribute.name.getText(source);
          if (name === 'style' && attribute.initializer && ts.isJsxExpression(attribute.initializer) && attribute.initializer.expression) {
            styleExpression(attribute.initializer.expression);
          }
          if ((name === 'ref' || name.startsWith('on')) && ts.isIdentifier(tag) && /^[a-z]/.test(tag.text) && !nativeTags.has(tag.text)) {
            report(attribute, 'host-prop-adapter', `${name} needs a host adapter; it cannot be forwarded as a CSS attribute.`);
          }
          if (attribute.initializer) scan(attribute.initializer);
        } else scan(attribute.expression);
      }
      return;
    }
    if (ts.isJsxClosingElement(node)) return;
    if (ts.isIdentifier(node)) reference(node);
    ts.forEachChild(node, scan);
  }
  function portableAlias(expression: ts.Expression, active = new Set<ts.Node>()): boolean {
    if (active.has(expression)) return false;
    active.add(expression);
    if (ts.isCallExpression(expression) && reactFactory(expression.expression)) return true;
    if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) || ts.isSatisfiesExpression(expression)) return portableAlias(expression.expression, active);
    if ((ts.isFunctionExpression(expression) || ts.isArrowFunction(expression)) && moduleFunctions.has(expression)) return true;
    if (ts.isCallExpression(expression)) return boundFactory(expression.expression);
    if (ts.isObjectLiteralExpression(expression) && options.values?.records) return true;
    if (ts.isArrayLiteralExpression(expression) && options.values?.arrays) return true;
    if (ts.isStringLiteralLike(expression) || ts.isNumericLiteral(expression)
      || expression.kind === ts.SyntaxKind.TrueKeyword || expression.kind === ts.SyntaxKind.FalseKeyword
      || expression.kind === ts.SyntaxKind.NullKeyword) return true;
    if (ts.isIdentifier(expression)) {
      const symbol = checker.getSymbolAtLocation(expression);
      const importedValue = symbol && imported.get(symbol);
      if (importedValue) {
        const binding = bindingsByKey.get(`${importedValue.module}#${importedValue.name}`);
        return binding?.kind === 'component' || binding?.kind === 'value';
      }
      const declaration = symbol?.valueDeclaration;
      const bound = options.factoryModuleState && declaration && ts.isBindingElement(declaration) ? moduleVariable(declaration) : undefined;
      if (bound && bound.initializer && ts.isVariableDeclarationList(bound.parent) && bound.parent.flags & ts.NodeFlags.Const) return true;
      if (declaration && ts.isFunctionDeclaration(declaration)) return moduleFunctions.has(declaration);
      return !!declaration && ts.isVariableDeclaration(declaration) && !!declaration.initializer
        && ts.isVariableDeclarationList(declaration.parent) && !!(declaration.parent.flags & ts.NodeFlags.Const)
        && portableAlias(declaration.initializer, active);
    }
    if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
      if (!ts.isIdentifier(expression.expression)) return false;
      const symbol = checker.getSymbolAtLocation(expression.expression);
      const importedValue = symbol && imported.get(symbol);
      const binding = importedValue && bindingsByKey.get(`${importedValue.module}#${importedValue.name}`);
      const member = ts.isPropertyAccessExpression(expression) ? expression.name.text
        : ts.isStringLiteral(expression.argumentExpression) ? expression.argumentExpression.text : undefined;
      return !!binding && member !== undefined
        && (binding.members ? binding.members.includes(member) : binding.kind === 'value');
    }
    return false;
  }
  // Calling an injected, checked value is already supported inside selected
  // declarations. A public const can retain that initialization too; it runs
  // once in create(), never once per render. Component namespaces are not data
  // factories, and unbound/global calls are not made portable by this rule.
  function boundFactory(expression: ts.Expression, active = new Set<ts.Node>()): boolean {
    if (active.has(expression)) return false;
    active.add(expression);
    if (ts.isIdentifier(expression)) {
      const symbol = checker.getSymbolAtLocation(expression);
      const dependency = symbol && imported.get(symbol);
      if (dependency) {
        const kind = bindingsByKey.get(`${dependency.module}#${dependency.name}`)?.kind;
        return kind === 'value' || kind === 'variants' || kind === 'className';
      }
      const declaration = symbol?.valueDeclaration;
      return !!declaration && ts.isVariableDeclaration(declaration) && !!declaration.initializer
        && ts.isVariableDeclarationList(declaration.parent) && !!(declaration.parent.flags & ts.NodeFlags.Const)
        && boundFactory(declaration.initializer, active);
    }
    if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
      if (!ts.isIdentifier(expression.expression)) return false;
      const symbol = checker.getSymbolAtLocation(expression.expression);
      const dependency = symbol && imported.get(symbol);
      const binding = dependency && bindingsByKey.get(`${dependency.module}#${dependency.name}`);
      const member = ts.isPropertyAccessExpression(expression) ? expression.name.text
        : ts.isStringLiteral(expression.argumentExpression) ? expression.argumentExpression.text : undefined;
      // An omitted member allowlist means the injected value's declared native
      // type owns member checking, just as it does for ordinary value reads.
      return binding?.kind === 'value' && member !== undefined
        && (!binding.members || binding.members.includes(member));
    }
    return false;
  }
  for (const name of options.exports) {
    const declaration = exported.get(name);
    if (!declaration) report(source, 'missing-export', `No portable component export named ${name}.`);
    else if (ts.isFunctionDeclaration(declaration)) {
      // Exported hooks and utility functions in a JSX module retain ordinary
      // function signatures. JSX references/factories still explicitly select
      // their targets as components; returned JSX is recognized below.
      requested.set(name, declaration); select(declaration, /^[A-Z]/.test(declaration.name?.text ?? ''));
    } else if (ts.isIdentifier(declaration)) {
      if (!portableAlias(declaration)) report(declaration, 'export-adapter', `Export ${name} requires a bound component or value.`);
      else { requested.set(name, declaration); componentReference(declaration); reference(declaration); }
    } else if (!ts.isIdentifier(declaration.name) || !declaration.initializer
      || !ts.isVariableDeclarationList(declaration.parent) || !(declaration.parent.flags & ts.NodeFlags.Const)
      || !portableAlias(declaration.initializer)) {
      report(declaration, 'export-adapter', `Export ${name} requires a const alias or a declared injected value factory.`);
    } else {
      requested.set(name, declaration);
      const fn = variableFunctions.get(declaration);
      if (fn) select(fn, /^[A-Z]/.test((declaration.name as ts.Identifier).text)); else componentReference(declaration.initializer);
      const statement = declaration.parent.parent as ts.VariableStatement;
      if (!constants.has(statement)) {
        constants.add(statement);
        for (const item of statement.declarationList.declarations) {
          const callable = variableFunctions.get(item);
          if (callable) select(callable); else if (item.initializer) scan(item.initializer);
        }
      }
    }
  }
  if (!options.exports.length) report(source, 'missing-export', 'Select at least one component export.');
  if (options.factoryModuleState) {
    // A project factory owns the whole module, including unused initializers
    // with effects and trailing development metadata writes. Only imports and
    // type-only declarations disappear; executable source order is retained.
    for (const statement of source.statements) {
      if (ts.isFunctionDeclaration(statement) && statement.body) select(statement);
      else if (ts.isVariableStatement(statement)) {
        if (!constants.has(statement)) {
          constants.add(statement);
          for (const declaration of statement.declarationList.declarations) {
            const fn = variableFunctions.get(declaration);
            if (fn) select(fn); else if (declaration.initializer) scan(declaration.initializer);
          }
        }
        for (const declaration of statement.declarationList.declarations) if (!ts.isIdentifier(declaration.name)) scan(declaration.name);
      } else if (moduleStatements.has(statement)) scan(statement);
      const synchronous = (node: ts.Node): void => {
        if (ts.isFunctionLike(node)) return;
        if (ts.isAwaitExpression(node) || ts.isForOfStatement(node) && node.awaitModifier)
          report(node, 'module-async-initializer', 'Top-level await requires an asynchronous module owner.');
        ts.forEachChild(node, synchronous);
      };
      synchronous(statement);
    }
  }
  function propsParameter(parameter: ts.ParameterDeclaration): boolean {
    if (ts.isObjectBindingPattern(parameter.name)) return true;
    if (!ts.isIdentifier(parameter.name)) return false;
    const type = checker.getTypeAtLocation(parameter);
    const parts = type.isUnion() ? type.types : [type];
    return parts.every(part => !(part.flags & (ts.TypeFlags.StringLike | ts.TypeFlags.NumberLike | ts.TypeFlags.BooleanLike
      | ts.TypeFlags.BigIntLike | ts.TypeFlags.ESSymbolLike | ts.TypeFlags.Null | ts.TypeFlags.Void | ts.TypeFlags.Never))
      && !checker.isArrayType(part) && !checker.isTupleType(part) && !part.getCallSignatures().length);
  }
  function returnsUi(fn: SourceFunction): boolean {
    // A checked React element return contract also covers components which
    // delegate element construction to a source render helper.
    if (fn.type && (ts.isTypeReferenceNode(fn.type) && reactType(fn.type) === 'Element'
      || ts.isImportTypeNode(fn.type) && ts.isLiteralTypeNode(fn.type.argument) && ts.isStringLiteral(fn.type.argument.literal)
        && fn.type.argument.literal.text === 'react' && fn.type.qualifier && ts.isIdentifier(fn.type.qualifier)
        && fn.type.qualifier.text === 'ReactElement')) return true;
    function result(node: ts.Expression, seen = new Set<ts.Node>()): boolean {
      if (seen.has(node)) return false;
      seen.add(node);
      if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node)) return true;
      if (ts.isCallExpression(node) && (jsxCalls.has(node) || reactCreateElement(node.expression,checker))) return true;
      if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) return result(node.expression, seen);
      if (ts.isConditionalExpression(node)) return result(node.whenTrue, new Set(seen)) || result(node.whenFalse, new Set(seen));
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) return result(node.right, seen);
      if (ts.isBinaryExpression(node) && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(node.operatorToken.kind)) {
        return result(node.left, new Set(seen)) || result(node.right, new Set(seen));
      }
      if (ts.isIdentifier(node)) {
        const declaration = checker.getSymbolAtLocation(node)?.valueDeclaration;
        return !!declaration && ts.isVariableDeclaration(declaration) && !!declaration.initializer && result(declaration.initializer, seen);
      }
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        const symbol = checker.getSymbolAtLocation(node.expression);
        const dependency = symbol && imported.get(symbol);
        return !!dependency && bindingsByKey.get(`${dependency.module}#${dependency.name}`)?.kind === 'render';
      }
      return false;
    }
    let found = false;
    function visit(node: ts.Node) {
      if (ts.isFunctionLike(node)) return;
      if (ts.isReturnStatement(node) && node.expression && result(node.expression)) found = true;
      if (!found) ts.forEachChild(node, visit);
    }
    if (fn.body && !ts.isBlock(fn.body)) return result(fn.body);
    if (fn.body) visit(fn.body);
    return found;
  }
  const genericComponents = new Map<SourceFunction, { parameters: readonly ts.TypeParameterDeclaration[]; props?: ts.TypeNode }>();
  function sourceOwnedProps(type: ts.TypeNode): boolean {
    if (ts.isParenthesizedTypeNode(type)) return sourceOwnedProps(type.type);
    if (ts.isUnionTypeNode(type) || ts.isIntersectionTypeNode(type)) return type.types.some(sourceOwnedProps);
    if (ts.isTypeReferenceNode(type)) {
      const reference = checker.getSymbolAtLocation(type.typeName);
      const symbol = reference && reference.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(reference) : reference;
      return symbol?.declarations?.some(declaration => !declaration.getSourceFile().isDeclarationFile) ?? false;
    }
    return true;
  }
  for (const fn of selected) {
    if (fn.parameters.length <= 1 && fn.parameters.every(propsParameter) && returnsUi(fn)) components.add(fn);
    if (components.has(fn)) {
      if (fn.typeParameters?.length) {
        const projection = createTypeProjection(checker, fn.typeParameters, projectedValueType, trustedDeclaration,false,undefined,filename,standardLibraryFile,options.reactInference===true);
        try {
          const parameters = fn.typeParameters.map(parameter => ts.factory.createTypeParameterDeclaration(undefined, parameter.name.text,
            parameter.constraint && projection.data(parameter.constraint), parameter.default && projection.data(parameter.default)));
          // Source-owned props retain their generic relationships. Browser or
          // library props keep the same checked host boundary as other components.
          let props: ts.TypeNode | undefined;
          const annotation = fn.parameters[0]?.type;
          if (annotation) {
            try { props = projection.data(annotation); }
            catch (error) { if (sourceOwnedProps(annotation)) report(annotation, 'component-type', (error as Error).message); }
          }
          genericComponents.set(fn, { parameters, ...(props ? { props } : {}) });
        } catch (error) { report(fn, 'component-type', (error as Error).message); }
      }
      const forwarded = factoryFunctions.get(fn) === 'forwardRef';
      if (fn.parameters.length > (forwarded ? 2 : 1) || fn.parameters.some((p, i) => p.dotDotDotToken || p.initializer
        || (forwarded && i === 1 ? !ts.isIdentifier(p.name) : !propsParameter(p)))) {
        report(fn, 'component-parameters', forwarded
          ? 'A forwardRef render callback supports props and an optional identifier ref parameter.'
          : 'A component supports one props parameter or no parameters.');
      }
    } else if (functionName(fn) && fn.body) {
      try {
        if (fn.parameters.some(p => !ts.isIdentifier(p.name) && !ts.isObjectBindingPattern(p.name))) throw new Error('Helper parameters currently require identifier or object bindings.');
        helpers.set(functionName(fn)!, helperSignature(fn, checker,projectedValueType,trustedDeclaration,
          Boolean(options.sourceResolution?.dynamicProperties || options.values?.dynamicProperties),inferredValueType,standardLibraryFile,options.reactInference===true));
      } catch (error) { report(fn, 'helper-type', (error as Error).message); }
    }
  }
  // A literal style alias is replaced by its packet. Remove its initializer
  // only when every value reference is covered by styles or another removed
  // alias; an ordinary use must keep its original representation and checks.
  const removedStyles = new Set(styleDeclarations);
  const references = new Map<ts.VariableDeclaration, ts.Identifier[]>();
  function styleReferences(node: ts.Node) {
    if (ts.isTypeNode(node)) return;
    if (ts.isIdentifier(node) && !(ts.isVariableDeclaration(node.parent) && node.parent.name === node)
      && !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)
      && !(ts.isPropertyAssignment(node.parent) && node.parent.name === node)) {
      const symbol = ts.isShorthandPropertyAssignment(node.parent) ? checker.getShorthandAssignmentValueSymbol(node.parent) : checker.getSymbolAtLocation(node);
      const declaration = symbol?.valueDeclaration;
      if (declaration && ts.isVariableDeclaration(declaration) && (styleDeclarations.has(declaration)||numericAliases.has(declaration))) {
        const values = references.get(declaration) ?? []; values.push(node); references.set(declaration, values);
      }
    }
    ts.forEachChild(node, styleReferences);
  }
  styleReferences(source);
  if (options.runtimeStyleRecords) {
    // A mutated/escaping source object cannot be replaced with its initial
    // packet. Keep the source object and let the selected native style-record
    // adapter normalize its current contents when the element is rendered.
    const mutable = new Set<ts.VariableDeclaration>();
    for (const [declaration, uses] of references) {
      for (const use of uses) {
        const access = use.parent;
        const indexed = (ts.isPropertyAccessExpression(access) || ts.isElementAccessExpression(access)) && access.expression === use;
        const parent = access.parent;
        const assigned = ts.isBinaryExpression(parent) && parent.left === access
          && parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment;
        const modified = (ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent))
          && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(parent.operator);
        if (assigned || modified || ts.isDeleteExpression(parent) || (!indexed && !styleExpressions.has(use))) mutable.add(declaration);
      }
    }
    if (mutable.size) {
      for (const expression of styleExpressions.keys()) {
        const dependencies = new Set<ts.VariableDeclaration>();
        try { literal(expression, new Set(), dependencies); } catch { /* Dynamic aliases are tracked below. */ }
        if ([...dependencies].some(declaration => mutable.has(declaration))
          || [...mutable].some(declaration => declaration.initializer === expression)) styleExpressions.delete(expression);
      }
      for (const declaration of mutable) {
        removedStyles.delete(declaration);
        styleDeclarations.delete(declaration);
        numericAliases.delete(declaration);
      }
    }
  }
  function covered(node: ts.Node): boolean {
    for (let current: ts.Node | undefined = node; current; current = current.parent) {
      if(runtimeStyleExpressions.has(current as ts.Expression))return false;
      if (styleExpressions.has(current as ts.Expression) || (ts.isVariableDeclaration(current) && removedStyles.has(current))) return true;
    }
    return false;
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const declaration of removedStyles) if ((references.get(declaration) ?? []).some(node => !covered(node))) {
      removedStyles.delete(declaration); changed = true;
    }
  }
  for (const declaration of styleDeclarations) {
    if (!declaration.initializer) continue;
    let value: unknown;
    try { value = literal(declaration.initializer); } catch { continue; }
    if (!value || typeof value !== 'object') continue;
    for (const reference of references.get(declaration) ?? []) {
      if (covered(reference)) continue;
      const access = reference.parent;
      const indexed = (ts.isPropertyAccessExpression(access) || ts.isElementAccessExpression(access)) && access.expression === reference;
      const parent = access.parent;
      const assigned = ts.isBinaryExpression(parent) && parent.left === access && parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment;
      const modified = (ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(parent.operator);
      const invoked = ts.isCallExpression(parent) && parent.expression === access;
      if (!indexed || assigned || modified || invoked || ts.isDeleteExpression(parent)) {
        report(reference, 'style-alias', 'Static style data cannot be mutated or escape to runtime code. Read scalar properties or forward it as a style.');
      }
    }
  }
  for(const declaration of numericAliases)for(const reference of references.get(declaration)??[])if(!numericAliasUses.has(reference))report(reference,'style-alias','Dynamic style aliases may only be forwarded as styles.');
  const renderNullValues = renderNulls(source, checker, components, { renderSlot: node => jsxChildren.has(node as ts.Expression), componentTag: node => jsxTags.has(node as ts.Expression) });
  for (const node of nullValues) if (!options.values?.nulls&&!covered(node)&&!styleNullValues.has(node)&&!renderNullValues.has(node)) report(node, 'null-value', 'Source null needs a deliberate platform representation; it is distinct from undefined.');
  const pureCalls = new Set(options.pureCalls?.map(item => `${item.module}#${item.name}`));
  function pure(node: ts.Expression, active = new Set<ts.Node>()): boolean {
    if (active.has(node)) return false;
    active.add(node);
    const child = (value: ts.Expression) => pure(value, new Set(active));
    if (ts.isStringLiteralLike(node) || ts.isNumericLiteral(node) || node.kind === ts.SyntaxKind.NullKeyword || node.kind === ts.SyntaxKind.TrueKeyword
      || node.kind === ts.SyntaxKind.FalseKeyword || ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return true;
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) return child(node.expression);
    if (ts.isIdentifier(node)) {
      if (node.text === 'undefined') return true;
      const declaration = checker.getSymbolAtLocation(node)?.valueDeclaration;
      return !!declaration && ts.isVariableDeclaration(declaration) && !!declaration.initializer
        && ts.isVariableDeclarationList(declaration.parent) && !!(declaration.parent.flags & ts.NodeFlags.Const) && child(declaration.initializer);
    }
    if (ts.isArrayLiteralExpression(node)) return node.elements.every(item => !ts.isSpreadElement(item) && child(item));
    if (ts.isObjectLiteralExpression(node)) return node.properties.every(item => ts.isPropertyAssignment(item)
      && !ts.isComputedPropertyName(item.name) && child(item.initializer));
    if (ts.isPrefixUnaryExpression(node)) return node.operator !== ts.SyntaxKind.PlusPlusToken
      && node.operator !== ts.SyntaxKind.MinusMinusToken && child(node.operand);
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const symbol = checker.getSymbolAtLocation(node.expression);
      const binding = symbol && imported.get(symbol);
      return !!binding && pureCalls.has(`${binding.module}#${binding.name}`) && node.arguments.every(child);
    }
    return false;
  }
  for (const statement of source.statements) if (ts.isVariableStatement(statement) && !constants.has(statement)) {
    for (const declaration of statement.declarationList.declarations) if (declaration.initializer && !staticConstants.has(declaration) && !pure(declaration.initializer)) {
      report(declaration.initializer, 'module-initializer', 'Unselected module initialization may have effects. Select its dependency or declare the imported factory pure.');
    }
  }
  const sourceTypes = createSourceTypes(source, checker, {
    project:projectedValueType,
    ...(trustedDeclaration ? { trustedDeclaration } : {}),
    boundary: fn => selected.has(fn),
    replacesCall(node) {
      if (reactFactory(node.expression)) return true;
      let expression: ts.Expression = node.expression;
      while (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) expression = expression.expression;
      const dependency = ts.isIdentifier(expression) && imported.get(checker.getSymbolAtLocation(expression)!);
      const binding = dependency && bindingsByKey.get(`${dependency.module}#${dependency.name}`);
      return !!binding && binding.kind !== "value";
    },
    report,
  });
  const result = {
    trustedJavaScriptContracts,
    renamedIdentifiers: 0,
    typeProofs: sourceTypes.proofs,
    diagnostics, imports: [...imports.values()], globals: [...globals.values()], exports: [...requested.keys()], intrinsics: [...intrinsics].sort(),
    sourceSha256: crypto.createHash('sha256').update(text).digest('hex'),
    svgAssets: [...svgElements.values()].map(value => value.asset),
    sourceFeatures: { fragments: needsFragment, booleanCoercions: booleanCalls.size, typeofExpressions: typeofExpressions.size, styleObjects: styleObjects.length, numericStyles:numericBuilders.size, helperFunctions:helpers.size, renderNulls:[...nullValues].filter(node=>renderNullValues.has(node)).length, stringMethods:stringCalls.size },
    variantDefinitions: [...variants].map(([node, metadata]) => {
      const position = source.getLineAndCharacterOfPosition(node.getStart(source));
      return { line: position.line + 1, column: position.character + 1, metadata };
    }),
  };
  if (diagnostics.length) return result;
  const factory = ts.factory;
  // Retain scalar fields the source checker can establish without resolving
  // browser libraries. Unknown imported/component types keep the platform boundary.
  function scalarType(type: ts.Type,active=new Set<ts.Type>()): ts.TypeNode | undefined {
    if(active.has(type))return undefined;
    const nested=new Set([...active,type]);
    const child=(value:ts.Type)=>scalarType(value,nested);
    if(type.flags&ts.TypeFlags.Null&&options.values?.nulls)return factory.createIndexedAccessTypeNode(nativeValueType(options.values.nulls.valueType),factory.createLiteralTypeNode(factory.createStringLiteral('value')));
    if(options.values?.arrays&&checker.isArrayType(type)){
      const element=child(checker.getTypeArguments(type as ts.TypeReference)[0]!);
      if(element){const array=factory.createArrayTypeNode(element);return type.getSymbol()?.getName()==='ReadonlyArray'?factory.createTypeOperatorNode(ts.SyntaxKind.ReadonlyKeyword,array):array;}
    }
    if (type.flags & ts.TypeFlags.BooleanLiteral) return factory.createLiteralTypeNode(checker.typeToString(type) === 'true' ? factory.createTrue() : factory.createFalse());
    if (type.flags & ts.TypeFlags.StringLiteral) return factory.createLiteralTypeNode(factory.createStringLiteral((type as ts.StringLiteralType).value));
    if (type.flags & ts.TypeFlags.NumberLiteral) {
      const value = (type as ts.NumberLiteralType).value;
      return factory.createLiteralTypeNode(value < 0 ? factory.createPrefixUnaryExpression(ts.SyntaxKind.MinusToken, factory.createNumericLiteral(-value)) : factory.createNumericLiteral(value));
    }
    for (const [flag, keyword] of [[ts.TypeFlags.Boolean, ts.SyntaxKind.BooleanKeyword], [ts.TypeFlags.String, ts.SyntaxKind.StringKeyword],
      [ts.TypeFlags.Number, ts.SyntaxKind.NumberKeyword], [ts.TypeFlags.Undefined, ts.SyntaxKind.UndefinedKeyword]] as const) {
      if (type.flags & flag) return factory.createKeywordTypeNode(keyword);
    }
    if (type.isUnion()) {
      const members = type.types.map(child);
      if (members.every((member): member is ts.TypeNode => member !== undefined)) return factory.createUnionTypeNode(members);
    }
    return undefined;
  }
  const scalarProps = new Map<string, ts.TypeLiteralNode>();
  function sourceReact(identifier: ts.Identifier): boolean {
    return checker.getSymbolAtLocation(identifier)?.declarations?.some(declaration => {
      const parent = ts.isImportClause(declaration) ? declaration.parent : ts.isNamespaceImport(declaration) ? declaration.parent.parent : undefined;
      return parent && ts.isImportDeclaration(parent) && ts.isStringLiteral(parent.moduleSpecifier) && parent.moduleSpecifier.text === 'react';
    }) ?? false;
  }
  function contextualProps(fn: SourceFunction): ts.Type | undefined {
    const props = factoryProps.get(fn);
    if (props) return checker.getTypeFromTypeNode(props);
    const type = functionVariables.get(fn)?.type;
    if (!type || !ts.isTypeReferenceNode(type) || !ts.isQualifiedName(type.typeName) || !ts.isIdentifier(type.typeName.left)
      || !['FC', 'FunctionComponent'].includes(type.typeName.right.text) || type.typeArguments?.length !== 1
      || !sourceReact(type.typeName.left)) return undefined;
    return checker.getTypeFromTypeNode(type.typeArguments[0]!);
  }
  // A source React props query can retain its checked native component boundary
  // even when browser declarations are deliberately absent from this program.
  function boundComponentProps(node: ts.TypeNode | undefined): ts.TypeNode | undefined {
    if (!node || !ts.isTypeReferenceNode(node) || !ts.isQualifiedName(node.typeName)
      || !ts.isIdentifier(node.typeName.left) || !['ComponentProps', 'ComponentPropsWithRef', 'ComponentPropsWithoutRef'].includes(node.typeName.right.text)
      || node.typeArguments?.length !== 1 || !ts.isTypeQueryNode(node.typeArguments[0]!)) return undefined;
    const react = sourceReact(node.typeName.left);
    const query = node.typeArguments[0];
    let root = query.exprName;
    while (ts.isQualifiedName(root)) root = root.left;
    const symbol = checker.getSymbolAtLocation(root);
    const dependency = symbol && imported.get(symbol);
    const binding = dependency && bindingsByKey.get(`${dependency.module}#${dependency.name}`);
    if (!react || !binding || !['component', 'value'].includes(binding.kind)) return undefined;
    if (ts.isQualifiedName(query.exprName) && (!ts.isIdentifier(query.exprName.left) || !binding.members?.includes(query.exprName.right.text))) return undefined;
    return factory.createTypeReferenceNode(`${html}.ComponentProps`, [query]);
  }
  for (const fn of selected) {
    const parameter = fn.parameters[0];
    const name = functionName(fn);
    if (!components.has(fn) || !parameter || !name) continue;
    const props = parameter.type ? checker.getTypeAtLocation(parameter) : contextualProps(fn);
    if (!props) continue;
    // An unresolved foreign props type can collapse an intersection to `any`.
    // Its explicitly authored members still have independently checked types.
    const explicit = parameter.type && ts.isIntersectionTypeNode(parameter.type)
      ? parameter.type.types.filter(ts.isTypeLiteralNode).flatMap(type => checker.getPropertiesOfType(checker.getTypeFromTypeNode(type))) : [];
    const candidates = checker.getPropertiesOfType(props);
    const properties = [...new Map([...explicit, ...candidates].map(property => [property.name, property])).values()].flatMap(property => {
      const declaration = property.valueDeclaration ?? property.declarations?.[0];
      if (!declaration) return [];
      let projected: ts.TypeNode | undefined;
      if (ts.isPropertySignature(declaration) && declaration.type) {
        try { projected = createTypeProjection(checker, [], projectedValueType, trustedDeclaration).data(declaration.type); }
        catch { /* The general HTML boundary handles unprojectable props. */ }
      }
      const type = scalarType(checker.getTypeOfSymbolAtLocation(property, declaration))
        ?? (ts.isPropertySignature(declaration) ? boundComponentProps(declaration.type) : undefined) ?? projected;
      return type ? [factory.createPropertySignature(ts.getCombinedModifierFlags(declaration)&ts.ModifierFlags.Readonly?[factory.createModifier(ts.SyntaxKind.ReadonlyKeyword)]:undefined, factory.createStringLiteral(property.name),
        property.flags & ts.SymbolFlags.Optional ? factory.createToken(ts.SyntaxKind.QuestionToken) : undefined, type)] : [];
    });
    if (properties.length) scalarProps.set(name, factory.createTypeLiteralNode(properties));
  }
  const selectedStatements = source.statements.filter(statement => constants.has(statement as ts.VariableStatement)
    || selected.has(statement as ts.FunctionDeclaration) || moduleStatements.has(statement));
  function lowerFunction<T extends SourceFunction>(fn: T): T {
    const prelude: ts.Statement[] = [];
    const parameters = fn.parameters.map(parameter => {
      if (ts.isIdentifier(parameter.name)) return parameter;
      const pattern = parameter.name as ts.ObjectBindingPattern;
      const value = factory.createIdentifier(fresh('__cssProps'));
      const fields = pattern.elements.filter(item => !item.dotDotDotToken);
      const rest = pattern.elements.find(item => item.dotDotDotToken);
      const constant = (name: ts.BindingName, initializer: ts.Expression) => factory.createVariableStatement(undefined,
        factory.createVariableDeclarationList([factory.createVariableDeclaration(name, undefined, undefined, initializer)], ts.NodeFlags.Const));
      if (fields.length) prelude.push(constant(factory.createObjectBindingPattern(fields), value));
      if (rest) prelude.push(constant(rest.name, factory.createCallExpression(
        factory.createPropertyAccessExpression(factory.createIdentifier(dependencies), 'rest'), undefined,
        [value, factory.createArrayLiteralExpression(fields.map(item => factory.createStringLiteral((item.propertyName as ts.Identifier | ts.StringLiteral | undefined)?.text ?? (item.name as ts.Identifier).text)))])));
      return factory.createParameterDeclaration(undefined, undefined, value, parameter.questionToken, undefined, parameter.initializer);
    });
    const body = fn.body!;
    return updateSourceFunction(fn, parameters, factory.createBlock([
      ...prelude, ...(ts.isBlock(body) ? body.statements : [factory.createReturnStatement(body)]),
    ], true));
  }
  const declarations = selectedStatements.map(statement => {
    if (ts.isFunctionDeclaration(statement)) return lowerFunction(statement);
    if (!ts.isVariableStatement(statement)) return statement;
    const variable = statement as ts.VariableStatement;
    return factory.updateVariableStatement(variable, undefined,
      factory.updateVariableDeclarationList(variable.declarationList,
        variable.declarationList.declarations.map(declaration => {
          const fn = variableFunctions.get(declaration);
          if (!fn || !selected.has(fn)) return declaration;
          const transformed = ts.transform(declaration.initializer!, [context => root => {
            const visit: ts.Visitor = node => node === fn ? lowerFunction(fn) : ts.visitEachChild(node, visit, context);
            return ts.visitNode(root, visit) as ts.Expression;
          }]);
          const initializer = transformed.transformed[0]!;
          transformed.dispose();
          return factory.updateVariableDeclaration(declaration, declaration.name,
            declaration.exclamationToken, declaration.type, initializer);
        })));
  });
  const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
  function svgSnapshotSegments(props:ts.Expression):ts.Expression[]{
    const snapshot=(value:ts.Expression,keys?:readonly string[])=>factory.createCallExpression(factory.createIdentifier(svgPropsHelper),undefined,
      [value,...(keys?[factory.createArrayLiteralExpression(keys.map(key=>factory.createStringLiteral(key)))]:[])]);
    if(!ts.isObjectLiteralExpression(props))return [snapshot(props)];
    const result:ts.Expression[]=[],group:ts.ObjectLiteralElementLike[]=[];
    const names=new Set<string>();
    const propertyName=(property:ts.ObjectLiteralElementLike)=>{
      const name=(property as ts.PropertyAssignment).name;
      return ts.isComputedPropertyName(name)&&ts.isStringLiteralLike(name.expression)?name.expression.text
        :ts.isComputedPropertyName(name)?'':name.text;
    };
    const flush=()=>{
      if(!group.length)return;
      result.push(snapshot(factory.createObjectLiteralExpression([...group],true),group.map(propertyName)));
      group.length=0;names.clear();
    };
    for(const property of props.properties){
      if(ts.isSpreadAssignment(property)){flush();result.push(snapshot(property.expression));}
      else {const name=propertyName(property);if(names.has(name))flush();group.push(property);names.add(name);}
    }
    flush();return result;
  }
  function data(value: unknown): ts.Expression {
    if (typeof value === 'string') return factory.createStringLiteral(value);
    if (typeof value === 'number') return value < 0 ? factory.createPrefixUnaryExpression(ts.SyntaxKind.MinusToken, factory.createNumericLiteral(-value)) : factory.createNumericLiteral(value);
    if (typeof value === 'boolean') return value ? factory.createTrue() : factory.createFalse();
    if (Array.isArray(value)) return factory.createArrayLiteralExpression(value.map(data));
    if (value && typeof value === 'object') return factory.createObjectLiteralExpression(Object.entries(value).map(([name, item]) => factory.createPropertyAssignment(factory.createStringLiteral(name), data(item))));
    throw new Error('Invalid compiled variant metadata');
  }
  const trustedReturn=trustedJavaScriptReturns(trustedPublicFunction,(type,owner)=>
    createTypeProjection(checker,owner.typeParameters,projectedValueType,trustedDeclaration,false,undefined,filename,standardLibraryFile,options.reactInference===true).data(type));
  const printed = declarations.map(statement => {
    const transformed = ts.transform<ts.Statement>(statement, [context => root => {
      const normalizing = new Set<ts.Node>();
      const visit: ts.Visitor = node => {
        const trusted=trustedReturn(node,visit);
        if(trusted)return trusted;
        if (ts.isTypeNode(node) || ts.isTypeParameterDeclaration(node)) return node;
        if (ts.isShorthandPropertyAssignment(node) && (styleExpressions.has(node.name) || jsxFragments.has(node.name)
          || options.nodes && jsxHostChildren.has(node.name)))
          return factory.createPropertyAssignment(node.name.text, ts.visitNode(node.name, visit) as ts.Expression);
        if (jsxFragments.has(node)) return factory.createIdentifier(fragment);
        if (ts.isCallExpression(node) && jsxCalls.has(node)) {
          const tag = ts.visitNode(node.arguments[0]!, visit) as ts.Expression;
          const svg=svgElements.get(node);
          const sourceProps=svg?.spreadProps??(svg?.props ? factory.updateObjectLiteralExpression(svg.props,[...svg.props.properties,
            factory.createPropertyAssignment(factory.createStringLiteral(staticSvgAssetAttribute),factory.createStringLiteral(svg.asset.asset))]) : node.arguments[1]!);
          const props = ts.visitNode(sourceProps, visit) as ts.Expression;
          const merged=svg?.spreadProps?factory.createCallExpression(factory.createIdentifier(svgPropsHelper),undefined,
            [factory.createIdentifier('undefined'),factory.createIdentifier('undefined'),...svgSnapshotSegments(props)]):props;
          const config = node.arguments.length > 2 ? factory.createCallExpression(factory.createIdentifier(jsxProps), undefined,
            [merged, ...node.arguments.slice(2).map(argument => ts.visitNode(argument, visit) as ts.Expression)]) : merged;
          const checked=svg?.spreadProps?factory.createCallExpression(factory.createIdentifier(svgPropsHelper),undefined,
            [factory.createStringLiteral(svg.asset.asset),svg.geometry!,factory.createCallExpression(factory.createIdentifier(svgPropsHelper),undefined,[config])]):config;
          return factory.createCallExpression(factory.createIdentifier(element), undefined, [tag, checked]);
        }
        if (options.nodes && jsxHostChildren.has(node as ts.Expression) && !normalizing.has(node)) {
          const type = checker.getTypeAtLocation(node), members = type.isUnion() ? type.types : [type];
          const scalar = members.every(member => !!(member.flags & (ts.TypeFlags.StringLike | ts.TypeFlags.NumberLike | ts.TypeFlags.BooleanLike
            | ts.TypeFlags.Undefined | ts.TypeFlags.Void | ts.TypeFlags.Never)));
          if (!scalar) {
            normalizing.add(node);
            const child = ts.visitNode(node, visit) as ts.Expression;
            normalizing.delete(node);
            return factory.createCallExpression(valueProvider(options.nodes, '__renderNodes'), undefined, [child]);
          }
        }
        if (ts.isJsxOpeningElement(node) && reactFragment(node.tagName)) return factory.updateJsxOpeningElement(node,
          factory.createIdentifier(fragment), undefined, ts.visitEachChild(node.attributes, visit, context));
        if (ts.isJsxClosingElement(node) && reactFragment(node.tagName)) return factory.updateJsxClosingElement(node, factory.createIdentifier(fragment));
        if (ts.isJsxSelfClosingElement(node) && reactFragment(node.tagName)) return factory.updateJsxSelfClosingElement(node,
          factory.createIdentifier(fragment), undefined, ts.visitEachChild(node.attributes, visit, context));
        const svg = svgElements.get(node);
        if(svg?.rootAttributes){
          const name=fresh('__cssSvgRoot');svgSpreadTags.set(name,svg);
          return ts.visitEachChild(factory.createJsxSelfClosingElement(factory.createIdentifier(name),undefined,
            factory.createJsxAttributes(svg.rootAttributes)),visit,context);
        }
        if (svg) return ts.visitEachChild(factory.createJsxSelfClosingElement(factory.createIdentifier('svg'), undefined,
          factory.createJsxAttributes([...svg.attributes, factory.createJsxAttribute(factory.createIdentifier(staticSvgAssetAttribute),
            factory.createStringLiteral(svg.asset.asset))])), visit, context);
        if (ts.isVariableStatement(node)) {
          const retained = node.declarationList.declarations.filter(declaration => !removedStyles.has(declaration));
          if (!retained.length) return undefined;
          if (retained.length !== node.declarationList.declarations.length) {
            return ts.visitEachChild(factory.updateVariableStatement(node, node.modifiers,
              factory.updateVariableDeclarationList(node.declarationList, retained)), visit, context);
          }
        }
        const style = styleExpressions.get(node as ts.Expression);
        if(style) {
          if(style.values)return factory.createCallExpression(factory.createIdentifier(numericBuilders.get(style.index)!),undefined,
            style.values.map(value=>ts.visitNode(value,visit) as ts.Expression));
          return factory.createElementAccessExpression(factory.createIdentifier(styleData),style.index);
        }
        if(styleNullValues.has(node))return factory.createIdentifier('undefined');
        if(renderNullValues.has(node))return factory.createFalse();
        if(options.nodes&&ts.isJsxExpression(node)&&node.expression&&node.parent){
          let host=false;
          const parent=node.parent;
          if(ts.isJsxFragment(parent))host=true;
          else if(ts.isJsxElement(parent))host=reactFragment(parent.openingElement.tagName)||(ts.isIdentifier(parent.openingElement.tagName)&&/^[a-z]/.test(parent.openingElement.tagName.text));
          else if(ts.isJsxAttribute(parent)&&parent.name.getText(source)==='children'){
            const opening=parent.parent.parent;
            host=(ts.isJsxOpeningElement(opening)||ts.isJsxSelfClosingElement(opening))&&(reactFragment(opening.tagName)||(ts.isIdentifier(opening.tagName)&&/^[a-z]/.test(opening.tagName.text)));
          }
          const type=checker.getTypeAtLocation(node.expression),members=type.isUnion()?type.types:[type];
          const scalar=members.every(member=>!!(member.flags&(ts.TypeFlags.StringLike|ts.TypeFlags.NumberLike|ts.TypeFlags.BooleanLike|ts.TypeFlags.Undefined|ts.TypeFlags.Void|ts.TypeFlags.Never)));
          if(host&&!scalar)return factory.updateJsxExpression(node,factory.createCallExpression(valueProvider(options.nodes,'__renderNodes'),undefined,[ts.visitNode(node.expression,visit) as ts.Expression]));
        }
        const value=sourceValues.numbers?.visit(node,visit)??sourceValues.classChecks?.visit(node,visit)??sourceValues.nulls?.visit(node,visit)??sourceValues.functions?.visit(node,visit)??sourceValues.arrays?.visit(node,visit)??sourceValues.keys?.visit(node,visit)??sourceValues.properties?.visit(node,visit)??sourceValues.reads?.visit(node,visit);
        if(value)return value;
        const searchCall=ts.isCallExpression(node)&&stringCalls.get(node);
        if(searchCall)return factory.createCallExpression(factory.createPropertyAccessExpression(factory.createIdentifier(stringMethods),searchCall.method),undefined,
          [searchCall.receiver,...(node as ts.CallExpression).arguments].map(value=>ts.visitNode(value,visit)as ts.Expression));
        if (ts.isTypeOfExpression(node) && typeofExpressions.has(node)) {
          return factory.createCallExpression(factory.createIdentifier(typeQuery), undefined, [ts.visitNode(node.expression, visit) as ts.Expression]);
        }
        const metadata = ts.isCallExpression(node) ? variants.get(node) : undefined;
        if (metadata) return factory.updateCallExpression(node as ts.CallExpression, (node as ts.CallExpression).expression, undefined, [data(metadata)]);
        if (ts.isCallExpression(node) && booleanCalls.has(node)) {
          const argument = node.arguments[0];
          return argument ? factory.createPrefixUnaryExpression(ts.SyntaxKind.ExclamationToken,
            factory.createPrefixUnaryExpression(ts.SyntaxKind.ExclamationToken, factory.createParenthesizedExpression(ts.visitNode(argument, visit) as ts.Expression))) : factory.createFalse();
        }
        return sourceTypes.rewrite(node, ts.visitEachChild(node, visit, context));
      };
      return ts.visitNode(root, visit) as ts.Statement;
    }]);
    const transformedStatement=transformed.transformed[0]!;
    if(options.values?.records){
      const recordSource=factory.updateSourceFile(source,[transformedStatement]);
      const lowered=transformDataRecords(recordSource,{fresh,report,helper:()=>valueProvider(options.values!.records!,'__records').text});
      // Construction temporaries are part of this source statement's scope.
      const output=[lowered.moduleDeclarations(valueProvider(options.values.records,'__records').text),
        ...lowered.source.statements.map(item=>printer.printNode(ts.EmitHint.Unspecified,item,source))]
        .filter(Boolean).join('\n');
      transformed.dispose();
      return output;
    }
    const output = printer.printNode(ts.EmitHint.Unspecified, transformedStatement, source);
    transformed.dispose();
    return output;
  }).join('\n\n');
  // Keep TypeScript's JSX whitespace/entity/spread lowering. Its original-node
  // metadata lets portable source types survive; roblox-ts owns Luau emission.
  const lowered = ts.transpileModule(printed, { compilerOptions: {
    target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.React, jsxFactory: element, jsxFragmentFactory: fragment,
  }, fileName: 'components.tsx', transformers: { after: [preserveTypes] } });
  const parsed = ts.createSourceFile('components.ts', lowered.outputText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const portable = ts.transform(parsed, [context => root => {
    const visit: ts.Visitor = node => {
      if(ts.isCallExpression(node)&&ts.isIdentifier(node.expression)&&node.expression.text===element&&node.arguments[0]
        &&ts.isIdentifier(node.arguments[0])&&svgSpreadTags.has(node.arguments[0].text)){
        const svg=svgSpreadTags.get(node.arguments[0].text)!;
        const props=ts.visitNode(node.arguments[1]!,visit) as ts.Expression;
        return factory.updateCallExpression(node,node.expression,node.typeArguments,[factory.createStringLiteral('svg'),
          factory.createCallExpression(factory.createIdentifier(svgPropsHelper),undefined,
            [factory.createStringLiteral(svg.asset.asset),svg.geometry!,...svgSnapshotSegments(props)])]);
      }
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && [...numericBuilders.values()].includes(node.expression.text)) {
        return factory.updateCallExpression(node, node.expression, undefined, node.arguments.map(value =>
          factory.createAsExpression(factory.createParenthesizedExpression(ts.visitNode(value, visit) as ts.Expression), factory.createTypeReferenceNode(`${html}.NumericStyleValue`))));
      }
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        if(!scalarString(node.text))report(source,'unicode-string','Lowered JSX or metadata contains a lone surrogate code unit; Unicode scalar values are required for native UTF-8 output.');
        return ts.setEmitFlags(factory.createStringLiteral(node.text), ts.EmitFlags.NoAsciiEscaping);
      }
      if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
        const literal = ts.isTemplateHead(node) ? factory.createTemplateHead(node.text)
          : ts.isTemplateMiddle(node) ? factory.createTemplateMiddle(node.text) : factory.createTemplateTail(node.text);
        return ts.setEmitFlags(literal, ts.EmitFlags.NoAsciiEscaping);
      }
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === element
        && node.arguments[1]?.kind === ts.SyntaxKind.NullKeyword) {
        return factory.updateCallExpression(node, node.expression, undefined,
          node.arguments.map((argument, index) => index === 1 ? factory.createIdentifier('undefined') : ts.visitNode(argument, visit) as ts.Expression));
      }
      return ts.visitEachChild(node, visit, context);
    };
    return ts.visitNode(root, visit) as ts.SourceFile;
  }]);
  function typedFunction<T extends SourceFunction>(fn: T, name: string, packetParameters=0): T {
    const helper = helpers.get(name);
    if (helper) return updateSourceFunction(fn,
      fn.parameters.map((p, i) => i<packetParameters ? p : factory.updateParameterDeclaration(p, undefined, p.dotDotDotToken, p.name,
        helper.parameters[i-packetParameters]!.optional ? factory.createToken(ts.SyntaxKind.QuestionToken) : undefined, helper.parameters[i-packetParameters]!.type, p.initializer)),
      fn.body as ts.Block, helper.typeParameters, helper.result);
    const fields = scalarProps.get(name);
    const sourceFunction = [...selected].find(value => functionName(value) === name);
    const generic = sourceFunction && genericComponents.get(sourceFunction);
    const role = sourceFunction && factoryFunctions.get(sourceFunction);
    const propsType = factory.createTypeReferenceNode(`${html}.Props`);
    return updateSourceFunction(fn,
      fn.parameters.map((parameter, i) => i<packetParameters ? parameter : factory.updateParameterDeclaration(parameter, undefined, undefined, parameter.name, undefined,
        role === 'forwardRef' && i-packetParameters === 1 ? factory.createTypeReferenceNode(`${html}.ForwardedRef`)
          : generic?.props ? factory.createIntersectionTypeNode([propsType, generic.props])
            : fields ? factory.createIntersectionTypeNode([propsType, fields]) : propsType, undefined)),
      fn.body as ts.Block, generic?.parameters, factory.createTypeReferenceNode(`${html}.${role ? 'Element' : 'Node'}`));
  }
  const typedStatements = portable.transformed[0]!.statements.map(statement => {
    if (ts.isFunctionDeclaration(statement)) return typedFunction(statement, statement.name!.text);
    if (!ts.isVariableStatement(statement)) return statement;
    return factory.updateVariableStatement(statement, statement.modifiers,
      factory.updateVariableDeclarationList(statement.declarationList,
        statement.declarationList.declarations.map(declaration => {
          if (!ts.isIdentifier(declaration.name) || !declaration.initializer) return declaration;
          const name = declaration.name.text;
          const sourceFunction = [...functionVariables].find(([,variable]) => ts.isIdentifier(variable.name) && variable.name.text === name)?.[0]
            ?? [...selected].find(fn=>ts.isFunctionDeclaration(fn)&&fn.name?.text===name);
          if (!sourceFunction || !selected.has(sourceFunction)) return declaration;
          function renderInitializer(expression: ts.Expression,packetParameters=0): {fn:ts.FunctionExpression|ts.ArrowFunction;packetParameters:number} | undefined {
            const direct = initializerFunction(expression);
            if (direct) return {fn:direct,packetParameters};
            if (ts.isCallExpression(expression) && expression.arguments[0]) {
              const callee=expression.expression;
              const packet=ts.isPropertyAccessExpression(callee)&&callee.name.text==='withArguments'&&ts.isIdentifier(callee.expression)
                &&options.values?.arrays&&callee.expression.text===valueBindings.get(options.values.arrays.name)?.local;
              return renderInitializer(expression.arguments[0],packetParameters+(packet?1:0));
            }
            return undefined;
          }
          const render = renderInitializer(declaration.initializer);
          if (!render) return declaration;
          const initializer=render.fn;
          const typedInitializer = typedFunction(initializer, name,render.packetParameters);
          const value = ts.isFunctionExpression(typedInitializer) && typedInitializer.name
            ? privateFunctionExpression(typedInitializer) : typedInitializer;
          const rewritten = ts.transform(declaration.initializer, [context => root => {
            const visit: ts.Visitor = node => node === initializer ? value : ts.visitEachChild(node, visit, context);
            return ts.visitNode(root, visit) as ts.Expression;
          }]);
          const expression = rewritten.transformed[0]!;
          rewritten.dispose();
          return factory.updateVariableDeclaration(declaration, declaration.name,
            declaration.exclamationToken, undefined, expression);
        })));
  });
  const sourceFunctionNames = new Set([...selected].filter(ts.isFunctionDeclaration).flatMap(fn => fn.name ? [fn.name.text] : []));
  const hoistedDeclaration = (statement: ts.Statement) => ts.isFunctionDeclaration(statement) || ts.isVariableStatement(statement)
    && statement.declarationList.declarations.every(declaration => ts.isIdentifier(declaration.name) && sourceFunctionNames.has(declaration.name.text));
  const functionDeclarations=typedStatements.filter(hoistedDeclaration);
  const functionRegistrations=sourceValues.functions?.registrations(typedStatements)??[];
  const typed=[...functionDeclarations,...functionRegistrations,...typedStatements.filter(statement=>!hoistedDeclaration(statement))]
    .map(statement => printer.printNode(ts.EmitHint.Unspecified, statement, parsed)).join('\n\n');
  portable.dispose();
  if (diagnostics.length) return result;
  const bindingTypes: Record<BindingKind, string> = {
    component: 'Component', className: 'ClassName', variants: 'VariantFactory',
    mergeProps: 'MergeProps', render: 'ElementRenderer',
    value: 'Node', // Value bindings always supply their checked external type.
  };
  const fields = [...imports.values(), ...[...globals.values()].map(item => ({ ...item, kind: 'value' as const, local: item.name }))];
  const dependencyFields = fields.map(item => {
    let type: string;
    const external = 'componentType' in item && item.componentType || item.valueType;
    if (external) {
      const { module, name, member } = external;
      const key = JSON.stringify([module, name]);
      let imported = componentTypes.get(key);
      if (!imported) {
        imported = { module, name, alias: fresh(item.kind === 'value' ? '__CssValueType' : '__CssComponentType') };
        componentTypes.set(key, imported);
      }
      const base = 'typeOf' in external && external.typeOf ? `(typeof ${imported.alias})` : imported.alias;
      const selected = base + (member === undefined ? '' : `[${JSON.stringify(member)}]`);
      type = item.members ? `Pick<${selected}, ${item.members.map(name => JSON.stringify(name)).join(' | ')}>` : selected;
    } else type = item.members
      ? `{ ${item.members.map(name => `readonly ${JSON.stringify(name)}: ${html}.Component;`).join(' ')} }`
      : `${html}.${bindingTypes[item.kind]}`;
    return `  readonly ${item.local}: ${type};`;
  }).join('\n');
  const dependencyLocals = fields.map(item => `  const ${item.local} = ${dependencies}.${item.local};`).join('\n');
  const valueFields=[...valueBindings.values()].map(item=>`readonly ${JSON.stringify(item.binding.name)}: ${printer.printNode(ts.EmitHint.Unspecified,nativeValueType(item.binding.valueType),source)};`).join('\n');
  const valueLocals=[...valueBindings.values()].map(item=>`const ${item.local}=${dependencies}.${valueContextName}[${JSON.stringify(item.binding.name)}];`).join('\n');
  const code = `// Generated from ${JSON.stringify(options.filename)}. Compile with roblox-ts.
// Browser props types are replaced by the checked platform boundary, not bundled.
import type * as ${html} from ${JSON.stringify(options.typesModule ?? '@3xjn/roblox-css-react/src/Html')};
${[...componentTypes.values()].map(item => item.name === '*' ? `import type * as ${item.alias} from ${JSON.stringify(item.module)};` : `import type { ${item.name} as ${item.alias} } from ${JSON.stringify(item.module)};`).join('\n')}
${[...classConstructors.values()].map(view=>`declare const ${view.name}: ${printer.printNode(ts.EmitHint.Unspecified,view.type,source)};`).join('\n')}
export interface Dependencies {
  readonly element: ${html}.ElementFactory;
${[...svgElements.values()].some(svg=>svg.geometry)?`  readonly staticSvgProps: ${html}.StaticSvgProps;`:''}
${valueBindings.size?`  readonly ${valueContextName}: {${valueFields}};`:''}
${needsFragment ? `  readonly fragment: ${html}.Fragment;\n` : ''}${needsRest ? `  readonly rest: ${html}.Rest;\n` : ''}${typeofExpressions.size ? `  readonly typeOf: ${html}.TypeOf;\n` : ''}${numericBuilders.size?`  readonly numberStyle: ${html}.NumericStyleFactory;\n`:''}${stringCalls.size?`  readonly strings: ${html}.StringMethods;\n`:''}${dependencyFields}
}

export function create(${dependencies}: Dependencies) {
  const ${element} = ${dependencies}.element;
${[...svgElements.values()].some(svg=>svg.geometry)?`  const ${svgPropsHelper} = ${dependencies}.staticSvgProps;`:''}
${valueLocals}
${needsFragment ? `  const ${fragment} = ${dependencies}.fragment;\n` : ''}${typeofExpressions.size ? `  const ${typeQuery} = ${dependencies}.typeOf;\n` : ''}${stringCalls.size?`  const ${stringMethods} = ${dependencies}.strings;\n`:''}${styleObjects.length ? `  const ${styleData} = ${JSON.stringify(styleObjects)} as const;\n` : ''}${[...numericBuilders].map(([index,name])=>`  const ${name} = ${dependencies}.numberStyle(${styleData}[${index}]);`).join('\n')}${numericBuilders.size?'\n':''}${dependencyLocals}
${needsJsxProps ? `  function ${jsxProps}<P extends ${html}.Props>(props: P, key?: ${html}.PropsBase['key'], ..._metadata: unknown[]): P {
    return { ...props, key: props.key === undefined ? key : props.key };
  }\n` : ''}
${typed.split('\n').map(line => `  ${line}`).join('\n')}
  return { ${[...requested].map(([name, declaration]) => `${JSON.stringify(name)}: ${ts.isIdentifier(declaration) ? declaration.text : (declaration.name as ts.Identifier).text}`).join(', ')} };
}
`;
  const emitted = sourceProgram(code, 'components.ts', false);
  const hygiene = createIdentifierHygiene(emitted.source, emitted.program.getTypeChecker(), fresh);
  return { ...result, renamedIdentifiers: hygiene.count,
    ...(valueBindings.size?{sourceValueContext:{name:valueContextName,bindings:[...valueBindings.values()].map(item=>item.binding)}}:{}),
    source: hygiene.count ? printer.printFile(hygiene.transform(emitted.source)) : code };
}

