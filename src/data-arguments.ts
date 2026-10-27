import ts from 'typescript';
import { createCallProof, lowerReferenceCall, type ReadInvocationTarget } from './call-proof.ts';

/** Explicit bindings named arguments are ordinary source values. Arrows inherit
 * the nearest ordinary function's implicit binding. */
export function implicitArgumentsOwner(node: ts.Node, checker: ts.TypeChecker): ts.FunctionDeclaration | ts.FunctionExpression | ts.MethodDeclaration | undefined {
  if (!ts.isIdentifier(node) || node.text !== 'arguments') return undefined;
  const parent = node.parent;
  if (parent && (ts.isPropertyAccessExpression(parent) && parent.name === node
    || ts.isPropertyAssignment(parent) && parent.name === node
    || ts.isBindingElement(parent) && (parent.name === node || parent.propertyName === node)
    || ts.isParameter(parent) && parent.name === node)) return undefined;
  const symbol = parent && ts.isShorthandPropertyAssignment(parent)
    ? checker.getShorthandAssignmentValueSymbol(parent) : checker.getSymbolAtLocation(node);
  if (symbol?.declarations?.length) return undefined;
  const owner = ts.findAncestor(node, ancestor => ts.isFunctionLike(ancestor) && !ts.isArrowFunction(ancestor));
  return owner && (ts.isFunctionDeclaration(owner) || ts.isFunctionExpression(owner) || ts.isMethodDeclaration(owner)) ? owner : undefined;
}

function builtinArgumentsType(type: ts.Type): boolean {
  const symbol = type.getSymbol();
  return symbol?.name === 'IArguments' && !!symbol.declarations?.length
    && symbol.declarations.every(declaration => {
      const source = declaration.getSourceFile();
      return source.isDeclarationFile && source.hasNoDefaultLib
        && /(?:^|[/\\])lib\.[^/\\]+\.d\.ts$/.test(source.fileName);
    });
}

export function sourceArgumentsType(node: ts.TypeNode, checker: ts.TypeChecker): boolean {
  return ts.isTypeReferenceNode(node) && builtinArgumentsType(checker.getTypeFromTypeNode(node));
}

