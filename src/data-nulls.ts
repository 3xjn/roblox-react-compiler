import ts from 'typescript';
import { createCallProof } from './call-proof.ts';
interface Context {
  checker: ts.TypeChecker;
  helper: () => ts.Expression;
  type: () => ts.TypeNode;
  global: (symbol: ts.Symbol | undefined) => boolean;
  report: (node: ts.Node, code: string, message: string) => void;
  functionCalls?: boolean;
}
export function createNullLowering(context: Context) {
  const f = ts.factory;
  const { freeCallee } = createCallProof(context.checker);
  let values = 0,
    types = 0,
    operations = 0;
  function maybeType(input:ts.Type): boolean {
    const seen = new Set<ts.Type>();
    const test = (type: ts.Type): boolean => {
      if (seen.has(type)) return false;
      seen.add(type);
      if (
        type.flags &
        (ts.TypeFlags.Null | ts.TypeFlags.Any | ts.TypeFlags.Unknown)
      )
        return true;
      if (type.isUnion()) return type.types.some(test);
      const constraint = context.checker.getBaseConstraintOfType(type);
      return constraint && constraint !== type ? test(constraint) : !!(type.flags&ts.TypeFlags.TypeParameter);
    };
    return test(input);
  }
  function maybe(node: ts.Expression): boolean {
    return maybeType(context.checker.getTypeAtLocation(ts.getOriginalNode(node)));
  }
  function call(name: string, args: readonly ts.Expression[]) {
    operations++;
    return f.createCallExpression(
      f.createPropertyAccessExpression(context.helper(), name),
      undefined,
      args,
    );
  }
  function nil(node: ts.Expression) {
    return (
      ts.isIdentifier(node) &&
      node.text === 'undefined' &&
      context.global(context.checker.getSymbolAtLocation(node))
    );
  }
  function logical(node: ts.Node): node is ts.BinaryExpression {
    return (
      ts.isBinaryExpression(node) &&
      (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
        node.operatorToken.kind === ts.SyntaxKind.BarBarToken)
    );
  }
  return {
    stats: () => ({ values, types, operations }),
    visit(
      node: ts.Node,
      visit: ts.Visitor,
    ): ts.VisitResult<ts.Node> | undefined {
      const expression = (value: ts.Expression) =>
        ts.visitNode(value, visit) as ts.Expression;
      const condition = (value: ts.Expression): ts.Expression => {
        if (ts.isParenthesizedExpression(value))
          return f.updateParenthesizedExpression(
            value,
            condition(value.expression),
          );
        if (logical(value))
          return f.updateBinaryExpression(
            value,
            condition(value.left),
            value.operatorToken,
            condition(value.right),
          );
        return maybe(value)
          ? call('truthy', [expression(value)])
          : expression(value);
      };
      if (
        ts.isLiteralTypeNode(node) &&
        node.literal.kind === ts.SyntaxKind.NullKeyword
      ) {
        types++;
        return f.createIndexedAccessTypeNode(
          context.type(),
          f.createLiteralTypeNode(f.createStringLiteral('value')),
        );
      }
      if (node.kind === ts.SyntaxKind.NullKeyword) {
        values++;
        return f.createPropertyAccessExpression(context.helper(), 'value');
      }
      if (ts.isSpreadAssignment(node) && maybe(node.expression))
        return f.updateSpreadAssignment(
          node,
          call('spreadable', [expression(node.expression)]),
        );
      if (ts.isIfStatement(node))
        return f.updateIfStatement(
          node,
          condition(node.expression),
          ts.visitNode(node.thenStatement, visit) as ts.Statement,
          node.elseStatement &&
            (ts.visitNode(node.elseStatement, visit) as ts.Statement),
        );
      if (ts.isConditionalExpression(node))
        return f.updateConditionalExpression(
          node,
          condition(node.condition),
          node.questionToken,
          expression(node.whenTrue),
          node.colonToken,
          expression(node.whenFalse),
        );
      if (ts.isWhileStatement(node))
        return f.updateWhileStatement(
          node,
          condition(node.expression),
          ts.visitNode(node.statement, visit) as ts.Statement,
        );
      if (ts.isDoStatement(node))
        return f.updateDoStatement(
          node,
          ts.visitNode(node.statement, visit) as ts.Statement,
          condition(node.expression),
        );
      if (ts.isForStatement(node))
        return f.updateForStatement(
          node,
          node.initializer &&
            (ts.visitNode(node.initializer, visit) as ts.ForInitializer),
          node.condition && condition(node.condition),
          node.incrementor && expression(node.incrementor),
          ts.visitNode(node.statement, visit) as ts.Statement,
        );
      if (
        ts.isPrefixUnaryExpression(node) &&
        node.operator === ts.SyntaxKind.ExclamationToken &&
        maybe(node.operand)
      )
        return f.updatePrefixUnaryExpression(
          node,
          call('truthy', [expression(node.operand)]),
        );
      if (ts.isBinaryExpression(node)) {
        const operator = node.operatorToken.kind;
        const equal = [
          ts.SyntaxKind.EqualsEqualsToken,
          ts.SyntaxKind.EqualsEqualsEqualsToken,
        ].includes(operator);
        const unequal = [
          ts.SyntaxKind.ExclamationEqualsToken,
          ts.SyntaxKind.ExclamationEqualsEqualsToken,
        ].includes(operator);
        const loose =
          operator === ts.SyntaxKind.EqualsEqualsToken ||
          operator === ts.SyntaxKind.ExclamationEqualsToken;
        if (equal || unequal) {
          const nullable =
            node.left.kind === ts.SyntaxKind.NullKeyword
              ? node.right
              : node.right.kind === ts.SyntaxKind.NullKeyword
                ? node.left
                : undefined;
          const undef = loose
            ? nil(node.left)
              ? node.right
              : nil(node.right)
                ? node.left
                : undefined
            : undefined;
          if (nullable || undef) {
            const test = call(loose ? 'isNullish' : 'isNull', [
              expression((nullable ?? undef)!),
            ]);
            return unequal
              ? f.createPrefixUnaryExpression(
                  ts.SyntaxKind.ExclamationToken,
                  test,
                )
              : test;
          }
          // A source expression whose precise type is null still has observable
          // evaluation (getters, calls, TDZ reads). Keep both operands, in order,
          // while giving native checking the same null narrowing as a literal.
          const leftNull = !!(context.checker.getTypeAtLocation(ts.getOriginalNode(node.left)).flags & ts.TypeFlags.Null);
          const rightNull = !!(context.checker.getTypeAtLocation(ts.getOriginalNode(node.right)).flags & ts.TypeFlags.Null);
          if (leftNull || rightNull) {
            const name = leftNull ? (loose ? 'nullishIs' : 'nullIs') : (loose ? 'isNullish' : 'isNull');
            const test = call(name, [expression(node.left), expression(node.right)]);
            return unequal ? f.createPrefixUnaryExpression(ts.SyntaxKind.ExclamationToken, test) : test;
          }
          const query =
            ts.isTypeOfExpression(node.left) && ts.isStringLiteral(node.right)
              ? { value: node.left.expression, kind: node.right }
              : ts.isTypeOfExpression(node.right) &&
                  ts.isStringLiteral(node.left)
                ? { value: node.right.expression, kind: node.left }
                : undefined;
          if (
            query &&
            maybe(query.value) &&
            [
              'undefined',
              'string',
              'number',
              'boolean',
              'function',
              'object',
              'symbol',
              'bigint',
            ].includes(query.kind.text)
          ) {
            const test = call('typeIs', [expression(query.value), query.kind]);
            return unequal
              ? f.createPrefixUnaryExpression(
                  ts.SyntaxKind.ExclamationToken,
                  test,
                )
              : test;
          }
        }
        if (
          operator === ts.SyntaxKind.QuestionQuestionToken &&
          maybe(node.left)
        ) {
          const right = expression(node.right);
          const literal =
            ts.isLiteralExpression(node.right) ||
            [
              ts.SyntaxKind.TrueKeyword,
              ts.SyntaxKind.FalseKeyword,
              ts.SyntaxKind.NullKeyword,
            ].includes(node.right.kind) ||
            nil(node.right);
          return call(literal ? 'coalesceValue' : 'coalesce', [
            expression(node.left),
            literal
              ? right
              : f.createArrowFunction(
                  undefined,
                  undefined,
                  [],
                  undefined,
                  f.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
                  right,
                ),
          ]);
        }
        if (logical(node) && maybe(node.left)) {
          if (ts.isIdentifier(node.left)) {
            const left = expression(node.left);
            const right = expression(node.right);
            return f.createConditionalExpression(call('truthy', [left]), undefined,
              operator === ts.SyntaxKind.AmpersandAmpersandToken ? right : left, undefined,
              operator === ts.SyntaxKind.AmpersandAmpersandToken ? left : right);
          }
          return call(operator === ts.SyntaxKind.AmpersandAmpersandToken ? 'andValue' : 'orValue', [
            expression(node.left),
            f.createArrowFunction(undefined, undefined, [], undefined,
              f.createToken(ts.SyntaxKind.EqualsGreaterThanToken), expression(node.right)),
          ]);
        }
        if (operator === ts.SyntaxKind.QuestionQuestionEqualsToken && maybe(node.left)) {
          // Capture the reference before its getter. Only a nullish value
          // evaluates the RHS or invokes a setter, just like source ??=.
          const receiver = f.createUniqueName('__nullishReceiver');
          const key = f.createUniqueName('__nullishKey');
          const current = f.createUniqueName('__nullishCurrent');
          let target: ts.Expression;
          const parameters: ts.ParameterDeclaration[] = [];
          const args: ts.Expression[] = [];
          if (ts.isIdentifier(node.left)) target = expression(node.left);
          else if (ts.isPropertyAccessExpression(node.left) || ts.isElementAccessExpression(node.left)) {
            parameters.push(f.createParameterDeclaration(undefined, undefined, receiver, undefined,
              f.createKeywordTypeNode(ts.SyntaxKind.AnyKeyword)));
            args.push(expression(node.left.expression));
            if (ts.isElementAccessExpression(node.left)) {
              parameters.push(f.createParameterDeclaration(undefined, undefined, key, undefined,
                f.createKeywordTypeNode(ts.SyntaxKind.AnyKeyword)));
              args.push(expression(node.left.argumentExpression));
              target = f.createElementAccessExpression(receiver, key);
            } else target = f.createPropertyAccessExpression(receiver, node.left.name);
          } else {
            context.report(node, 'null-operation', 'Nullish assignment needs an assignable source reference.');
            return node;
          }
          return f.createCallExpression(f.createParenthesizedExpression(f.createArrowFunction(
            undefined, undefined, parameters, undefined, f.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
            f.createBlock([
              f.createVariableStatement(undefined, f.createVariableDeclarationList([
                f.createVariableDeclaration(current, undefined, undefined, target),
              ], ts.NodeFlags.Const)),
              f.createIfStatement(call('isNullish', [current]), f.createBlock([
                f.createReturnStatement(f.createBinaryExpression(target,
                  f.createToken(ts.SyntaxKind.EqualsToken), expression(node.right))),
              ], true)),
              f.createReturnStatement(current),
            ], true),
          )), undefined, args);
        }
        if (loose && (maybe(node.left) || maybe(node.right))) {
          context.report(
            node,
            'null-operation',
            'Dynamic loose equality needs JavaScript coercion, beyond literal null/undefined checks.',
          );
          return node;
        }
      }
      if (
        (ts.isPropertyAccessChain(node) || ts.isElementAccessChain(node)) &&
        node.questionDotToken &&
        maybe(node.expression)
      ) {
        if (context.functionCalls && ts.isCallExpression(node.parent) && node.parent.expression === node
          && ts.isOptionalChain(node.parent)) return undefined;
        const receiver = call('optional', [expression(node.expression)]);
        return ts.isPropertyAccessChain(node)
          ? f.updatePropertyAccessChain(
              node,
              receiver,
              node.questionDotToken,
              node.name,
            )
          : f.updateElementAccessChain(
              node,
              receiver,
              node.questionDotToken,
              expression(node.argumentExpression),
            );
      }
      if (
        ts.isCallChain(node) &&
        node.questionDotToken &&
        maybe(node.expression)
      ) {
        if (context.functionCalls) return undefined;
        if (!ts.isIdentifier(node.expression) && !freeCallee(node.expression)) {
          context.report(
            node,
            'null-operation',
            'Nullable optional calls require a proven free-function target; methods, receivers, unknown members and overloads need another invocation contract.',
          );
          return node;
        }
        return f.updateCallChain(
          node,
          call('optional', [expression(node.expression)]),
          node.questionDotToken,
          node.typeArguments?.map((t) => ts.visitNode(t, visit) as ts.TypeNode),
          node.arguments.map(expression),
        );
      }
      if (ts.isTypeOfExpression(node) && maybe(node.expression))
        return call('typeOf', [expression(node.expression)]);
      if (
        ts.isTypeReferenceNode(node) &&
        ts.isIdentifier(node.typeName) &&
        node.typeName.text === 'NonNullable' &&
        context.global(context.checker.getSymbolAtLocation(node.typeName)) &&
          node.typeArguments?.length === 1 &&
          maybeType(context.checker.getTypeFromTypeNode(node.typeArguments[0]!))
      ) {
        types++;
        return f.createTypeReferenceNode('Exclude', [
          ts.visitNode(node.typeArguments[0], visit) as ts.TypeNode,
          f.createUnionTypeNode([
            f.createIndexedAccessTypeNode(
              context.type(),
              f.createLiteralTypeNode(f.createStringLiteral('value')),
            ),
            f.createKeywordTypeNode(ts.SyntaxKind.UndefinedKeyword),
          ]),
        ]);
      }
      return undefined;
    },
  };
}
