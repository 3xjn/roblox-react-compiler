import ts from 'typescript';
export interface InvocationTarget {
  readonly callee: ts.Expression;
  readonly receiver?: ts.Expression;
  readonly property?: string;
  readonly index?: ts.Expression;
  readonly optionalReceiver: boolean;
  readonly mode: 'free' | 'method' | 'dynamic';
}
export type ReadInvocationTarget = (owner: ts.Expression, originalCallee: ts.Expression, expression?: (node: ts.Expression) => ts.Expression) => ts.Expression | undefined;

/** Capture the reference before argument evaluation. The native helper owns the
 * null checks and invokes a checked free function or receiver ABI explicitly. */
export function lowerReferenceCall(target: InvocationTarget, node: ts.CallExpression,
  helper: ts.Expression, expression: (node: ts.Expression) => ts.Expression,
  packet: ts.Expression, explicitCount?: number, readTarget?: ReadInvocationTarget): ts.Expression {
  const f = ts.factory;
  const owner = f.createUniqueName('__callReceiver');
  const read = target.receiver ? readTarget?.(owner, target.callee, expression) ?? (target.mode==='method'
    ?f.createCallExpression(f.createPropertyAccessExpression(helper,'readMethod'),undefined,[owner,
      target.property!==undefined?f.createStringLiteral(target.property):expression(target.index!)])
    : target.property !== undefined ? f.createPropertyAccessExpression(owner, target.property)
      : f.createElementAccessExpression(owner, expression(target.index!)))
    : expression(target.callee);
  const reference = f.createCallExpression(f.createPropertyAccessExpression(helper, 'reference'), undefined, [
    target.receiver ? expression(target.receiver) : f.createVoidZero(),
    f.createArrowFunction(undefined, undefined, [f.createParameterDeclaration(undefined, undefined, owner)], undefined,
      f.createToken(ts.SyntaxKind.EqualsGreaterThanToken), read),
    f.createStringLiteral(target.mode), target.optionalReceiver ? f.createTrue() : f.createFalse(),
  ]);
  return f.createCallExpression(f.createPropertyAccessExpression(helper, target.mode === 'dynamic' ? 'invokeChecked' : 'invokeReference'), undefined, [
    reference, f.createArrowFunction(undefined, undefined, [], undefined, f.createToken(ts.SyntaxKind.EqualsGreaterThanToken), packet),
    node.questionDotToken ? f.createTrue() : f.createFalse(),
    ...(explicitCount === undefined ? [] : [f.createNumericLiteral(explicitCount)]),
  ]);
}

