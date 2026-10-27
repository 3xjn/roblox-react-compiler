import ts from 'typescript';
import { constAssertion, preserveConst } from './literal-const.ts';
import { createArgumentLowering } from './data-arguments.ts';
import type { ReadInvocationTarget } from './call-proof.ts';

const methods = new Set([
  'values',
  'entries',
  'map',
  'filter',
  'forEach',
  'some',
  'every',
  'find',
  'findIndex',
  'slice',
  'push',
  'pop',
  'shift',
  'unshift',
  'splice',
  'includes',
  'indexOf',
  'lastIndexOf',
  'flatMap',
  'concat',
  'reduce',
  'sort',
  'reverse',
  'fill',
  'join',
  'at',
]);
const callbacks = new Set([
  'map',
  'filter',
  'forEach',
  'some',
  'every',
  'find',
  'findIndex',
  'flatMap',
]);
interface Context {
  readonly sourceStrict?:boolean;
  readonly checker: ts.TypeChecker;
  readonly program?:ts.Program;
  readonly helper: () => string;
  readonly report: (node: ts.Node, code: string, message: string) => void;
  readonly uncheckedFunctions?: boolean;
  readonly functionHelper?: () => ts.Expression;
  readonly readTarget?: ReadInvocationTarget;
}

/** Standard source types establish array identity. The native compiler still
 * checks the emitted provider's signatures, contextual types and narrowing. */
