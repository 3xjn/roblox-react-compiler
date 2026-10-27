import ts from 'typescript';

export function scalarString(value: string): boolean {
  for (const character of value) {
    const code=character.codePointAt(0)!;
    if(code>=0xD800&&code<=0xDFFF)return false;
  }
  return true;
}

export interface StringCall {
  readonly method: 'startsWith' | 'includes' | 'endsWith' | 'slice' | 'charCodeAt';
  readonly receiver: ts.Expression;
  readonly optional: boolean;
}

/** Only primitive strings establish the built-in contract. An object with an
 * identically named method retains its own implementation. */
export function stringCall(node: ts.CallExpression, checker: ts.TypeChecker): StringCall | undefined {
  const access=node.expression;
  if(!ts.isPropertyAccessExpression(access)&&!ts.isElementAccessExpression(access))return;
  const method=ts.isPropertyAccessExpression(access)?access.name.text
    :ts.isStringLiteral(access.argumentExpression)?access.argumentExpression.text:undefined;
  if(method!=='startsWith'&&method!=='includes'&&method!=='endsWith'&&method!=='slice'&&method!=='charCodeAt')return;
  const receiverType=checker.getTypeAtLocation(access.expression);
  const type=checker.getBaseConstraintOfType(receiverType)??receiverType;
  const members=type.isUnion()?type.types:[type];
  if(!members.length||!members.every(member=>!!(member.flags&ts.TypeFlags.StringLike)))return;
  return {method,receiver:access.expression,optional:!!node.questionDotToken||!!access.questionDotToken};
}

/** Search methods need a search operand; slice permits both endpoints to be
 * omitted. Shared by component and ordinary source-value lowering. */
export function validStringArguments(node:ts.CallExpression,call:StringCall):boolean {
  return !call.optional&&node.arguments.length>=(call.method==='slice'||call.method==='charCodeAt'?0:1)
    &&node.arguments.length<=(call.method==='charCodeAt'?1:2)
    &&!node.arguments.some(ts.isSpreadElement)&&!node.typeArguments?.length;
}
