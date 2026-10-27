import ts from 'typescript';
import type { SourceFunction } from './helper-types.ts';

/** roblox-ts rejects expression names. Keep the private recursive binding in
 * a lexical initializer scope, shared by component and data source builds. */
export function privateFunctionExpression(fn: ts.FunctionExpression): ts.CallExpression {
  if (!fn.name) throw new Error('Expected a named source function expression.');
  const f = ts.factory;
  const declaration = f.createFunctionDeclaration(fn.modifiers, fn.asteriskToken,
    fn.name, fn.typeParameters, fn.parameters, fn.type, fn.body);
  return f.createCallExpression(f.createParenthesizedExpression(f.createArrowFunction(
    undefined, undefined, [], undefined, f.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
    f.createBlock([declaration, f.createReturnStatement(fn.name)], true),
  )), undefined, []);
}

/** Keep const initializers as expressions: no new hoisting, alias or closure. */
export function updateSourceFunction<T extends SourceFunction>(
  fn: T,
  parameters: readonly ts.ParameterDeclaration[],
  body: ts.Block,
  typeParameters?: readonly ts.TypeParameterDeclaration[],
  result?: ts.TypeNode,
): T {
  const f = ts.factory;
  if (ts.isFunctionDeclaration(fn)) {
    return f.updateFunctionDeclaration(fn, undefined, undefined, fn.name,
      typeParameters, parameters, result, body) as T;
  }
  if (ts.isFunctionExpression(fn)) {
    return f.updateFunctionExpression(fn, undefined, undefined, fn.name,
      typeParameters, parameters, result, body) as T;
  }
  return f.updateArrowFunction(fn, undefined, typeParameters, parameters,
    result, fn.equalsGreaterThanToken, body) as T;
}