export function createArrayLowering(context: Context) {
  const f = ts.factory;
  let literals = 0,
    operations = 0;
  const invocations = createArgumentLowering({ ...context, array });
  function array(expression: ts.Expression): boolean {
    const seen = new Set<ts.Type>();
    const test = (type: ts.Type): boolean => {
      if (
        seen.has(type) ||
        type.flags &
          (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never)
      )
        return false;
      seen.add(type);
      if (type.isUnion()) {
        const members = type.types.filter(
          (member) =>
            !(member.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined)),
        );
        return (
          members.length > 0 &&
          members.every((member) => {
            const result = test(member);
            seen.delete(member);
            return result;
          })
        );
      }
      const constraint = context.checker.getBaseConstraintOfType(type);
      return (
        context.checker.isArrayType(type) ||
        context.checker.isTupleType(type) ||
        (!!constraint && constraint !== type && test(constraint))
      );
    };
    return test(
      context.checker.getTypeAtLocation(ts.getOriginalNode(expression)),
    );
  }
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
  function length(node: ts.Node): node is ts.PropertyAccessExpression {
    return (
      ts.isPropertyAccessExpression(node) &&
      node.name.text === 'length' &&
      array(node.expression)
    );
  }
  return {
    stats: () => ({
      literals,
      operations,
      ...invocations.stats(),
    }),
    visit(
      node: ts.Node,
      visit: ts.Visitor,
    ): ts.VisitResult<ts.Node> | undefined {
      const expression = (value: ts.Expression) =>
        ts.visitNode(value, visit) as ts.Expression;
      const invocation = invocations.visit(node, visit);
      if (invocation) return invocation;
      if(ts.isForOfStatement(node)&&array(node.expression)){
        if(node.awaitModifier){context.report(node,'array-async-iteration','Source arrays support synchronous iteration only.');return node;}
        operations++;
        return f.updateForOfStatement(node,undefined,ts.visitNode(node.initializer,visit) as ts.ForInitializer,
          call('values',[expression(node.expression)]),ts.visitNode(node.statement,visit) as ts.Statement);
      }
      if (constAssertion(node) && ts.isArrayLiteralExpression(node.expression))
        return expression(node.expression);
      if (
        ts.isSpreadElement(node) &&
        !ts.isArrayLiteralExpression(node.parent) &&
        array(node.expression)
      ) {
        context.report(
          node,
          'array-call-spread',
          'This call needs an explicit length-aware native argument binding.',
        );
        return node;
      }
      if (
        ts.isParameter(node) &&
        node.dotDotDotToken &&
        ts.isFunctionLike(node.parent) &&
        'body' in node.parent &&
        node.parent.body && !invocations.nativeRest(node)
      ) {
        context.report(
          node,
          'array-rest-parameter',
          'Source rest parameters need a native vararg-count entry binding.',
        );
      }
      if (
        ts.isVariableDeclaration(node) &&
        ts.isArrayBindingPattern(node.name) &&
        node.name.elements.some(
          (element) => ts.isBindingElement(element) && element.dotDotDotToken,
        ) &&
        node.initializer &&
        array(node.initializer)
      ) {
        const elements=node.name.elements;
        const restIndex=elements.findIndex(element=>ts.isBindingElement(element)&&!!element.dotDotDotToken);
        const rest=elements[restIndex];
        // A single final rest over an ordinary source array can be expanded
        // without relying on host destructuring: evaluate the source once,
        // read each fixed item through the native array provider, then take a
        // dense slice for the tail. `spread` followed by `finish` turns holes
        // in the tail into present `undefined` entries, as destructuring does.
        // Defaults, nested patterns, and elisions need iterator-close and
        // initializer ordering contracts that this lowering does not provide.
        if(!node.type&&restIndex===elements.length-1&&rest!==undefined&&ts.isBindingElement(rest)&&ts.isIdentifier(rest.name)
          &&elements.slice(0,restIndex).every(element=>ts.isBindingElement(element)&&!element.dotDotDotToken
            &&!element.initializer&&ts.isIdentifier(element.name))){
          const source=f.createUniqueName('__arrayBindingSource');
          const declarations:ts.VariableDeclaration[]=[f.createVariableDeclaration(source,undefined,undefined,expression(node.initializer))];
          for(let index=0;index<restIndex;index++){
            const element=elements[index] as ts.BindingElement;
            declarations.push(f.createVariableDeclaration(element.name,undefined,undefined,
              call('at',[source,f.createNumericLiteral(index)])));
          }
          const tail=call('slice',[source,f.createNumericLiteral(restIndex)]);
          declarations.push(f.createVariableDeclaration(rest.name,undefined,undefined,
            call('finish',[call('spread',[tail])])));
          operations++;
          return declarations;
        }
        context.report(node,'array-binding-rest','Array binding rest requires a final simple target without defaults or elisions.');
        return node;
      }
      if (ts.isArrayLiteralExpression(node)) {
        literals++;
        if (node.elements.some(ts.isSpreadElement)) {
          return call('finish', [
            preserveConst(
              f.updateArrayLiteralExpression(
                node,
                node.elements.map((element) =>
                  ts.isSpreadElement(element)
                    ? f.createSpreadElement(
                        call('spread', [expression(element.expression)]),
                      )
                    : ts.isOmittedExpression(element)
                      ? call('hole', [])
                      : call('slot', [expression(element)]),
                ),
              ),
              node,
            ),
          ]);
        }
        const holes = node.elements.flatMap((element, index) =>
          ts.isOmittedExpression(element)
            ? [f.createNumericLiteral(index)]
            : [],
        );
        return call('literal', [
          preserveConst(
            f.updateArrayLiteralExpression(
              node,
              node.elements.map((element) =>
                ts.isOmittedExpression(element)
                  ? f.createIdentifier('undefined')
                  : expression(element),
              ),
            ),
            node,
          ),
          f.createNumericLiteral(node.elements.length),
          ...(holes.length ? [f.createArrayLiteralExpression(holes)] : []),
        ]);
      }
      if (
        ts.isBinaryExpression(node) &&
        length(node.left) &&
        node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
      ) {
        if (node.operatorToken.kind !== ts.SyntaxKind.EqualsToken) {
          context.report(
            node,
            'array-length-update',
            'Compound array length updates need a captured read/write binding.',
          );
          return node;
        }
        operations++;
        return call('setLength', [
          expression(node.left.expression),
          expression(node.right),
        ]);
      }
      if (
        (ts.isPrefixUnaryExpression(node) ||
          ts.isPostfixUnaryExpression(node)) &&
        (node.operator === ts.SyntaxKind.PlusPlusToken ||
          node.operator === ts.SyntaxKind.MinusMinusToken) &&
        length(node.operand)
      ) {
        context.report(
          node,
          'array-length-update',
          'Increment/decrement array length needs a captured read/write binding.',
        );
        return node;
      }
      if (
        ts.isDeleteExpression(node) &&
        ts.isElementAccessExpression(node.expression) &&
        array(node.expression.expression)
      ) {
        if (node.expression.questionDotToken) {
          context.report(
            node,
            'array-optional-delete',
            'Optional deletion needs a captured optional array receiver.',
          );
          return node;
        }
        operations++;
        return call('remove', [
          expression(node.expression.expression),
          expression(node.expression.argumentExpression),
        ]);
      }
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        array(node.expression.expression)
      ) {
        const method = node.expression.name.text;
        if (!methods.has(method)) {
          context.report(
            node,
            'array-method',
            `Source array method ${method} has no qualified native provider yet.`,
          );
          return node;
        }
        if (callbacks.has(method) && node.arguments.length !== 1) {
          context.report(
            node,
            'array-callback-this',
            'Array callbacks require one callback; thisArg needs an explicit native context binding.',
          );
          return node;
        }
        operations++;
        if (node.expression.questionDotToken) {
          const receiver = f.createUniqueName('__optionalArray');
          return call('optionalCall', [
            expression(node.expression.expression),
            f.createArrowFunction(undefined, undefined,
              [f.createParameterDeclaration(undefined, undefined, receiver)], undefined,
              f.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
              call(method, [receiver, ...node.arguments.map(expression)])),
          ]);
        }
        if (node.arguments.some(ts.isSpreadElement)) {
          const target =
            method === 'push'
              ? 'pushItems'
              : method === 'unshift'
                ? 'unshiftItems'
                : method === 'splice'
                  ? 'spliceArgs'
                  : method === 'concat'
                    ? 'concatItems'
                  : undefined;
          if (!target) {
            context.report(
              node,
              'array-call-spread',
              `Source array ${method} argument spreading needs a typed native binding.`,
            );
            return node;
          }
          return call(target, [
            expression(node.expression.expression),
            expression(f.createArrayLiteralExpression(node.arguments)),
          ]);
        }
        return call(method, [
          expression(node.expression.expression),
          ...node.arguments.map(expression),
        ]);
      }
      if (length(node)) {
        if (node.questionDotToken) {
          context.report(
            node,
            'array-optional-read',
            'Optional array length needs a captured optional receiver.',
          );
          return node;
        }
        operations++;
        return call('length', [expression(node.expression)]);
      }
      return undefined;
    },
  };
}