/** Prove the native free-function ABI from source signatures, without dropping receivers. */
export function createCallProof(checker: ts.TypeChecker, uncheckedFunctions = false) {
  function dynamicThis(node: ts.SignatureDeclaration): boolean {
    let found = node.parameters.some(
      (p) =>
        ts.isIdentifier(p.name) &&
        p.name.text === 'this' &&
        p.type?.kind !== ts.SyntaxKind.VoidKeyword,
    );
    function scan(child: ts.Node) {
      if (child.kind === ts.SyntaxKind.ThisKeyword) found = true;
      if (
        ts.isFunctionLike(child) &&
        child !== node &&
        !ts.isArrowFunction(child)
      )
        return;
      ts.forEachChild(child, scan);
    }
    if ('body' in node && node.body) scan(node.body);
    return found;
  }
  function isMethodSignature(signature: ts.Signature, callee: ts.Expression): boolean {
    const explicitThis = signature.thisParameter && checker.getTypeOfSymbolAtLocation(signature.thisParameter, callee);
    const declaration = signature.declaration;
    const voidThis = !!explicitThis && !!(explicitThis.flags & ts.TypeFlags.Void);
    const instanceMethod=declaration&&ts.isMethodDeclaration(declaration)&&ts.isClassLike(declaration.parent)
      &&!declaration.modifiers?.some(modifier=>modifier.kind===ts.SyntaxKind.StaticKeyword);
    return !!(!voidThis && (!!explicitThis || declaration &&
      (instanceMethod || (ts.isMethodSignature(declaration) || ts.isMethodDeclaration(declaration)) && !('body' in declaration && declaration.body && !dynamicThis(declaration))
        || ts.isFunctionLike(declaration) && dynamicThis(declaration))));
  }
  function freeCallee(input: ts.Expression): ts.Expression | undefined {
    let callee: ts.Expression = input;
    while (ts.isParenthesizedExpression(callee)) callee = callee.expression;
    if (
      (ts.isAsExpression(callee) || ts.isTypeAssertionExpression(callee)) &&
      callee.type.kind === ts.SyntaxKind.AnyKeyword
    ) {
      const original = checker.getNonNullableType(
        checker.getTypeAtLocation(callee.expression),
      );
      if (
        checker.getSignaturesOfType(original, ts.SignatureKind.Call)
          .length
      )
        callee = callee.expression;
    }
    const type = checker.getNonNullableType(
      checker.getTypeAtLocation(callee),
    );
    const signatures = checker.getSignaturesOfType(
      type,
      ts.SignatureKind.Call,
    );
    return signatures.every((signature) => !isMethodSignature(signature, callee)) &&
      !ts.isOptionalChain(callee) &&
      (signatures.length || (uncheckedFunctions && type.flags & ts.TypeFlags.Any))
      ? callee
      : undefined;
  }
  function invocationTarget(input: ts.Expression, checkedDynamic = false, explicitReceiver = false, optionalReceivers = false): InvocationTarget | undefined {
    let callee = input;
    while (ts.isParenthesizedExpression(callee)) callee = callee.expression;
    if ((ts.isAsExpression(callee) || ts.isTypeAssertionExpression(callee)) && callee.type.kind === ts.SyntaxKind.AnyKeyword) {
      const original = checker.getNonNullableType(checker.getTypeAtLocation(callee.expression));
      if (checker.getSignaturesOfType(original, ts.SignatureKind.Call).length) callee = callee.expression;
    }
    const type = checker.getNonNullableType(checker.getTypeAtLocation(callee));
    const signatures = checker.getSignaturesOfType(type, ts.SignatureKind.Call);
    const property = ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee) ? callee : undefined;
    // Propagating a short circuit through multiple nested optional receivers
    // requires a chain plan; do not turn it into an ordinary nullable read.
    if (property && ts.isOptionalChain(property.expression) && !optionalReceivers) return undefined;
    let mode: InvocationTarget['mode'];
    // Evolving JavaScript collections can infer null-only slots. Their
    // non-nullable type is never; an optional call must still perform the
    // runtime null check, and any later callable needs registered ABI metadata.
    const freeCallbackSet = checkedDynamic && !property && signatures.length > 0 && signatures.every(signature => {
      const declaration = signature.declaration;
      const receiver = signature.thisParameter
        ? checker.getTypeOfSymbolAtLocation(signature.thisParameter, callee)
        : undefined;
      const unsupportedThis = receiver !== undefined && !(receiver.flags & ts.TypeFlags.Void);
      // Callback aliases sometimes use a method signature only to express
      // parameter bivariance. Once held as a standalone function value, that
      // signature has no receiver unless it declares `this` or its body uses it.
      const usesThis = declaration && declaration.kind !== ts.SyntaxKind.JSDocSignature
        ? dynamicThis(declaration as ts.SignatureDeclaration)
        : false;
      return !unsupportedThis && !usesThis;
    });
    if (freeCallbackSet) mode = 'free';
    else if (checkedDynamic && !signatures.length && type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never)) mode = 'dynamic';
    else {
      if (signatures.length === 0) return undefined;
      const method = isMethodSignature(signatures[0]!, callee);
      if (!signatures.every(signature => isMethodSignature(signature, callee) === method)) return undefined;
      if (method && !property && !explicitReceiver) return undefined;
      mode = method ? 'method' : 'free';
    }
    return { callee, mode, optionalReceiver: !!property?.questionDotToken,
      ...(property ? { receiver: property.expression,
        ...(ts.isPropertyAccessExpression(property) ? { property: property.name.text } : { index: property.argumentExpression }) } : {}) };
  }
  return { dynamicThis, freeCallee, invocationTarget };
}