/** IArguments is arraylike, but does not acquire Array.prototype methods. */
export function sourceArgumentsObject(value: ts.Expression, checker: ts.TypeChecker): boolean {
  const original = ts.getOriginalNode(value);
  if (implicitArgumentsOwner(original, checker)) return true;
  return builtinArgumentsType(checker.getTypeAtLocation(original));
}
interface Context {
  readonly sourceStrict?:boolean;
  readonly checker: ts.TypeChecker;
  readonly program?:ts.Program;
  readonly helper: () => string;
  readonly report: (node: ts.Node, code: string, message: string) => void;
  readonly uncheckedFunctions?: boolean;
  readonly functionHelper?: () => ts.Expression;
  readonly readTarget?: ReadInvocationTarget;
  readonly array: (value: ts.Expression) => boolean;
}
/** Length-aware function entry, invocation, and forwarding for source arrays. */
export function createArgumentLowering(context: Context) {
  const f = ts.factory;
  let restFunctions = 0,
    callSpreads = 0,
    forwardFunctions = 0;
  function call(name: string, args: readonly ts.Expression[]) {
    return f.createCallExpression(
      f.createPropertyAccessExpression(
        f.createIdentifier(context.helper()),
        name,
      ),
      undefined,
      args,
    );
  }
  function restInitializer(callback:ts.Expression,count:number,generic:boolean):ts.Expression {
    if(!count)return call('rest',[callback]);
    if(!generic)return call('restPrefix',[callback,f.createNumericLiteral(count)]);
    // Variadic middle-tuple inference loses higher-order generic parameters.
    // Expose the syntax-proven fixed arity to TypeScript, then instantiate the
    // existing provider with that exact tuple. The provider call stays checked.
    const names=new Set<string>();
    const scan=(node:ts.Node)=>{if(ts.isIdentifier(node))names.add(node.text);ts.forEachChild(node,scan);};scan(callback);
    const fresh=(base:string)=>{let name=base;while(names.has(name))name+='_';names.add(name);return name;};
    const fixed=Array.from({length:count},(_,index)=>fresh(`__Fixed${index}`));
    const rest=fresh('__Rest'),result=fresh('__Result'),fn=fresh('__callback');
    const reference=(name:string)=>f.createTypeReferenceNode(name);
    const typeParameters=[...fixed.map(name=>f.createTypeParameterDeclaration(undefined,name)),
      f.createTypeParameterDeclaration(undefined,rest,f.createArrayTypeNode(f.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword))),
      f.createTypeParameterDeclaration(undefined,result)];
    const parameters=[...fixed.map((name,index)=>f.createParameterDeclaration(undefined,undefined,`p${index}`,undefined,reference(name))),
      f.createParameterDeclaration(undefined,undefined,'tail',undefined,reference(rest))];
    const callbackType=f.createFunctionTypeNode(undefined,parameters,reference(result));
    const initialize=f.createCallExpression(f.createPropertyAccessExpression(f.createIdentifier(context.helper()),'restPrefix'),
      [f.createTupleTypeNode(fixed.map(reference)),reference(rest),reference(result)],[f.createIdentifier(fn),f.createNumericLiteral(count)]);
    return f.createCallExpression(f.createParenthesizedExpression(f.createArrowFunction(undefined,typeParameters,
      [f.createParameterDeclaration(undefined,undefined,fn,undefined,callbackType)],undefined,f.createToken(ts.SyntaxKind.EqualsGreaterThanToken),initialize)),undefined,[callback]);
  }
  const { dynamicThis, freeCallee, invocationTarget } = createCallProof(context.checker, context.uncheckedFunctions);
  const overloads=new Map<ts.Symbol,{implementation:ts.FunctionDeclaration;declarations:ts.FunctionDeclaration[];valid:boolean}>();
  const semantic=new Map<ts.SourceFile,readonly ts.Diagnostic[]>();
  function overloadPlan(node:ts.FunctionDeclaration) {
    const original=ts.getOriginalNode(node) as ts.FunctionDeclaration;
    const symbol=original.name&&context.checker.getSymbolAtLocation(original.name);
    if(!symbol)return undefined;
    const prior=overloads.get(symbol);if(prior)return prior;
    const declarations=symbol.declarations?.filter(ts.isFunctionDeclaration)??[];
    const implementation=declarations.find(declaration=>declaration.body&&declaration.parameters.some(parameter=>parameter.dotDotDotToken));
    const signatures=declarations.filter(declaration=>!declaration.body);
    if(!implementation||!signatures.length)return undefined;
    const source=implementation.getSourceFile();
    let valid=!!context.program&&signatures.every(declaration=>declaration.getSourceFile()===source);
    if(context.program){
      let diagnostics=semantic.get(source);
      if(!diagnostics){diagnostics=context.program.getSemanticDiagnostics(source);semantic.set(source,diagnostics);}
      valid=valid&&!diagnostics.some(diagnostic=>diagnostic.code===2394&&diagnostic.start!==undefined
        &&declarations.some(declaration=>diagnostic.start!>=declaration.getStart(source)&&diagnostic.start!<declaration.end));
    }
    const plan={implementation,declarations:signatures,valid};overloads.set(symbol,plan);return plan;
  }
  function overloadContract(node:ts.FunctionDeclaration,initializer:ts.Expression,visit:ts.Visitor) {
    const plan=overloadPlan(node);
    if(!plan)return {initializer};
    const type=ts.visitNode(f.createTypeLiteralNode(plan.declarations.map(declaration=>f.createCallSignature(
      declaration.typeParameters,declaration.parameters,declaration.type))),visit) as ts.TypeNode;
    // The original checker validates implementation compatibility. Keep the
    // same public overloads at the wrapper boundary, not its wider body type.
    return {type,initializer:f.createAsExpression(initializer,type)};
  }
  const recursive = (node: ts.FunctionExpression) => {
    if (!node.name) return false;
    const symbol = context.checker.getSymbolAtLocation(node.name);
    if (!symbol) return true;
    let found = false;
    const scan = (child: ts.Node) => {
      if (ts.isTypeNode(child)) return;
      if (ts.isIdentifier(child) && context.checker.getSymbolAtLocation(child) === symbol) found = true;
      ts.forEachChild(child, scan);
    };
    scan(node.body);
    return found;
  };
  function argumentReads(fn: ts.FunctionDeclaration | ts.FunctionExpression | ts.MethodDeclaration) {
    const reads = new Set<ts.Identifier>();
    let invalid: ts.Node | undefined;
    const scan = (node: ts.Node) => {
      if (ts.isTypeNode(node) || ts.isFunctionLike(node) && node !== fn && !ts.isArrowFunction(node)) return;
      const owner = implicitArgumentsOwner(node, context.checker);
      if (owner && (owner === fn || owner === ts.getOriginalNode(fn))) {
        const reference = node as ts.Identifier;
        const access = node.parent;
        if (access && (ts.isPropertyAccessExpression(access) && access.expression === node && access.name.text !== 'length'
          || ts.isElementAccessExpression(access) && access.expression === node && ts.isStringLiteralLike(access.argumentExpression)
            && access.argumentExpression.text !== 'length'
          || ts.isBinaryExpression(access) && access.left === node
            && access.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && access.operatorToken.kind <= ts.SyntaxKind.LastAssignment
          || ts.isDeleteExpression(access) || ts.isPrefixUnaryExpression(access) || ts.isPostfixUnaryExpression(access))) invalid = reference;
        else reads.add(reference);
      }
      ts.forEachChild(node, scan);
    };
    for (const parameter of fn.parameters) if (parameter.initializer) scan(parameter.initializer);
    if (fn.body) scan(fn.body);
    return {reads, invalid};
  }
  const nativeRest=new WeakSet<ts.ParameterDeclaration>();
  const constructors=new WeakSet<ts.ClassDeclaration>();
  const methods=new Map<ts.ClassDeclaration,Set<string>>();
  function classOwner(node:ts.Node):ts.ClassDeclaration|undefined {
    const owner=node.parent;
    return owner&&ts.isClassDeclaration(owner)&&owner.name?owner:undefined;
  }
  function methodName(node:ts.MethodDeclaration):string|undefined {
    return ts.isIdentifier(node.name)||ts.isStringLiteral(node.name)||ts.isNumericLiteral(node.name)?node.name.text:undefined;
  }
  function replaceArguments<T extends ts.Node>(node:T,reads:Set<ts.Identifier>,name:string):T {
    const transformed=ts.transform(node,[transform=>root=>{
      const replace:ts.Visitor=child=>{
        if(ts.isShorthandPropertyAssignment(child)&&reads.has(child.name))
          return f.createPropertyAssignment(child.name,ts.setOriginalNode(f.createIdentifier(name),child.name));
        return ts.isIdentifier(child)&&reads.has(child)?ts.setOriginalNode(f.createIdentifier(name),child):ts.visitEachChild(child,replace,transform);
      };
      return ts.visitEachChild(root,replace,transform);
    }]);
    const updated=transformed.transformed[0]!;transformed.dispose();return updated;
  }
  function registrations(statement:ts.Statement):readonly ts.Statement[]{
      const original=ts.getOriginalNode(statement);
      if(!ts.isClassDeclaration(original)||!original.name)return [];
      const result:ts.Statement[]=[];
      const base=original.heritageClauses?.find(clause=>clause.token===ts.SyntaxKind.ExtendsKeyword)?.types[0]?.expression;
      const inheritedRest=!original.members.some(ts.isConstructorDeclaration)&&base
        &&context.checker.getTypeAtLocation(base).getConstructSignatures().some(signature=>
          signature.parameters.some(parameter=>parameter.declarations?.some(declaration=>ts.isParameter(declaration)&&!!declaration.dotDotDotToken)));
      if(constructors.has(original)||inheritedRest)
        result.push(f.createExpressionStatement(call('bindConstructor',[f.createIdentifier(original.name.text)])));
      for(const name of methods.get(original)??[]){
        let bound=call('bindMethod',[f.createIdentifier(original.name.text),f.createStringLiteral(name)]);
        const method=original.members.find((member):member is ts.MethodDeclaration=>ts.isMethodDeclaration(member)&&methodName(member)===name);
        if(context.functionHelper&&method){
          let length=0;for(const parameter of method.parameters){if(ts.isIdentifier(parameter.name)&&parameter.name.text==='this')continue;if(parameter.initializer||parameter.dotDotDotToken)break;length++;}
          bound=f.createCallExpression(f.createPropertyAccessExpression(context.functionHelper(),'named'),undefined,
            [bound,f.createStringLiteral(name),f.createNumericLiteral(length),f.createTrue()]);
        }
        result.push(f.createExpressionStatement(bound));
      }
      return result;
  }
  return {
    stats: () => ({ restFunctions, callSpreads, forwardFunctions }),
    nativeRest:(node:ts.ParameterDeclaration)=>nativeRest.has(node)||nativeRest.has(ts.getOriginalNode(node) as ts.ParameterDeclaration),
    visit(
      node: ts.Node,
      visit: ts.Visitor,
    ): ts.VisitResult<ts.Node> | undefined {
      if(ts.isFunctionDeclaration(node)&&!node.body){
        const plan=overloadPlan(node);
        if(plan?.valid)return f.createNotEmittedStatement(node);
      }
      const expression = (value: ts.Expression) =>
        ts.visitNode(value, visit) as ts.Expression;
      const argumentObject = (value: ts.Expression) => sourceArgumentsObject(value, context.checker);
      const iterable = (value: ts.Expression) => context.array(value) || argumentObject(value);
      if(ts.isClassDeclaration(node)){
        const updated=f.updateClassDeclaration(node,node.modifiers,node.name,
          ts.visitNodes(node.typeParameters,visit,ts.isTypeParameterDeclaration),
          ts.visitNodes(node.heritageClauses,visit,ts.isHeritageClause),ts.visitNodes(node.members,visit,ts.isClassElement));
        const entry=registrations(updated);
        return entry.length?f.updateClassDeclaration(updated,updated.modifiers,updated.name,updated.typeParameters,updated.heritageClauses,
          [f.createClassStaticBlockDeclaration(f.createBlock(entry,true)),...updated.members]):updated;
      }
      if(ts.isCallExpression(node)&&node.expression.kind===ts.SyntaxKind.SuperKeyword){
        const constructor=ts.findAncestor(node,ts.isConstructorDeclaration);
        const owner=constructor?.parent;
        const base=owner&&ts.isClassLike(owner)?owner.heritageClauses?.find(clause=>clause.token===ts.SyntaxKind.ExtendsKeyword)?.types[0]?.expression:undefined;
        const signatures=base?context.checker.getTypeAtLocation(base).getConstructSignatures():[];
        const counts=signatures.flatMap(signature=>{
          const at=signature.parameters.findIndex(parameter=>parameter.declarations?.some(declaration=>ts.isParameter(declaration)&&!!declaration.dotDotDotToken));
          return at<0?[]:[at];
        });
        if(base&&counts.length){
          if(new Set(counts).size!==1||node.arguments.some(argument=>ts.isSpreadElement(argument)&&!iterable(argument.expression))){
            context.report(node,'array-super-arguments','Super rest calls require a checked common fixed arity and source array spreads.');return node;
          }
          const packet=expression(f.createArrayLiteralExpression(node.arguments));
          return f.updateCallExpression(node,node.expression,node.typeArguments,[f.createSpreadElement(
            call('superArguments',[expression(base),packet,f.createNumericLiteral(counts[0]!)]))]);
        }
      }
      if (ts.isTypeNode(node) && sourceArgumentsType(node, context.checker))
        return f.createArrayTypeNode(f.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword));
      const argumentLength = (value: ts.Node): value is ts.PropertyAccessExpression | ts.ElementAccessExpression =>
        (ts.isPropertyAccessExpression(value) && value.name.text === 'length'
          || ts.isElementAccessExpression(value) && ts.isStringLiteralLike(value.argumentExpression) && value.argumentExpression.text === 'length')
        && argumentObject(value.expression);
      if (ts.isBinaryExpression(node) && argumentLength(node.left)
        && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
        if (node.operatorToken.kind !== ts.SyntaxKind.EqualsToken) {
          context.report(node, 'array-arguments', 'Compound arguments length updates need a captured read/write binding.'); return node;
        }
        return call('setLength', [expression(node.left.expression), expression(node.right)]);
      }
      if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node))
        && (node.operator===ts.SyntaxKind.PlusPlusToken||node.operator===ts.SyntaxKind.MinusMinusToken) && argumentLength(node.operand)) {
        context.report(node, 'array-arguments', 'Increment/decrement arguments length needs a captured read/write binding.'); return node;
      }
      if (ts.isDeleteExpression(node) && ts.isElementAccessExpression(node.expression) && argumentObject(node.expression.expression))
        return call('remove', [expression(node.expression.expression), expression(node.expression.argumentExpression)]);
      if (argumentLength(node)) return call('length', [expression(node.expression)]);
      if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) && argumentObject(node.expression)
        && (ts.isPropertyAccessExpression(node) || ts.isStringLiteralLike(node.argumentExpression))) {
        context.report(node, 'array-arguments', 'Named arguments properties require an explicit native object contract.'); return node;
      }
      if (ts.isForOfStatement(node) && argumentObject(node.expression)) {
        if (node.awaitModifier) { context.report(node, 'array-arguments', 'Arguments support synchronous iteration only.'); return node; }
        return f.updateForOfStatement(node, undefined, ts.visitNode(node.initializer, visit) as ts.ForInitializer,
          call('values', [expression(node.expression)]), ts.visitNode(node.statement, visit) as ts.Statement);
      }
      if((ts.isConstructorDeclaration(node)||ts.isMethodDeclaration(node))&&node.body){
        const parameters=node.parameters.filter(parameter=>!(ts.isIdentifier(parameter.name)&&parameter.name.text==='this'));
        const rest=parameters.at(-1)?.dotDotDotToken?parameters.at(-1):undefined;
        const reads=ts.isMethodDeclaration(node)?argumentReads(node):{reads:new Set<ts.Identifier>(),invalid:undefined};
        if(rest||reads.reads.size||reads.invalid){
          const owner=classOwner(node),name=ts.isMethodDeclaration(node)?methodName(node):undefined;
          const staticMethod=ts.isMethodDeclaration(node)&&node.modifiers?.some(modifier=>modifier.kind===ts.SyntaxKind.StaticKeyword);
          if(!owner||ts.isMethodDeclaration(node)&&(!name||node.asteriskToken)||reads.invalid
            ||owner&&ts.isMethodDeclaration(node)&&!staticMethod&&owner.members.some(member=>ts.isMethodDeclaration(member)&&methodName(member)===name
              &&member.modifiers?.some(modifier=>modifier.kind===ts.SyntaxKind.StaticKeyword))
            ||rest&&(!ts.isIdentifier(rest.name)||parameters.slice(0,-1).some(parameter=>parameter.dotDotDotToken))
            ||parameters.some(parameter=>parameter.initializer&&reads.reads.size&&[...reads.reads].some(read=>read.pos>=parameter.pos&&read.end<=parameter.end))){
            context.report(node,'array-method-arguments','Class argument packets require a named class, a final named rest parameter and body-owned arguments reads.');return node;
          }
          if(staticMethod&&!dynamicThis(node)&&!reads.reads.size){
            const ordinary=parameters.map(parameter=>f.updateParameterDeclaration(parameter,parameter.modifiers,undefined,parameter.name,
              undefined,parameter.questionToken&&parameter.type?f.createUnionTypeNode([parameter.type,f.createKeywordTypeNode(ts.SyntaxKind.UndefinedKeyword)]):parameter.type,parameter.initializer));
            const callback=f.createArrowFunction(undefined,node.typeParameters,ordinary,node.type,f.createToken(ts.SyntaxKind.EqualsGreaterThanToken),node.body);
            restFunctions++;
            let initializer=restInitializer(expression(callback),parameters.length-1,!!node.typeParameters?.length);
            if(context.functionHelper){
              let length=0;for(const parameter of parameters){if(parameter.initializer||parameter.dotDotDotToken)break;length++;}
              initializer=f.createCallExpression(f.createPropertyAccessExpression(context.functionHelper(),'named'),undefined,
                [initializer,f.createStringLiteral(name!),f.createNumericLiteral(length),f.createFalse()]);
            }
            return f.createPropertyDeclaration(node.modifiers,node.name,node.questionToken,undefined,initializer);
          }
          const names=new Set<string>();
          const collect=(child:ts.Node)=>{if(ts.isIdentifier(child))names.add(child.text);ts.forEachChild(child,collect);};collect(node);
          let packetName='__sourceArguments';while(names.has(packetName))packetName+='_';
          const packet=f.createIdentifier(packetName);
          const updated=ts.isMethodDeclaration(node)&&reads.reads.size?replaceArguments(node,reads.reads,packet.text):node;
          const body=ts.visitNode(updated.body,visit) as ts.Block;
          const entry:ts.Statement[]=[];
          if(rest&&ts.isIdentifier(rest.name)){
            nativeRest.add(rest);restFunctions++;
            entry.push(f.createExpressionStatement(f.createAssignment(rest.name,call('restArgs',[rest.name,f.createNumericLiteral(parameters.length-1)]))));
          }
          if(reads.reads.size)entry.push(f.createVariableStatement(undefined,f.createVariableDeclarationList([
            f.createVariableDeclaration(packet,undefined,undefined,call('currentArguments',[]))],ts.NodeFlags.Const)));
          const visitedParameters=updated.parameters.map(parameter=>ts.visitNode(parameter,visit) as ts.ParameterDeclaration);
          const nextBody=f.updateBlock(body,[...entry,...body.statements]);
          if(ts.isConstructorDeclaration(updated)){
            constructors.add(owner);
            return f.updateConstructorDeclaration(updated,updated.modifiers,visitedParameters,nextBody);
          }
          let registered=methods.get(owner);if(!registered){registered=new Set();methods.set(owner,registered);}registered.add(name!);
          return f.updateMethodDeclaration(updated,updated.modifiers,updated.asteriskToken,updated.name,updated.questionToken,
            updated.typeParameters,visitedParameters,updated.type&&ts.visitNode(updated.type,visit) as ts.TypeNode,nextBody);
        }
      }
      if ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) && node.body) {
        const {reads,invalid}=argumentReads(node);
        if (reads.size || invalid) {
          const original=ts.getOriginalNode(node);
          const source=original.getSourceFile();
          const directives=(body:ts.Node)=>{
            if (!ts.isBlock(body) && !ts.isSourceFile(body)) return false;
            for (const statement of body.statements) {
              if (!ts.isExpressionStatement(statement) || !ts.isStringLiteral(statement.expression)) break;
              if (statement.expression.text === 'use strict') return true;
            }
            return false;
          };
          let strict=context.sourceStrict??ts.isExternalModule(source);
          for (let owner:ts.Node|undefined=original;owner&&!strict;owner=owner.parent)
            strict=(context.sourceStrict===undefined||!ts.isSourceFile(owner))&&directives(owner)
              ||ts.isFunctionLike(owner)&&'body' in owner&&!!owner.body&&directives(owner.body);
          const parameters=node.parameters.filter(parameter=>!(ts.isIdentifier(parameter.name)&&parameter.name.text==='this'));
          const rest=parameters.at(-1)?.dotDotDotToken ? parameters.at(-1) : undefined;
          const fixed=rest ? parameters.slice(0,-1) : parameters;
          const unmapped=strict||parameters.some(parameter=>!!parameter.initializer||!!parameter.dotDotDotToken||!ts.isIdentifier(parameter.name));
          const overload=ts.isFunctionDeclaration(node)?overloadPlan(node):undefined;
          const receiver=ts.isFunctionExpression(node)&&dynamicThis(node);
          if (invalid || !receiver&&dynamicThis(node) || node.asteriskToken || ts.isFunctionExpression(node)&&recursive(node)
            || parameters.length>0&&!unmapped || rest&&!ts.isIdentifier(rest.name) || overload&&!overload.valid) {
            context.report(invalid??node,'array-arguments','Arguments require an unmapped parameter list and a free receiver ABI; binding reassignment and named arguments properties are unsupported.');
            return node;
          }
          const names=new Set<string>();
          const collect=(child:ts.Node)=>{if(ts.isIdentifier(child))names.add(child.text);ts.forEachChild(child,collect);};collect(node);
          let name='__sourceArguments';while(names.has(name))name+='_';
          const packet=f.createIdentifier(name);
          const transformed=ts.transform(node,[transform=>root=>{
            const replace:ts.Visitor=child=> {
              if (ts.isShorthandPropertyAssignment(child) && reads.has(child.name))
                return f.createPropertyAssignment(child.name, ts.setOriginalNode(f.createIdentifier(name), child.name));
              return ts.isIdentifier(child) && reads.has(child)
                ? ts.setOriginalNode(f.createIdentifier(name),child) : ts.visitEachChild(child,replace,transform);
            };
            return ts.visitEachChild(root,replace,transform);
          }]);
          const updated=transformed.transformed[0]!;transformed.dispose();
          const callbackParameters=updated.parameters.filter(parameter=>!(ts.isIdentifier(parameter.name)&&parameter.name.text==='this'))
            .map(parameter=>f.updateParameterDeclaration(parameter,parameter.modifiers,undefined,parameter.name,
              rest ? undefined : parameter.questionToken,
              rest&&parameter.questionToken&&parameter.type?f.createUnionTypeNode([parameter.type,f.createKeywordTypeNode(ts.SyntaxKind.UndefinedKeyword)]):parameter.type,
              parameter.initializer));
          const modifiers=node.modifiers?.some(modifier=>modifier.kind===ts.SyntaxKind.AsyncKeyword)?[f.createModifier(ts.SyntaxKind.AsyncKeyword)]:undefined;
          const packed=[f.createParameterDeclaration(undefined,undefined,packet,undefined,f.createArrayTypeNode(f.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword))),...callbackParameters];
          const callback=receiver?f.createFunctionExpression(modifiers,undefined,undefined,node.typeParameters,
            [node.parameters.find(parameter=>ts.isIdentifier(parameter.name)&&parameter.name.text==='this')??f.createParameterDeclaration(undefined,undefined,'this',undefined,f.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword)),...packed],node.type,updated.body!)
            :f.createArrowFunction(modifiers,node.typeParameters,packed,node.type,f.createToken(ts.SyntaxKind.EqualsGreaterThanToken),updated.body!);
          let initializer:ts.Expression=call(receiver?'withMethodArguments':'withArguments',[expression(callback),...(rest?[f.createNumericLiteral(fixed.length)]:[])]);
          restFunctions++;
          if(ts.isFunctionExpression(node))return initializer;
          if(!node.name){context.report(node,'array-arguments','Anonymous declarations require a named public binding.');return node;}
          if(context.functionHelper){
            let length=0;for(const parameter of parameters){if(parameter.initializer||parameter.dotDotDotToken)break;length++;}
            initializer=f.createCallExpression(f.createPropertyAccessExpression(context.functionHelper(),'named'),undefined,
              [initializer,f.createStringLiteral(node.name.text),f.createNumericLiteral(length),f.createFalse()]);
          }
          const contract=overloadContract(node,initializer,visit);
          return ts.setOriginalNode(f.createVariableStatement(node.modifiers?.filter(modifier=>modifier.kind===ts.SyntaxKind.ExportKeyword),
            f.createVariableDeclarationList([f.createVariableDeclaration(node.name,undefined,contract.type,contract.initializer)],ts.NodeFlags.Let)),node);
        }
      }
      if (ts.isFunctionDeclaration(node) && node.name && node.body && node.parameters.some(parameter => parameter.dotDotDotToken)) {
        const parameters = node.parameters.filter(parameter => !(ts.isIdentifier(parameter.name) && parameter.name.text === 'this'));
        const parameter = parameters.at(-1);
        const fixed = parameters.slice(0,-1);
        const signatures = context.checker.getSignaturesOfType(context.checker.getTypeAtLocation(node.name), ts.SignatureKind.Call);
        const overload=overloadPlan(node);
        if (!parameter?.dotDotDotToken || fixed.some(parameter=>parameter.dotDotDotToken) || !ts.isIdentifier(parameter.name)
          || node.asteriskToken || dynamicThis(node) || overload&&!overload.valid || signatures.length>1&&!overload) {
          context.report(node, 'array-rest-parameter', 'Hoisted rest declarations require a final named rest parameter, a free receiver ABI and compatible checked overloads.');
          return node;
        }
        const ordinary = f.updateParameterDeclaration(parameter, parameter.modifiers, undefined, parameter.name,
          parameter.questionToken, parameter.type, parameter.initializer);
        const callback = f.createArrowFunction(node.modifiers?.filter(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword),
          node.typeParameters, [...fixed.map(parameter=>f.updateParameterDeclaration(parameter,parameter.modifiers,undefined,parameter.name,
            undefined,parameter.questionToken&&parameter.type?f.createUnionTypeNode([parameter.type,f.createKeywordTypeNode(ts.SyntaxKind.UndefinedKeyword)]):parameter.type,
            parameter.initializer)),ordinary], node.type, f.createToken(ts.SyntaxKind.EqualsGreaterThanToken), node.body);
        let initializer: ts.Expression = restInitializer(expression(callback),fixed.length,!!node.typeParameters?.length);
        let length=0;for(const parameter of fixed){if(parameter.initializer)break;length++;}
        if (context.functionHelper) initializer = f.createCallExpression(f.createPropertyAccessExpression(context.functionHelper(), 'named'), undefined,
          [initializer, f.createStringLiteral(node.name.text), f.createNumericLiteral(length), f.createFalse()]);
        restFunctions++;
        const contract=overloadContract(node,initializer,visit);
        return ts.setOriginalNode(f.createVariableStatement(node.modifiers?.filter(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword),
          f.createVariableDeclarationList([f.createVariableDeclaration(node.name, undefined, contract.type, contract.initializer)], ts.NodeFlags.Let)), node);
      }
      if(ts.isNewExpression(node)){
        const args=node.arguments??[];
        const signatures=context.checker.getTypeAtLocation(node.expression).getConstructSignatures();
        if(!args.some(ts.isSpreadElement)&&!signatures.some(signature=>signature.parameters.some(parameter=>
          parameter.declarations?.some(declaration=>ts.isParameter(declaration)&&!!declaration.dotDotDotToken))))return undefined;
        if(args.some(argument=>ts.isSpreadElement(argument)&&!iterable(argument.expression))){
          context.report(node,'array-call-spread','Only proven source arrays can supply constructor argument spreads.');return node;
        }
        callSpreads+=args.some(ts.isSpreadElement)?1:0;
        const packet=args.length===1&&ts.isSpreadElement(args[0]!)?expression(args[0].expression)
          :expression(f.createArrayLiteralExpression(args));
        const callee=expression(node.expression);
        const constructor=node.typeArguments?.length?f.createExpressionWithTypeArguments(callee,
          node.typeArguments.map(type=>ts.visitNode(type,visit) as ts.TypeNode)):callee;
        return call('construct',[constructor,packet]);
      }
      if (
        (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
        node.parameters.some((p) => p.dotDotDotToken)
      ) {
        const parameters = node.parameters.filter(
          (p) => !(ts.isIdentifier(p.name) && p.name.text === 'this'),
        );
        const parameter = parameters[parameters.length-1];
        const fixed = parameters.slice(0,-1);
        if (
          !parameter?.dotDotDotToken ||
          fixed.some(parameter=>parameter.dotDotDotToken) ||
          !ts.isIdentifier(parameter.name) ||
          (ts.isFunctionExpression(node) &&
            (recursive(node) || node.asteriskToken))
        ) {
          context.report(
            node,
            'array-rest-parameter',
            'Rest function expressions require a final named rest parameter, without a generator or recursive expression name.',
          );
          return node;
        }
        const body =
          ts.isBlock(node.body) &&
          node.body.statements.length === 1 &&
          ts.isReturnStatement(node.body.statements[0]!)
            ? node.body.statements[0].expression
            : node.body;
        if (
          !node.type &&
          !node.typeParameters?.length &&
          fixed.length===0 &&
          parameter.type &&
          !node.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) &&
          body &&
          ts.isCallExpression(body) &&
          body.arguments.length === 1 &&
          ts.isSpreadElement(body.arguments[0]!)
        ) {
          const symbol = context.checker.getSymbolAtLocation(parameter.name);
          const spread = body.arguments[0].expression;
          const proof = invocationTarget(body.expression);
          const targetType = context.checker.getTypeAtLocation(body.expression);
          const nullishSentinel = body.questionDotToken && (targetType.flags & ts.TypeFlags.Null
            || targetType.isUnion() && targetType.types.some(type => type.flags & ts.TypeFlags.Null));
          const callee = proof?.mode === 'free' && !proof.optionalReceiver && !nullishSentinel ? freeCallee(body.expression) : undefined;
          let captured = false;
          const scan = (child: ts.Node) => {
            if (ts.isTypeNode(child)) return;
            if (
              ts.isIdentifier(child) &&
              (ts.isShorthandPropertyAssignment(child.parent) &&
              child.parent.name === child
                ? context.checker.getShorthandAssignmentValueSymbol(
                    child.parent,
                  )
                : context.checker.getSymbolAtLocation(child)) === symbol
            )
              captured = true;
            ts.forEachChild(child, scan);
          };
          if (callee) scan(callee);
          if (
            callee &&
            !captured &&
            ts.isIdentifier(spread) &&
            context.checker.getSymbolAtLocation(spread) === symbol
          ) {
            forwardFunctions++;
            return f.createCallExpression(
              f.createCallExpression(
                f.createPropertyAccessExpression(
                  f.createIdentifier(context.helper()),
                  'forward',
                ),
                [ts.visitNode(parameter.type, visit) as ts.TypeNode],
                [],
              ),
              undefined,
              [
                f.createArrowFunction(
                  undefined,
                  undefined,
                  [],
                  undefined,
                  f.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
                  expression(callee),
                ),
                body.questionDotToken ? f.createTrue() : f.createFalse(),
              ],
            );
          }
        }
        restFunctions++;
        const ordinary = f.updateParameterDeclaration(
          parameter,
          parameter.modifiers,
          undefined,
          parameter.name,
          parameter.questionToken,
          parameter.type,
          parameter.initializer,
        );
        const callbackParameters=[...fixed.map(parameter=>f.updateParameterDeclaration(parameter,parameter.modifiers,undefined,
          parameter.name,undefined,parameter.questionToken&&parameter.type?
            f.createUnionTypeNode([parameter.type,f.createKeywordTypeNode(ts.SyntaxKind.UndefinedKeyword)]):parameter.type,
          parameter.initializer)),ordinary];
        const updated = ts.isArrowFunction(node)
          ? f.updateArrowFunction(
              node,
              node.modifiers,
              node.typeParameters,
              callbackParameters,
              node.type,
              node.equalsGreaterThanToken,
              node.body,
            )
          : f.updateFunctionExpression(
              node,
              node.modifiers,
              node.asteriskToken,
              undefined,
              node.typeParameters,
              callbackParameters,
              node.type,
              node.body,
            );
        if(ts.isFunctionExpression(node)&&dynamicThis(node)){
          const receiver=node.parameters.find(parameter=>ts.isIdentifier(parameter.name)&&parameter.name.text==='this')
            ??f.createParameterDeclaration(undefined,undefined,'this',undefined,f.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword));
          const callback=f.updateFunctionExpression(updated as ts.FunctionExpression,node.modifiers,node.asteriskToken,undefined,node.typeParameters,
            [receiver,f.createParameterDeclaration(undefined,undefined,f.createUniqueName('__sourceArguments'),undefined,
              f.createArrayTypeNode(f.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword))),...callbackParameters],node.type,node.body);
          return call('withMethodArguments',[expression(callback),f.createNumericLiteral(fixed.length)]);
        }
        return restInitializer(expression(updated),fixed.length,!!node.typeParameters?.length);
      }
      if (
        ts.isCallExpression(node) &&
        node.arguments.some(ts.isSpreadElement) &&
        !(
          (ts.isPropertyAccessExpression(node.expression) ||
            ts.isElementAccessExpression(node.expression)) &&
          context.array(node.expression.expression)
        )
      ) {
        const target = invocationTarget(node.expression, context.functionHelper !== undefined);
        const callee = freeCallee(node.expression);
        if (context.functionHelper && target && (target.mode !== 'free' || !callee || ts.isOptionalChain(node.expression))) {
          if (node.arguments.some(a => ts.isSpreadElement(a) && !iterable(a.expression))) {
            context.report(node, 'array-call-spread', 'Only proven source arrays can supply argument spreads.'); return node;
          }
          callSpreads++;
          const packet = node.arguments.length === 1 && ts.isSpreadElement(node.arguments[0]!)
            ? expression(node.arguments[0].expression) : expression(f.createArrayLiteralExpression(node.arguments));
          return lowerReferenceCall(target, node, context.functionHelper(), expression, packet, undefined, context.readTarget);
        }
        if (!callee) {
          context.report(
            node,
            'array-call-spread',
            'Argument spreading requires a native free-function boundary; receivers and overload sets need their own invocation contract.',
          );
          return node;
        }
        if (
          node.arguments.some(
            (a) => ts.isSpreadElement(a) && !iterable(a.expression),
          )
        ) {
          context.report(
            node,
            'array-call-spread',
            'Only proven source arrays can supply argument spreads.',
          );
          return node;
        }
        callSpreads++;
        const single =
          node.arguments.length === 1 && ts.isSpreadElement(node.arguments[0]!)
            ? node.arguments[0].expression
            : undefined;
        const packet = single
          ? () => expression(single)
          : () => expression(f.createArrayLiteralExpression(node.arguments));
        if (!node.questionDotToken)
          return call('call', [expression(callee), packet()]);
        const parameter =
          single &&
          ts.isIdentifier(single) &&
          context.checker
            .getSymbolAtLocation(single)
            ?.declarations?.some(ts.isParameter);
        if (parameter)
          return call('callOptional', [expression(callee), packet()]);
        return call('callOptionalLazy', [
          expression(callee),
          f.createArrowFunction(
            undefined,
            undefined,
            [],
            undefined,
            f.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
            packet(),
          ),
        ]);
      }
      return undefined;
    },
  };
}
