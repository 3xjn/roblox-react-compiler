import ts from 'typescript';
import {unreachableFunctions} from './function-reachability.ts';

export interface JavaScriptTypeIssue {readonly start:number; readonly message:string}
export interface JavaScriptTypeOptions {readonly dynamicPropertyReads?:boolean}
export interface JavaScriptContract {
  readonly functionStart:number;
  readonly exportedName:string;
  readonly declarationFilename:string;
}
interface Edit {readonly at:number; readonly text:string}

/** Recover executable JS signatures from the package's published declaration
 * module. Never infer an implementation from declarations or replace its body. */
export function javascriptTypes(source:ts.SourceFile,declarations:ts.SourceFile,checker:ts.TypeChecker,options:JavaScriptTypeOptions={}) {
  const f=ts.factory,printer=ts.createPrinter({newLine:ts.NewLineKind.LineFeed,removeComments:true});
  const edits:Edit[]=[],issues:JavaScriptTypeIssue[]=[],contracts:JavaScriptContract[]=[];
  const callable=(node:ts.Node):node is ts.FunctionDeclaration|ts.FunctionExpression|ts.ArrowFunction=>
    ts.isFunctionDeclaration(node)||ts.isFunctionExpression(node)||ts.isArrowFunction(node);
  const alias=(symbol:ts.Symbol)=>symbol.flags&ts.SymbolFlags.Alias?checker.getAliasedSymbol(symbol):symbol;
  const exported=(file:ts.SourceFile)=>{
    const symbol=checker.getSymbolAtLocation(file);
    return new Map((symbol?checker.getExportsOfModule(symbol):[]).map(item=>[item.name,alias(item)]));
  };
  const runtime=exported(source),published=exported(declarations);
  const typed=new Set<ts.Node>();
  const print=(node:ts.Node)=>printer.printNode(ts.EmitHint.Unspecified,node,declarations).replace(/\r?\n\s*/g,' ');
  function shape(type:ts.Type,active=new Set<ts.Type>()):ts.TypeNode {
    const child=(value:ts.Type)=>shape(value,new Set(active));
    const flags=type.flags;
    for(const [flag,kind] of [[ts.TypeFlags.String,ts.SyntaxKind.StringKeyword],[ts.TypeFlags.Number,ts.SyntaxKind.NumberKeyword],
      [ts.TypeFlags.Boolean,ts.SyntaxKind.BooleanKeyword],[ts.TypeFlags.Void,ts.SyntaxKind.VoidKeyword],
      [ts.TypeFlags.Undefined,ts.SyntaxKind.UndefinedKeyword],[ts.TypeFlags.Never,ts.SyntaxKind.NeverKeyword],
      [ts.TypeFlags.Unknown,ts.SyntaxKind.UnknownKeyword],[ts.TypeFlags.NonPrimitive,ts.SyntaxKind.ObjectKeyword]] as const)if(flags&flag)return f.createKeywordTypeNode(kind);
    if(flags&ts.TypeFlags.Any)throw Error('The published declaration leaves this type as any.');
    if(flags&ts.TypeFlags.Null)return f.createLiteralTypeNode(f.createNull());
    if(type.isStringLiteral())return f.createLiteralTypeNode(f.createStringLiteral(type.value));
    if(type.isNumberLiteral())return f.createLiteralTypeNode(type.value<0?f.createPrefixUnaryExpression(ts.SyntaxKind.MinusToken,f.createNumericLiteral(-type.value)):f.createNumericLiteral(type.value));
    if(flags&ts.TypeFlags.BooleanLiteral)return f.createLiteralTypeNode(checker.typeToString(type)==='true'?f.createTrue():f.createFalse());
    if(flags&ts.TypeFlags.TypeParameter)return f.createTypeReferenceNode(type.symbol.name);
    if(active.has(type))throw Error('Recursive declaration shapes need a named native type contract.');
    active.add(type);
    if(type.isUnion())return f.createUnionTypeNode(type.types.map(child));
    if(type.isIntersection())return f.createIntersectionTypeNode(type.types.map(child));
    if(checker.isTupleType(type)){
      const tuple=type as ts.TypeReference;
      const items=checker.getTypeArguments(tuple).map(child);
      const tupleType=tuple.target as ts.TupleType;
      const elements=items.map((item,index)=>tupleType.elementFlags[index]!&ts.ElementFlags.Optional?f.createOptionalTypeNode(item):
        tupleType.elementFlags[index]!&ts.ElementFlags.Rest?f.createRestTypeNode(f.createArrayTypeNode(item)):
          tupleType.elementFlags[index]!&ts.ElementFlags.Variadic?f.createRestTypeNode(item):item);
      const node=f.createTupleTypeNode(elements);
      return tupleType.readonly?f.createTypeOperatorNode(ts.SyntaxKind.ReadonlyKeyword,node):node;
    }
    if(checker.isArrayType(type))return f.createArrayTypeNode(child(checker.getTypeArguments(type as ts.TypeReference)[0]!));
    if(!(flags&ts.TypeFlags.Object))throw Error(`Unsupported declaration type ${checker.typeToString(type)}.`);
    const signatures=checker.getSignaturesOfType(type,ts.SignatureKind.Call);
    if(checker.getSignaturesOfType(type,ts.SignatureKind.Construct).length)
      throw Error('Constructable declaration values need a checked constructor type contract.');
    const properties=checker.getPropertiesOfType(type);
    const signatureNode=(signature:ts.Signature)=>{
      const parameters=signature.parameters.map((parameter,index)=>{
        const declaration=parameter.valueDeclaration??parameter.declarations?.[0];
        if(!declaration)throw Error('A declaration parameter has no checked type.');
        const rest=ts.isParameter(declaration)&&!!declaration.dotDotDotToken;
        return f.createParameterDeclaration(undefined,rest?f.createToken(ts.SyntaxKind.DotDotDotToken):undefined,
          `arg${index}`,parameter.flags&ts.SymbolFlags.Optional?f.createToken(ts.SyntaxKind.QuestionToken):undefined,
          child(checker.getTypeOfSymbolAtLocation(parameter,declaration)));
      });
      const generics=signature.typeParameters?.map(parameter=>f.createTypeParameterDeclaration(undefined,parameter.symbol.name,
        checker.getBaseConstraintOfType(parameter)&&child(checker.getBaseConstraintOfType(parameter)!)));
      return {parameters,generics,result:child(checker.getReturnTypeOfSignature(signature))};
    };
    if(signatures.length===1&&!properties.length){
      const signature=signatureNode(signatures[0]!);
      return f.createFunctionTypeNode(signature.generics,signature.parameters,signature.result);
    }
    const members:ts.TypeElement[]=signatures.map(signature=>{
      const node=signatureNode(signature);
      return f.createCallSignature(node.generics,node.parameters,node.result);
    });
    for(const property of properties){
      const declaration=property.valueDeclaration??property.declarations?.[0];
      if(!declaration)throw Error(`Declaration property ${property.name} has no checked type.`);
      if(property.name.startsWith('__@'))throw Error('Symbol declaration properties need a native symbol type contract.');
      members.push(f.createPropertySignature(ts.getCombinedModifierFlags(declaration)&ts.ModifierFlags.Readonly?
        [f.createModifier(ts.SyntaxKind.ReadonlyKeyword)]:undefined,f.createStringLiteral(property.name),
        property.flags&ts.SymbolFlags.Optional?f.createToken(ts.SyntaxKind.QuestionToken):undefined,
        child(checker.getTypeOfSymbolAtLocation(property,declaration))));
    }
    for(const index of checker.getIndexInfosOfType(type))members.push(f.createIndexSignature(index.isReadonly?[f.createModifier(ts.SyntaxKind.ReadonlyKeyword)]:undefined,
      [f.createParameterDeclaration(undefined,undefined,'key',undefined,child(index.keyType))],child(index.type)));
    return f.createTypeLiteralNode(members);
  }
  const publishedTypes=new Set<ts.SourceFile>();
  // UMD declarations can use their checked global namespace in signatures
  // without importing it. Retain that ownership as a type-only module query;
  // the spelling comes from an actual resolved import, never the global name.
  const umdModules=new Map<ts.Symbol,string>();
  function discoverUmd(file:ts.SourceFile):void {
    const inspect=(node:ts.Node)=>{
      const specifier=ts.isImportDeclaration(node)?node.moduleSpecifier:
        ts.isImportTypeNode(node)&&ts.isLiteralTypeNode(node.argument)?node.argument.literal:undefined;
      if(specifier&&ts.isStringLiteral(specifier)){
        const module=checker.getSymbolAtLocation(specifier);
        for(const declaration of module?.declarations??[]){
          const owner=declaration.getSourceFile();
          for(const statement of owner.statements)if(ts.isNamespaceExportDeclaration(statement)){
            const symbol=checker.getSymbolAtLocation(statement.name);
            if(symbol)umdModules.set(alias(symbol),specifier.text);
          }
        }
      }
      ts.forEachChild(node,inspect);
    };
    inspect(file);
  }
  discoverUmd(source);discoverUmd(declarations);
  function declaredType(node:ts.TypeNode|undefined,fallback:()=>ts.TypeNode):ts.TypeNode {
    if(!node)return fallback();
    // An explicit any is an opaque boundary. Preserve the declaration's named
    // aliases, imports and generics instead of expanding them through missing
    // ambient libraries into a fabricated structural type.
    const transformed=ts.transform(node,[context=>root=>{
      const visit:ts.Visitor=child=>{
        if(child.kind===ts.SyntaxKind.AnyKeyword)return f.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);
        if(ts.isTypeReferenceNode(child)&&ts.isQualifiedName(child.typeName)){
          let root=child.typeName.left;
          const members=[child.typeName.right.text];
          while(ts.isQualifiedName(root)){members.unshift(root.right.text);root=root.left;}
          const symbol=checker.getSymbolAtLocation(root);
          const module=symbol&&umdModules.get(alias(symbol));
          if(module){
            const qualifier=members.slice(1).reduce<ts.EntityName>((name,member)=>f.createQualifiedName(name,member),f.createIdentifier(members[0]!));
            return f.createImportTypeNode(f.createLiteralTypeNode(f.createStringLiteral(module)),undefined,qualifier,
              child.typeArguments?.map(type=>ts.visitNode(type,visit) as ts.TypeNode));
          }
        }
        return ts.visitEachChild(child,visit,context);
      };
      return ts.visitNode(root,visit) as ts.TypeNode;
    }]);
    const result=transformed.transformed[0]!;transformed.dispose();return result;
  }
  const union=(types:readonly ts.TypeNode[])=>{
    const unique=new Map(types.map(type=>[print(type),type]));
    return unique.size===1?[...unique.values()][0]!:f.createUnionTypeNode([...unique.values()]);
  };
  const declarationOf=(signature:ts.Signature):ts.SignatureDeclaration|undefined=>{
    const declaration=signature.declaration;
    return declaration&&!ts.isJSDocSignature(declaration)?declaration:undefined;
  };
  function opaqueType(node:ts.TypeNode|undefined,seen=new Set<ts.Symbol>()):boolean {
    if(!node)return false;
    if(node.kind===ts.SyntaxKind.AnyKeyword||node.kind===ts.SyntaxKind.UnknownKeyword)return true;
    if(ts.isParenthesizedTypeNode(node))return opaqueType(node.type,seen);
    if(ts.isTypeReferenceNode(node)){
      const original=checker.getSymbolAtLocation(node.typeName);
      const symbol=original&&alias(original);
      if(!symbol||seen.has(symbol))return false;
      seen.add(symbol);
      return symbol.declarations?.some(declaration=>ts.isTypeAliasDeclaration(declaration)&&opaqueType(declaration.type,seen))??false;
    }
    return false;
  }
  function opaqueBody(fn:ts.FunctionDeclaration|ts.FunctionExpression|ts.ArrowFunction,parameter:ts.ParameterDeclaration,
    returnsOpaque:boolean):void {
    if(!ts.isIdentifier(parameter.name)||!fn.body)throw Error('An opaque parameter needs a guarded identifier body.');
    const symbol=checker.getSymbolAtLocation(parameter.name);
    if(!symbol)throw Error('An opaque parameter has no source ownership.');
    const aliases=new Set<ts.Symbol>([symbol]);
    let changed=true;
    while(changed){
      changed=false;
      const collect=(node:ts.Node)=>{
        if(ts.isVariableDeclaration(node)&&ts.isIdentifier(node.name)&&node.initializer&&ts.isIdentifier(node.initializer)
          &&aliases.has(checker.getSymbolAtLocation(node.initializer)!)){
          const alias=checker.getSymbolAtLocation(node.name);
          if(alias&&!aliases.has(alias)){aliases.add(alias);changed=true;}
        }
        ts.forEachChild(node,collect);
      };
      collect(fn.body);
    }
    const inspect=(node:ts.Node)=>{
      if(ts.isIdentifier(node)&&aliases.has(checker.getSymbolAtLocation(node)!)){
        const type=checker.getTypeAtLocation(node);
        if(type.flags&(ts.TypeFlags.Any|ts.TypeFlags.Unknown)){
          const parent=node.parent;
          const unsafe=!options.dynamicPropertyReads&&(ts.isPropertyAccessExpression(parent)||ts.isElementAccessExpression(parent))&&parent.expression===node
            ||(ts.isCallExpression(parent)||ts.isNewExpression(parent))&&parent.expression===node
            ||ts.isSpreadAssignment(parent)||ts.isSpreadElement(parent)
            ||ts.isVariableDeclaration(parent)&&parent.initializer===node&&!ts.isIdentifier(parent.name)
            ||ts.isReturnStatement(parent)&&!returnsOpaque
            ||ts.isBinaryExpression(parent)&&parent.operatorToken.kind>=ts.SyntaxKind.FirstBinaryOperator
              &&![ts.SyntaxKind.EqualsEqualsToken,ts.SyntaxKind.EqualsEqualsEqualsToken,ts.SyntaxKind.ExclamationEqualsToken,
                ts.SyntaxKind.ExclamationEqualsEqualsToken,ts.SyntaxKind.AmpersandAmpersandToken,ts.SyntaxKind.BarBarToken,
                ts.SyntaxKind.QuestionQuestionToken,ts.SyntaxKind.EqualsToken,ts.SyntaxKind.InstanceOfKeyword,
                ts.SyntaxKind.InKeyword].includes(parent.operatorToken.kind)
            ||(ts.isPrefixUnaryExpression(parent)||ts.isPostfixUnaryExpression(parent))&&parent.operator!==ts.SyntaxKind.ExclamationToken;
          if(unsafe)throw Error(`Opaque parameter ${parameter.name.getText(source)} needs a source type guard before this operation.`);
        }
      }
      ts.forEachChild(node,inspect);
    };
    inspect(fn.body);
  }
  for(const [name,symbol] of runtime){
    const contract=published.get(name);
    if(!contract||!(contract.flags&ts.SymbolFlags.Value))continue;
    let declaration=symbol.valueDeclaration;
    let fn:ts.FunctionDeclaration|ts.FunctionExpression|ts.ArrowFunction|undefined;
    if(declaration&&callable(declaration))fn=declaration;
    else if(declaration&&ts.isVariableDeclaration(declaration)&&declaration.initializer){
      let value=declaration.initializer;
      while(ts.isParenthesizedExpression(value))value=value.expression;
      if(callable(value))fn=value;
    }
    if(fn&&!fn.body)fn=symbol.declarations?.find((node):node is ts.FunctionDeclaration=>ts.isFunctionDeclaration(node)&&!!node.body);
    // Re-export barrels do not contain this executable body. Its own module
    // will be paired separately; offsets from another file cannot be applied.
    if(!fn||fn.getSourceFile()!==source||typed.has(fn))continue;
    typed.add(fn);
    const at=contract.valueDeclaration??contract.declarations?.[0]??declarations;
    const signatures=checker.getSignaturesOfType(checker.getTypeOfSymbolAtLocation(contract,at),ts.SignatureKind.Call);
    try {
      if(signatures.length===0)throw Error('An executable function needs a published call signature.');
      if(signatures.length>1&&!ts.isFunctionDeclaration(fn))throw Error('A published overloaded function value needs an explicit retained overload contract.');
      const declarationsBySignature=signatures.map(signature=>{
        const declaration=declarationOf(signature);
        if(!declaration||declaration.getSourceFile()===at.getSourceFile())return declaration;
        const instantiated=checker.signatureToSignatureDeclaration(signature,ts.SyntaxKind.CallSignature,at,
          ts.NodeBuilderFlags.NoTruncation|ts.NodeBuilderFlags.UseAliasDefinedOutsideCurrentScope);
        if(!instantiated||!ts.isCallSignatureDeclaration(instantiated))throw Error('The published callable value signature could not be instantiated.');
        return instantiated;
      });
      const hasRest=signatures.some(signature=>signature.parameters.some(parameter=>parameter.declarations?.some(node=>ts.isParameter(node)&&!!node.dotDotDotToken)));
      if(fn.parameters.length>Math.max(...signatures.map(signature=>signature.parameters.length))&&!hasRest)
        throw Error('Executable and declaration parameter lists disagree.');
      const pending:Edit[]=[];
      publishedTypes.add(at.getSourceFile());discoverUmd(at.getSourceFile());
      const parametersByName=new Map<string,ts.TypeParameterDeclaration[]>();
      for(const declaration of declarationsBySignature)for(const parameter of declaration?.typeParameters??[]){
        const list=parametersByName.get(parameter.name.text)??[];list.push(parameter);parametersByName.set(parameter.name.text,list);
      }
      const genericParameters=[...parametersByName].map(([name,parameters])=>{
        const constraints=parameters.flatMap(parameter=>parameter.constraint?[declaredType(parameter.constraint,()=>{throw Error('Missing generic constraint');})]:[]);
        const defaults=parameters.flatMap(parameter=>parameter.default?[declaredType(parameter.default,()=>{throw Error('Missing generic default');})]:[]);
        return f.createTypeParameterDeclaration(undefined,name,constraints.length===parameters.length?union(constraints):undefined,
          defaults.length===parameters.length?union(defaults):undefined);
      });
      const singleArrow=ts.isArrowFunction(fn)&&source.text[fn.parameters.pos-1]!=='(';
      let genericText='';
      if(genericParameters.length&&!fn.typeParameters?.length){
        genericText=`<${genericParameters.map(print).join(',')}${genericParameters.length===1?',':''}>`;
        if(!singleArrow)pending.push({at:fn.parameters.pos-1,text:genericText});
      }
      if(singleArrow)pending.push({at:fn.parameters[0]!.getStart(source),text:`${genericText}(`});
      for(const [index,parameter] of fn.parameters.entries()){
        if(parameter.type)continue;
        const alternatives:ts.TypeNode[]=[];
        let optional=false;
        for(const [signatureIndex,signature] of signatures.entries()){
          const symbol=signature.parameters[index];
          if(!symbol){optional=true;alternatives.push(f.createKeywordTypeNode(ts.SyntaxKind.UndefinedKeyword));continue;}
          const at=symbol.valueDeclaration??symbol.declarations?.[0]??declarations;
          const declared=declarationsBySignature[signatureIndex]?.parameters[index]??(ts.isParameter(at)?at:undefined);
          if(opaqueType(declared?.type))opaqueBody(fn,parameter,signatures.every(signature=>{
            const type=declarationOf(signature)?.type;
            return opaqueType(type);
          }));
          optional ||= !!(symbol.flags&ts.SymbolFlags.Optional)||!!declared?.questionToken;
          alternatives.push(declaredType(declared?.type,()=>shape(checker.getTypeOfSymbolAtLocation(symbol,at))));
        }
        const type=union(alternatives);
        pending.push({at:parameter.name.end,text:`${optional&&!parameter.initializer&&!parameter.dotDotDotToken?'?':''}:${print(type)}`});
      }
      if(singleArrow)pending.push({at:fn.parameters.end,text:')'});
      if(!fn.type){
        const result=union(signatures.map((signature,index)=>declaredType(declarationsBySignature[index]?.type,()=>shape(checker.getReturnTypeOfSignature(signature)))));
        if(ts.isArrowFunction(fn))pending.push({at:fn.equalsGreaterThanToken.getStart(source),text:`:${print(result)} `});
        else if(fn.body)pending.push({at:fn.body.getStart(source),text:`:${print(result)} `});
      }
      // Keep the public overload set. The executable union signature is broad
      // only inside the body and is never presented as a new callable overload.
      const hasSourceOverloads=symbol.declarations?.some(node=>ts.isFunctionDeclaration(node)&&!node.body&&node.getSourceFile()===source);
      if(signatures.length>1&&ts.isFunctionDeclaration(fn)&&fn.name&&!hasSourceOverloads){
        const overloads=signatures.map((signature,index)=>{
          const declaration=declarationsBySignature[index];
          if(!declaration)throw Error('Published overload has no source declaration.');
          const params=declaration.parameters.map((parameter,index)=>f.createParameterDeclaration(undefined,parameter.dotDotDotToken,
            ts.isIdentifier(parameter.name)?parameter.name:`arg${index}`,parameter.questionToken,
            declaredType(parameter.type,()=>shape(checker.getTypeAtLocation(parameter)))));
          return f.createFunctionDeclaration(fn.modifiers?.filter(modifier=>modifier.kind===ts.SyntaxKind.ExportKeyword),undefined,fn.name,
            declaration.typeParameters?.map(parameter=>f.createTypeParameterDeclaration(undefined,parameter.name,
              parameter.constraint&&declaredType(parameter.constraint,()=>{throw Error('Missing constraint');}),
              parameter.default&&declaredType(parameter.default,()=>{throw Error('Missing default');}))),params,
            declaredType(declaration.type,()=>shape(checker.getReturnTypeOfSignature(signature))),undefined);
        });
        pending.push({at:fn.getStart(source),text:overloads.map(print).join('\n')+'\n'});
      }
      edits.push(...pending);
      contracts.push({functionStart:fn.getStart(source),exportedName:name,declarationFilename:at.getSourceFile().fileName});
    }catch(error){issues.push({start:fn.getStart(source),message:`${name}: ${(error as Error).message}`});}
  }
  if(publishedTypes.size){
    const locals=new Set<string>();
    for(const statement of source.statements)if(ts.isImportDeclaration(statement)&&statement.importClause){
      const clause=statement.importClause;
      if(clause.name)locals.add(clause.name.text);
      if(clause.namedBindings&&ts.isNamespaceImport(clause.namedBindings))locals.add(clause.namedBindings.name.text);
      else if(clause.namedBindings)for(const element of clause.namedBindings.elements)locals.add(element.name.text);
    }
    const prefix:ts.Statement[]=[];
    const typeNames=new Set(source.statements.flatMap(statement=>
      ts.isTypeAliasDeclaration(statement)||ts.isInterfaceDeclaration(statement)||ts.isModuleDeclaration(statement)?[statement.name.text]:[]));
    for(const file of publishedTypes)for(const statement of file.statements){
      if(ts.isImportDeclaration(statement)&&statement.importClause){
        const clause=statement.importClause;
        const name=clause.name&&!locals.has(clause.name.text)?clause.name:undefined;
        const named=clause.namedBindings;
        const bindings=named&&ts.isNamespaceImport(named)?!locals.has(named.name.text)?named:undefined
          :named?f.updateNamedImports(named,named.elements.filter(element=>!locals.has(element.name.text))):undefined;
        if(!name&&(!bindings||ts.isNamedImports(bindings)&&bindings.elements.length===0))continue;
        if(name)locals.add(name.text);
        if(bindings&&ts.isNamespaceImport(bindings))locals.add(bindings.name.text);
        else if(bindings)for(const element of bindings.elements)locals.add(element.name.text);
        prefix.push(f.updateImportDeclaration(statement,statement.modifiers,f.createImportClause(true,name,bindings),statement.moduleSpecifier,statement.attributes));
      }else if(ts.isTypeAliasDeclaration(statement)||ts.isInterfaceDeclaration(statement)||ts.isModuleDeclaration(statement)){
        if(typeNames.has(statement.name.text))continue;
        typeNames.add(statement.name.text);
        const transformed=ts.transform<ts.Statement>(statement,[context=>root=>{
          const visit:ts.Visitor=node=>ts.isTypeNode(node)?declaredType(node,()=>node):ts.visitEachChild(node,visit,context);
          return ts.visitNode(root,visit) as ts.Statement;
        }]);
        prefix.push(transformed.transformed[0]!);transformed.dispose();
      }
    }
    if(prefix.length){
      let at=0;
      for(const statement of source.statements){
        if(!ts.isExpressionStatement(statement)||!ts.isStringLiteral(statement.expression))break;
        at=statement.end;
      }
      edits.push({at,text:'\n'+prefix.map(print).join('\n')+'\n'});
    }
  }
  const ordered=edits.sort((a,b)=>a.at-b.at);
  let text='',cursor=0;
  const spans:{at:number;length:number;original:number}[]=[];
  for(const edit of ordered){
    text+=source.text.slice(cursor,edit.at);
    spans.push({at:text.length,length:edit.text.length,original:edit.at});
    text+=edit.text;cursor=edit.at;
  }
  text+=source.text.slice(cursor);
  return {text,issues,contracts,original(offset:number){
    let delta=0;
    for(const span of spans){if(offset<span.at)break;if(offset<span.at+span.length)return span.original;delta+=span.length;}
    return offset-delta;
  }};
}