/** Keep short circuits distinct from ordinary undefined until the maximal
 * chain finishes, including member reads after optional method calls. */
export function lowerOptionalChain(node:ts.Expression,context:{
  checker:ts.TypeChecker;helper:ts.Expression;expression:(node:ts.Expression)=>ts.Expression;
  arrays:boolean;readTarget?:ReadInvocationTarget;
}):ts.Expression|undefined{
  if(!ts.isOptionalChain(node))return undefined;
  const f=ts.factory,{invocationTarget}=createCallProof(context.checker);
  const call=(name:string,args:readonly ts.Expression[])=>f.createCallExpression(f.createPropertyAccessExpression(context.helper,name),undefined,args);
  const arrow=(value:ts.Expression,parameters:readonly ts.ParameterDeclaration[]=[])=>f.createArrowFunction(undefined,undefined,parameters,undefined,f.createToken(ts.SyntaxKind.EqualsGreaterThanToken),value);
  const base=(value:ts.Expression)=>call('reference',[f.createVoidZero(),arrow(context.expression(value)),f.createStringLiteral('free'),f.createFalse()]);
  function reference(value:ts.Expression):ts.Expression|undefined{
    if(ts.isPropertyAccessExpression(value)||ts.isElementAccessExpression(value)){
      if(ts.isPropertyAccessExpression(value)&&ts.isPrivateIdentifier(value.name))return undefined;
      const owner=f.createUniqueName('__chainOwner');
      const previous=ts.isOptionalChain(value.expression)?reference(value.expression):base(value.expression);
      if(!previous)return undefined;
      const target=invocationTarget(value,true,false,true);
      const read=context.readTarget?.(owner,value,context.expression)??(target?.mode==='method'
        ?call('readMethod',[owner,ts.isPropertyAccessExpression(value)?f.createStringLiteral(value.name.text):context.expression(value.argumentExpression)])
        :ts.isPropertyAccessExpression(value)
        ?f.createPropertyAccessExpression(owner,value.name):f.createElementAccessExpression(owner,context.expression(value.argumentExpression)));
      return call('continueReference',[previous,arrow(read,[f.createParameterDeclaration(undefined,undefined,owner)]),
        f.createStringLiteral(target?.mode??'dynamic'),value.questionDotToken?f.createTrue():f.createFalse()]);
    }
    if(ts.isCallExpression(value)){
      let previous:ts.Expression|undefined;
      if(ts.isOptionalChain(value.expression))previous=reference(value.expression);
      else{
        const target=invocationTarget(value.expression,true,false,true);
        if(!target)return undefined;
        if(target.receiver){
          const owner=f.createUniqueName('__chainOwner');
          const read=context.readTarget?.(owner,target.callee,context.expression)??(target.mode==='method'
            ?call('readMethod',[owner,target.property!==undefined?f.createStringLiteral(target.property):context.expression(target.index!)])
            :target.property!==undefined?
            f.createPropertyAccessExpression(owner,target.property):f.createElementAccessExpression(owner,context.expression(target.index!)));
          previous=call('reference',[context.expression(target.receiver),arrow(read,[f.createParameterDeclaration(undefined,undefined,owner)]),f.createStringLiteral(target.mode),f.createFalse()]);
        }else previous=call('reference',[f.createVoidZero(),arrow(context.expression(target.callee)),f.createStringLiteral(target.mode),f.createFalse()]);
      }
      if(!previous)return undefined;
      return call('callReference',[previous,arrow(context.expression(f.createArrayLiteralExpression(value.arguments))),value.questionDotToken?f.createTrue():f.createFalse(),
        ...(context.arrays?[]:[f.createNumericLiteral(value.arguments.length)])]);
    }
    return base(value);
  }
  const result=reference(node);
  return result&&call('referenceValue',[result]);
}