/** One monotone inference step for private executable helpers. Call after
 * published signatures have been installed, then recheck until no types are
 * added. Every input comes from a checked local call or callable context. */
export function javascriptPrivateTypes(source:ts.SourceFile,checker:ts.TypeChecker) {
  const f=ts.factory,printer=ts.createPrinter({newLine:ts.NewLineKind.LineFeed,removeComments:true});
  type Fn=ts.FunctionDeclaration|ts.FunctionExpression|ts.ArrowFunction;
  type Input={type:ts.Type;at:ts.Node;generics?:readonly ts.TypeParameter[]};
  type Candidate={fn:Fn;symbol:ts.Symbol;inputs:Input[][];omitted:Set<number>;blocked:boolean};
  const candidates=new Map<ts.Symbol,Candidate>(),edits:Edit[]=[],issues:JavaScriptTypeIssue[]=[];
  const callable=(node:ts.Node):node is Fn=>ts.isFunctionDeclaration(node)||ts.isFunctionExpression(node)||ts.isArrowFunction(node);
  if (/\.[cm]?jsx?$/.test(source.fileName)) {
    const annotateRest=(node:ts.Node)=>{
      if(ts.isFunctionLike(node))for(const parameter of node.parameters){
        if(parameter.dotDotDotToken&&!parameter.type&&ts.isIdentifier(parameter.name))
          edits.push({at:parameter.name.end,text:':unknown[]'});
      }
      ts.forEachChild(node,annotateRest);
    };
    annotateRest(source);
  }
  const alias=(symbol:ts.Symbol)=>symbol.flags&ts.SymbolFlags.Alias?checker.getAliasedSymbol(symbol):symbol;
  const module=checker.getSymbolAtLocation(source);
  const publicSymbols=new Set((module?checker.getExportsOfModule(module):[]).map(alias));
  const unusedFunctions=unreachableFunctions(source,checker);
  const unwrap=(node:ts.Expression):ts.Expression=>ts.isParenthesizedExpression(node)?unwrap(node.expression):node;
  function index(node:ts.Node){
    if(ts.isTypeNode(node)||unusedFunctions.has(node as ts.FunctionDeclaration))return;
    if(callable(node)&&node.body){
      const owner=ts.isFunctionDeclaration(node)?node.name
        :ts.isVariableDeclaration(node.parent)&&ts.isIdentifier(node.parent.name)?node.parent.name:undefined;
      const symbol=owner&&checker.getSymbolAtLocation(owner);
      if(symbol&&!publicSymbols.has(symbol)&&(!node.type||node.parameters.some(parameter=>!parameter.type)))
        candidates.set(symbol,{fn:node,symbol,inputs:node.parameters.map(()=>[]),omitted:new Set(),blocked:false});
    }
    ts.forEachChild(node,index);
  }
  index(source);
  // Follow only immutable local aliases. A writeable alias can receive an
  // unrelated callable and therefore cannot prove this helper's inputs.
  let changed=true;
  while(changed){
    changed=false;
    const visit=(node:ts.Node)=>{
      if(ts.isTypeNode(node)||unusedFunctions.has(node as ts.FunctionDeclaration))return;
      if(ts.isVariableDeclaration(node)&&ts.isIdentifier(node.name)&&node.initializer
        &&ts.isVariableDeclarationList(node.parent)&&!!(node.parent.flags&ts.NodeFlags.Const)){
        const initializer=unwrap(node.initializer);
        const original=ts.isIdentifier(initializer)&&checker.getSymbolAtLocation(initializer);
        const candidate=original&&candidates.get(original);
        const symbol=checker.getSymbolAtLocation(node.name);
        if(candidate&&symbol&&!candidates.has(symbol)){candidates.set(symbol,candidate);changed=true;}
      }
      ts.forEachChild(node,visit);
    };
    visit(source);
  }
  function references(node:ts.Node){
    if(ts.isTypeNode(node)||unusedFunctions.has(node as ts.FunctionDeclaration))return;
    if(ts.isIdentifier(node)){
      const symbol=checker.getSymbolAtLocation(node);
      const candidate=symbol&&candidates.get(symbol);
      if(candidate){
        const parent=node.parent;
        const declaration=(callable(parent)&&parent.name===node)||(ts.isVariableDeclaration(parent)&&parent.name===node);
        const key=(ts.isPropertyAccessExpression(parent)&&parent.name===node)
          ||(ts.isPropertyAssignment(parent)&&parent.name===node);
        if(!declaration&&!key){
          let expression:ts.Expression=node;
          while(ts.isParenthesizedExpression(expression.parent))expression=expression.parent;
          const call=expression.parent;
          if(ts.isCallExpression(call)&&call.expression===expression){
            if(call.arguments.some(ts.isSpreadElement))candidate.blocked=true;
            else for(const [position] of candidate.fn.parameters.entries()){
              const argument=call.arguments[position];
              if(!argument)candidate.omitted.add(position);
              candidate.inputs[position]!.push({type:argument?checker.getTypeAtLocation(argument):checker.getUndefinedType(),at:argument??call});
            }
          }else if(ts.isVariableDeclaration(call)&&call.initializer===expression&&ts.isIdentifier(call.name)
            &&candidates.get(checker.getSymbolAtLocation(call.name)!)===candidate){
            // The immutable alias was included in this same evidence graph.
          }else if(ts.isPropertyAccessExpression(call)&&call.expression===expression
            &&['name','length','displayName'].includes(call.name.text)){
            // Metadata observation does not invoke the helper.
          }else{
            const contextual=checker.getContextualType(expression);
            const signatures=contextual&&checker.getSignaturesOfType(contextual,ts.SignatureKind.Call);
            if(!signatures?.length)candidate.blocked=true;
            else for(const signature of signatures)for(const [position] of candidate.fn.parameters.entries()){
              const restAt=signature.parameters.findIndex(parameter=>parameter.declarations?.some(declaration=>ts.isParameter(declaration)&&!!declaration.dotDotDotToken));
              const parameter=signature.parameters[restAt>=0&&position>=restAt?restAt:position];
              if(!parameter){candidate.omitted.add(position);candidate.inputs[position]!.push({type:checker.getUndefinedType(),at:node});continue;}
              const declaration=parameter.valueDeclaration??parameter.declarations?.[0];
              if(!declaration){candidate.blocked=true;continue;}
              let type=checker.getTypeOfSymbolAtLocation(parameter,declaration);
              if(restAt>=0&&position>=restAt){
                const property=checker.getPropertyOfType(type,String(position-restAt));
                const element=property?checker.getTypeOfSymbolAtLocation(property,declaration):checker.getIndexTypeOfType(type,ts.IndexKind.Number);
                if(!element){candidate.blocked=true;continue;}
                type=element;
              }
              candidate.inputs[position]!.push({type,at:node,
                ...(signature.typeParameters?{generics:signature.typeParameters}:{})});
            }
          }
        }
      }
    }
    ts.forEachChild(node,references);
  }
  references(source);
  const print=(node:ts.Node)=>printer.printNode(ts.EmitHint.Unspecified,node,source).replace(/\r?\n\s*/g,' ');
  // JS locals do not receive a contextual type from a return statement. A
  // checked function contract may supply one only when the initializer already
  // satisfies it; required fields are never manufactured for an empty record.
  const contextualized=new Set<ts.VariableDeclaration>();
  const localReturns=(node:ts.Node,owner?:Fn):void=>{
    if(unusedFunctions.has(node as ts.FunctionDeclaration))return;
    if(callable(node))owner=node;
    if(owner?.type&&ts.isReturnStatement(node)&&node.expression&&ts.isIdentifier(node.expression)){
      const declaration=checker.getSymbolAtLocation(node.expression)?.valueDeclaration;
      if(declaration&&ts.isVariableDeclaration(declaration)&&!declaration.type&&!contextualized.has(declaration)
        &&ts.isIdentifier(declaration.name)&&declaration.initializer&&ts.isObjectLiteralExpression(declaration.initializer)
        &&declaration.initializer.properties.length===0){
        let scope:ts.Node|undefined=declaration.parent;
        while(scope&&!callable(scope))scope=scope.parent;
        const target=checker.getTypeFromTypeNode(owner.type);
        const initial=checker.getTypeAtLocation(declaration.initializer);
        if(scope===owner&&!(target.flags&(ts.TypeFlags.Any|ts.TypeFlags.Unknown|ts.TypeFlags.TypeParameter))
          &&checker.isTypeAssignableTo(initial,target)){
          contextualized.add(declaration);edits.push({at:declaration.name.end,text:`:${print(owner.type)}`});
        }
      }
    }
    ts.forEachChild(node,child=>localReturns(child,owner));
  };
  localReturns(source);
  for(const candidate of new Set(candidates.values())){
    const {fn}=candidate;
    if(candidate.blocked)continue;
    const pending:Edit[]=[],lifted=new Map<string,{name:string;constraint?:ts.TypeNode}>();
    const visible=new Map<string,ts.TypeParameterDeclaration>();
    for(let owner:ts.Node|undefined=fn;owner;owner=owner.parent)if(callable(owner))
      for(const parameter of owner.typeParameters??[])if(!visible.has(parameter.name.text))visible.set(parameter.name.text,parameter);
    const names=new Set([...visible.keys()]);
    const fresh=()=>{let name='__SourceType';for(let index=0;names.has(name);index++)name=`__SourceType${index}`;names.add(name);return name;};
    function checkedTypeNode(type:ts.Type):ts.TypeNode|undefined {
      try{return checker.typeToTypeNode(type,fn,ts.NodeBuilderFlags.NoTruncation|ts.NodeBuilderFlags.UseStructuralFallback
        |ts.NodeBuilderFlags.NoTypeReduction);}
      catch(error){
        if(!issues.some(issue=>issue.start===fn.getStart(source)))issues.push({start:fn.getStart(source),
          message:`Private signature projection failed: ${(error as Error).message}`});
        return undefined;
      }
    }
    function nativeInput(input:Input):ts.TypeNode|undefined {
      if(checker.isArrayType(input.type)){
        const element=checker.getTypeArguments(input.type as ts.TypeReference)[0];
        if(element&&element.flags&ts.TypeFlags.Any)
          return f.createArrayTypeNode(f.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword));
      }
      if(input.type.flags&ts.TypeFlags.Any)return undefined;
      let checked=input.type;
      // Flow narrowing can flatten a generic conditional into every member of
      // its constraint. Keep the checked declaration relation when it is a
      // safe supertype of the actual call input; ordinary narrowed values keep
      // their precise flow type.
      if(ts.isIdentifier(input.at)){
        const symbol=checker.getSymbolAtLocation(input.at),declaration=symbol?.valueDeclaration;
        if(symbol&&declaration&&(ts.isBindingElement(declaration)||ts.isVariableDeclaration(declaration)||ts.isParameter(declaration))){
          const declared=checker.getTypeOfSymbolAtLocation(symbol,declaration);
          const conditional=(type:ts.Type,seen=new Set<ts.Type>()):boolean=>{
            if(seen.has(type))return false;seen.add(type);
            if(type.flags&(ts.TypeFlags.Conditional|ts.TypeFlags.IndexedAccess))return true;
            if(type.isUnionOrIntersection())return type.types.some(member=>conditional(member,seen));
            return !!(type.flags&ts.TypeFlags.Object)&&(type as ts.TypeReference).typeArguments?.some(member=>conditional(member,seen))===true;
          };
          if(conditional(declared))checked=declared;
        }
      }
      const raw=checkedTypeNode(checked);
      if(!raw)return undefined;
      const generics=new Map<string,ts.TypeParameterDeclaration>();
      for(let owner:ts.Node|undefined=input.at;owner;owner=owner.parent)if(callable(owner))
        for(const parameter of owner.typeParameters??[])if(!generics.has(parameter.name.text))generics.set(parameter.name.text,parameter);
      for(const parameter of input.generics??[]){
        const declaration=parameter.symbol?.declarations?.find(ts.isTypeParameterDeclaration);
        if(declaration&&!generics.has(declaration.name.text))generics.set(declaration.name.text,declaration);
      }
      let valid=true;
      const shadow=new Set<string>();
      const transform=ts.transform(raw,[context=>root=>{
        const visit:ts.Visitor=node=>{
          if(node.kind===ts.SyntaxKind.AnyKeyword){valid=false;return node;}
          const scoped=(ts.isFunctionTypeNode(node)||ts.isConstructorTypeNode(node))?node.typeParameters:undefined;
          if(scoped?.length){
            const previous=new Set(shadow);for(const parameter of scoped)shadow.add(parameter.name.text);
            const result=ts.visitEachChild(node,visit,context);shadow.clear();for(const name of previous)shadow.add(name);return result;
          }
          if(ts.isTypeReferenceNode(node)&&ts.isIdentifier(node.typeName)&&!shadow.has(node.typeName.text)){
            const declaration=generics.get(node.typeName.text);
            if(declaration&&visible.get(node.typeName.text)!==declaration){
              const key=declaration.name.text+'|'+(declaration.constraint?print(declaration.constraint):'');
              let entry=lifted.get(key);
              if(!entry){
                entry={name:fresh()};lifted.set(key,entry);
                if(declaration.constraint){
                  const parameterType=checker.getTypeAtLocation(declaration);
                  const constraint=checker.getBaseConstraintOfType(parameterType);
                  const constraintNode=constraint&&checkedTypeNode(constraint);
                  if(!constraintNode){valid=false;return node;}
                  entry.constraint=ts.visitNode(constraintNode,visit) as ts.TypeNode;
                }
              }
              return f.createTypeReferenceNode(entry.name);
            }
          }
          return ts.visitEachChild(node,visit,context);
        };
        return ts.visitNode(root,visit) as ts.TypeNode;
      }]);
      const result=transform.transformed[0]!;transform.dispose();return valid?result:undefined;
    }
    for(const [position,parameter] of fn.parameters.entries()){
      if(parameter.type||!ts.isIdentifier(parameter.name)||parameter.dotDotDotToken)continue;
      const inputs=candidate.inputs[position]!;
      if(!inputs.length)continue;
      const types=inputs.map(nativeInput);
      if(types.some(type=>type===undefined))continue;
      const unique=[...new Map(types.map(type=>[print(type!),type!])).values()];
      const type=unique.length===1?unique[0]!:f.createUnionTypeNode(unique);
      const optional=candidate.omitted.has(position)&&!parameter.initializer;
      pending.push({at:parameter.name.end,text:`${optional?'?':''}:${print(type)}`});
    }
    // Install inputs first. Annotating an early `any`-parameter body with its
    // temporary boolean result would erase a predicate inferred on recheck.
    if(!fn.type&&fn.parameters.every(parameter=>parameter.type!==undefined)){
      const signature=checker.getSignatureFromDeclaration(fn);
      if(signature){
        const result=checker.getReturnTypeOfSignature(signature);
        const predicate=checker.getTypePredicateOfSignature(signature);
        const predicateType=predicate?.type&&nativeInput({type:predicate.type,at:fn});
        const type=predicate?.kind===ts.TypePredicateKind.Identifier&&predicateType
          ?f.createTypePredicateNode(undefined,predicate.parameterName,predicateType):nativeInput({type:result,at:fn});
        if(type){
          if(ts.isArrowFunction(fn))pending.push({at:fn.equalsGreaterThanToken.getStart(source),text:`:${print(type)} `});
          else if(fn.body)pending.push({at:fn.body.getStart(source),text:`:${print(type)} `});
        }
      }
    }
    let bareGeneric=false;
    if(pending.length&&lifted.size){
      const parameters=[...lifted.values()].map(entry=>print(f.createTypeParameterDeclaration(undefined,entry.name,entry.constraint)));
      if(fn.typeParameters?.length)pending.push({at:fn.typeParameters.end,text:','+parameters.join(',')});
      else if(ts.isArrowFunction(fn)&&source.text[fn.parameters.pos-1]!=='('){
        pending.unshift({at:fn.parameters[0]!.getStart(source),text:`<${parameters.join(',')}${parameters.length===1?',':''}>(`});
        bareGeneric=true;
      }
      else pending.push({at:fn.parameters.pos-1,text:`<${parameters.join(',')}${parameters.length===1?',':''}>`});
    }
    if(pending.length&&ts.isArrowFunction(fn)&&source.text[fn.parameters.pos-1]!=='('){
      // Parameter-list edits for a bare arrow require a real parenthesized list.
      if(!bareGeneric)pending.unshift({at:fn.parameters[0]!.getStart(source),text:'('});
      pending.push({at:fn.parameters.end,text:')'});
    }
    edits.push(...pending);
  }
  const ordered=edits.sort((a,b)=>a.at-b.at);
  let text='',cursor=0;
  const spans:{at:number;length:number;original:number}[]=[];
  for(const edit of ordered){text+=source.text.slice(cursor,edit.at);spans.push({at:text.length,length:edit.text.length,original:edit.at});text+=edit.text;cursor=edit.at;}
  text+=source.text.slice(cursor);
  return {text,issues,original(offset:number){let delta=0;for(const span of spans){if(offset<span.at)break;if(offset<span.at+span.length)return span.original;delta+=span.length;}return offset-delta;}};
}
