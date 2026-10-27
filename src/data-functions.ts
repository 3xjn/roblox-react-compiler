import ts from 'typescript';
import { createCallProof, lowerReferenceCall, lowerOptionalChain, type ReadInvocationTarget } from './call-proof.ts';

interface Context {
  checker: ts.TypeChecker;
  helper: () => ts.Expression;
  report: (node: ts.Node, code: string, message: string) => void;
  arrayCalls?: boolean;
  arrayHelper?: () => ts.Expression;
  projectFunctionType?: (fn: ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration) => ts.FunctionTypeNode | undefined;
  readTarget?: ReadInvocationTarget;
}
export function createFunctionLowering(context: Context) {
  const f = ts.factory;
  let names = 0,
    properties = 0,
    calls = 0,
    callableParameters = 0;
  let checkedFields = 0;
  const described = new WeakSet<ts.Node>();
  const { dynamicThis, invocationTarget } = createCallProof(context.checker);
  const arity = (fn: ts.SignatureDeclaration) => {
    let length = 0;
    for (const parameter of fn.parameters) {
      if (ts.isIdentifier(parameter.name) && parameter.name.text === 'this') continue;
      if (parameter.dotDotDotToken || parameter.initializer) break;
      length++;
    }
    return length;
  };
  const prototypeInvocation = (node: ts.Expression) => {
    if (!ts.isPropertyAccessExpression(node) || !['call', 'apply'].includes(node.name.text)) return undefined;
    const symbol = context.checker.getSymbolAtLocation(node.name);
    const builtin = symbol?.declarations?.some(declaration => ts.isMethodSignature(declaration)
      && ts.isInterfaceDeclaration(declaration.parent) && ['Function', 'CallableFunction'].includes(declaration.parent.name.text)
      && /(?:^|[/\\])lib\.[^/\\]+\.d\.ts$/.test(declaration.getSourceFile().fileName));
    return builtin ? node : undefined;
  };
  function parameterCalls(parameter: ts.ParameterDeclaration) {
    const original = ts.getOriginalNode(parameter);
    const owner = original.parent;
    if (!ts.isParameter(original) || !ts.isIdentifier(original.name) || !owner
      || !ts.isFunctionLike(owner) || !('body' in owner) || !owner.body) return undefined;
    const parameterName = original.name;
    const symbol = context.checker.getSymbolAtLocation(parameterName);
    if (!symbol) return undefined;
    let calls = 0,
      optional = true,
      valid = true;
    function scan(node: ts.Node) {
      if (ts.isTypeNode(node)) return;
      if (
        ts.isIdentifier(node) &&
        node !== parameterName &&
        (ts.isShorthandPropertyAssignment(node.parent) &&
        node.parent.name === node
          ? context.checker.getShorthandAssignmentValueSymbol(node.parent)
          : context.checker.getSymbolAtLocation(node)) === symbol
      ) {
        let expression: ts.Node = node;
        while (
          expression.parent &&
          ts.isParenthesizedExpression(expression.parent)
        )
          expression = expression.parent;
        const parent = expression.parent;
        if (
          !parent ||
          !ts.isCallExpression(parent) ||
          parent.expression !== expression
        )
          valid = false;
        else {
          calls++;
          optional &&= parent.questionDotToken !== undefined;
        }
      }
      ts.forEachChild(node, scan);
    }
    scan(owner.body);
    return valid && calls ? { optional } : undefined;
  }
  function unwrap(node: ts.Expression): ts.Expression {
    return ts.isParenthesizedExpression(node) ? unwrap(node.expression) : node;
  }
  function callable(node: ts.Expression): boolean {
    const type = context.checker.getTypeAtLocation(node);
    if (
      type.flags &
      (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never)
    )
      return false;
    return (
      context.checker.getSignaturesOfType(type, ts.SignatureKind.Call).length >
      0
    );
  }
  function receiver(node: ts.Expression) {
    const current = unwrap(node);
    const base =
      (ts.isAsExpression(current) || ts.isTypeAssertionExpression(current)) &&
      current.type.kind === ts.SyntaxKind.AnyKeyword
        ? unwrap(current.expression)
        : current;
    return callable(base) ? base : undefined;
  }
  function property(node: ts.Node) {
    if (
      !ts.isPropertyAccessExpression(node) ||
      !['name', 'displayName', 'length'].includes(node.name.text)
    )
      return undefined;
    const value = receiver(node.expression);
    return value && { value, name: node.name.text };
  }
  function call(name: string, args: readonly ts.Expression[], types?: readonly ts.TypeNode[]) {
    return f.createCallExpression(
      f.createPropertyAccessExpression(context.helper(), name),
      types,
      args,
    );
  }
  return {
    /** Insert after the hoisted declaration cluster and before source runtime
     * initializers. Descriptors must exist for calls before textual declaration
     * and for opaque consumers receiving a declared source callback. */
    registrations(statements: readonly ts.Statement[]): ts.Statement[] {
      const result: ts.Statement[] = [];
      for (const statement of statements) {
        if (!ts.isFunctionDeclaration(statement) || !statement.name || !statement.body) continue;
        const original = ts.getOriginalNode(statement);
        if (!ts.isFunctionDeclaration(original) || !original.parent) continue;
        result.push(f.createExpressionStatement(call('named', [statement.name,
          f.createStringLiteral(original.name?.text ?? statement.name.text), f.createNumericLiteral(arity(original)),
          dynamicThis(original) ? f.createTrue() : f.createFalse()])));
      }
      return result;
    },
    stats: () => ({
      names,
      properties,
      calls,
      callableParameters,
      checkedFields,
    }),
    visit(
      node: ts.Node,
      visit: ts.Visitor,
    ): ts.VisitResult<ts.Node> | undefined {
      const expression = (value: ts.Expression) =>
        ts.visitNode(value, visit) as ts.Expression;
      const chainNeedsPlan=(value:ts.Expression):boolean=>{
        if(ts.isPropertyAccessExpression(value)||ts.isElementAccessExpression(value))return ts.isOptionalChain(value.expression)
          ||ts.isOptionalChain(value)&&chainNeedsPlan(value.expression);
        if(ts.isCallExpression(value)&&ts.isOptionalChain(value))return chainNeedsPlan(value.expression);
        return false;
      };
      if(ts.isOptionalChain(node)&&chainNeedsPlan(node)&&(!node.parent||!ts.isOptionalChain(node.parent)||node.parent.expression!==node)){
        const lowered=lowerOptionalChain(node,{checker:context.checker,helper:context.helper(),expression,
          arrays:context.arrayHelper!==undefined,...(context.readTarget?{readTarget:context.readTarget}:{})});
        if(lowered){calls++;return lowered;}
      }
      const describe = (value: ts.Expression, fn: ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration, name: string) => {
        const type = context.checker.getTypeAtLocation(ts.getOriginalNode(fn));
        const typeNode = context.projectFunctionType ? context.projectFunctionType(fn)
          : context.checker.typeToTypeNode(type, fn, ts.NodeBuilderFlags.NoTruncation | ts.NodeBuilderFlags.UseAliasDefinedOutsideCurrentScope);
        let nativeValue = value;
        // roblox-ts reserves `error` for compiler-generated protected calls.
        // A named source function expression still keeps its public JS name in
        // FunctionValues metadata, so give its recursive local a safe Luau name.
        if (ts.isFunctionExpression(value) && value.name?.text === 'error') {
          const symbol = context.checker.getSymbolAtLocation(value.name);
          if (symbol) {
            const references = new Set<ts.Identifier>();
            const collect = (node: ts.Node) => {
              if (ts.isIdentifier(node) && context.checker.getSymbolAtLocation(node) === symbol) references.add(node);
              ts.forEachChild(node, collect);
            };
            collect(value);
            const safeName = f.createIdentifier('__source_named_error');
            const renamed = ts.transform(value, [transformContext => root => {
              const rename = (node: ts.Node): ts.VisitResult<ts.Node> => {
                if (ts.isIdentifier(node) && references.has(ts.getOriginalNode(node) as ts.Identifier)) return safeName;
                return ts.visitEachChild(node, rename, transformContext);
              };
              return ts.visitNode(root, rename) as ts.FunctionExpression;
            }]);
            nativeValue = renamed.transformed[0] as ts.FunctionExpression;
            renamed.dispose();
          }
        }
        return call('named', [expression(nativeValue), f.createStringLiteral(name), f.createNumericLiteral(arity(fn)),
          !ts.isArrowFunction(fn) && dynamicThis(fn) ? f.createTrue() : f.createFalse()],
          typeNode && ts.isFunctionTypeNode(typeNode) ? [ts.visitNode(typeNode, visit) as ts.TypeNode] : undefined);
      };
      if (ts.isCallExpression(node)) {
        const member = prototypeInvocation(unwrap(node.expression));
        if (member) {
          const target = invocationTarget(member.expression, true, true);
          if (!target || target.optionalReceiver || node.arguments.some(ts.isSpreadElement)
            || member.name.text === 'apply' && !context.arrayCalls) {
            context.report(node, 'function-call', 'Function.prototype invocation needs a checked callable and an explicit argument packet.'); return node;
          }
          calls++;
          const projectedRead = target.receiver ? context.readTarget?.(target.receiver, target.callee, expression) : undefined;
          const callback=projectedRead?expression(projectedRead):target.receiver&&target.mode==='method'
            ?call('readMethod',[expression(target.receiver),target.property!==undefined?f.createStringLiteral(target.property):expression(target.index!)])
            :expression(member.expression);
          return call(member.name.text === 'call' ? 'callWithThis' : 'applyWithThis', [
            callback,
            f.createArrowFunction(undefined, undefined, [], undefined, f.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
              expression(f.createArrayLiteralExpression(node.arguments))),
            f.createStringLiteral(target.mode), member.questionDotToken ? f.createTrue() : f.createFalse(),
            ...(context.arrayHelper ? [] : [f.createNumericLiteral(node.arguments.length)]),
          ]);
        }
      }
      if (ts.isCallExpression(node) && (node.questionDotToken || ts.isOptionalChain(node.expression))
        && !(context.arrayCalls && node.arguments.some(ts.isSpreadElement))) {
        const target = invocationTarget(node.expression, true);
        if (!target) {
          context.report(node, 'function-call', 'Optional invocation requires one checked callable signature and a supported receiver chain.');
          return node;
        }
        calls++;
        return lowerReferenceCall(target, node, context.helper(), expression,
          expression(f.createArrayLiteralExpression(node.arguments)), context.arrayHelper ? undefined : node.arguments.length, context.readTarget);
      }
      if (ts.isCallExpression(node) && context.readTarget && !node.arguments.some(ts.isSpreadElement)) {
        const target = invocationTarget(node.expression, true);
        if (target?.receiver && context.readTarget(target.receiver, target.callee, expression)) {
          calls++;
          return lowerReferenceCall(target, node, context.helper(), expression,
            expression(f.createArrayLiteralExpression(node.arguments)), context.arrayHelper ? undefined : node.arguments.length, context.readTarget);
        }
      }
      if (ts.isPropertyAccessExpression(node) && !node.questionDotToken) {
        const asserted = unwrap(node.expression);
        if (
          (ts.isAsExpression(asserted) ||
            ts.isTypeAssertionExpression(asserted)) &&
          asserted.type.kind === ts.SyntaxKind.AnyKeyword
        ) {
          const base = asserted.expression;
          const property = context.checker.getPropertyOfType(
            context.checker.getTypeAtLocation(base),
            node.name.text,
          );
          const type =
            property &&
            context.checker.getNonNullableType(
              context.checker.getTypeOfSymbolAtLocation(property, node),
            );
          const signatures =
            type &&
            context.checker.getSignaturesOfType(type, ts.SignatureKind.Call);
          if (
            signatures?.length === 1 &&
            signatures[0]!.thisParameter &&
            context.checker.getTypeOfSymbolAtLocation(
              signatures[0]!.thisParameter!,
              node,
            ).flags & ts.TypeFlags.Void
          ) {
            const parent = node.parent;
            if (
              !(
                ts.isBinaryExpression(parent) &&
                parent.left === node &&
                parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
                parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment
              ) &&
              !ts.isDeleteExpression(parent)
            ) {
              checkedFields++;
              return f.createNonNullExpression(
                f.createPropertyAccessExpression(expression(base), node.name),
              );
            }
          }
        }
      }
      if (
        ts.isParameter(node) &&
        node.type?.kind === ts.SyntaxKind.AnyKeyword &&
        !node.dotDotDotToken &&
        !node.initializer &&
        !node.modifiers?.length
      ) {
        const proof = parameterCalls(node);
        if (proof) {
          callableParameters++;
          const type = f.createFunctionTypeNode(
            undefined,
            [
              f.createParameterDeclaration(
                undefined,
                undefined,
                'this',
                undefined,
                f.createKeywordTypeNode(ts.SyntaxKind.VoidKeyword),
              ),
              f.createParameterDeclaration(
                undefined,
                f.createToken(ts.SyntaxKind.DotDotDotToken),
                '__args',
                undefined,
                f.createArrayTypeNode(
                  f.createKeywordTypeNode(ts.SyntaxKind.AnyKeyword),
                ),
              ),
            ],
            f.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
          );
          return f.updateParameterDeclaration(
            node,
            node.modifiers,
            node.dotDotDotToken,
            node.name,
            node.questionToken,
            proof.optional
              ? f.createUnionTypeNode([
                  type,
                  f.createKeywordTypeNode(ts.SyntaxKind.UndefinedKeyword),
                ])
              : type,
            node.initializer,
          );
        }
      }
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
      ) {
        const target = property(node.left);
        if (target) {
          if (
            target.name !== 'displayName' ||
            node.operatorToken.kind !== ts.SyntaxKind.EqualsToken
          ) {
            context.report(
              node,
              'function-property',
              'Function name/length writes and compound metadata updates need another native contract.',
            );
            return node;
          }
          properties++;
          return call('setDisplayName', [
            (()=>{const reference=invocationTarget(target.value,true,true);return reference?.receiver&&reference.mode==='method'
              ?call('readMethod',[expression(reference.receiver),reference.property!==undefined?f.createStringLiteral(reference.property):expression(reference.index!)])
              :expression(target.value);})(),
            expression(node.right),
          ]);
        }
      }
      const field = property(node);
      if (field) {
        if (ts.isPropertyAccessExpression(node) && node.questionDotToken) {
          context.report(
            node,
            'function-property',
            'Optional function metadata access needs a nullable receiver contract.',
          );
          return node;
        }
        if (node.parent && ts.isDeleteExpression(node.parent)) {
          context.report(
            node,
            'function-property',
            'Function metadata deletion needs a property-presence contract.',
          );
          return node;
        }
        properties++;
        const reference=invocationTarget(field.value,true,true);
        let value = reference?.receiver&&reference.mode==='method'
          ?call('readMethod',[expression(reference.receiver),reference.property!==undefined?f.createStringLiteral(reference.property):expression(reference.index!)])
          :expression(field.value);
        // Hoisted declaration identity is known even before its textual source
        // declaration. Register source arity on demand only if it is never
        // rebound; a signature's parameter count is not runtime Function.length.
        const symbol = context.checker.getSymbolAtLocation(field.value);
        const declaration = symbol?.declarations?.find(ts.isFunctionDeclaration);
        if (declaration?.name && field.name !== 'displayName') {
          let assigned = false;
          const scan = (child: ts.Node) => {
            if (ts.isBinaryExpression(child) && child.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && child.operatorToken.kind <= ts.SyntaxKind.LastAssignment
              && ts.isIdentifier(child.left) && context.checker.getSymbolAtLocation(child.left) === symbol) assigned = true;
            ts.forEachChild(child, scan);
          };
          scan(declaration.getSourceFile());
          if (!assigned) value = describe(field.value, declaration, declaration.name.text);
        }
        return call(field.name === 'name' ? 'name' : field.name === 'length' ? 'length' : 'displayName', [value]);
      }
      if (ts.isCallExpression(node)) {
        const callee = unwrap(node.expression);
        if (
          (ts.isAsExpression(callee) || ts.isTypeAssertionExpression(callee)) &&
          callee.type.kind === ts.SyntaxKind.AnyKeyword &&
          ts.isIdentifier(unwrap(callee.expression)) &&
          callable(callee.expression)
        ) {
          if (context.arrayCalls && node.arguments.some(ts.isSpreadElement))
            return undefined;
          const signatures = context.checker.getSignaturesOfType(
            context.checker.getTypeAtLocation(callee.expression),
            ts.SignatureKind.Call,
          );
          if (
            signatures.some((signature) => {
              const parameter = signature.thisParameter;
              return (
                parameter &&
                !(
                  context.checker.getTypeOfSymbolAtLocation(
                    parameter,
                    callee.expression,
                  ).flags & ts.TypeFlags.Void
                )
              );
            })
          ) {
            context.report(
              node,
              'function-call',
              'An explicit receiver needs a method invocation contract.',
            );
            return node;
          }
          if (
            node.questionDotToken ||
            node.arguments.some(ts.isSpreadElement)
          ) {
            context.report(
              node,
              'function-call',
              'Optional calls and source array argument spreads need a length-aware invocation contract.',
            );
            return node;
          }
          calls++;
          return call('invoke', [
            expression(callee.expression),
            ...node.arguments.map(expression),
          ]);
        }
      }
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer
      ) {
        const value = unwrap(node.initializer);
        if (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) {
          names++;
          described.add(ts.getOriginalNode(value));
          return f.updateVariableDeclaration(
            node,
            node.name,
            node.exclamationToken,
            node.type && (ts.visitNode(node.type, visit) as ts.TypeNode),
            describe(value, value,
                ts.isFunctionExpression(value) && value.name
                  ? value.name.text
                  : node.name.text,
            ),
          );
        }
      }
      if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && ts.getOriginalNode(node).parent && !described.has(ts.getOriginalNode(node))) {
        described.add(ts.getOriginalNode(node));
        names++;
        const parent=ts.getOriginalNode(node).parent;
        const inferred = ts.isFunctionExpression(node) && node.name ? node.name.text
          : ts.isPropertyAssignment(parent) && (ts.isIdentifier(parent.name) || ts.isStringLiteral(parent.name)) ? parent.name.text : '';
        return describe(node, node, inferred);
      }
      return undefined;
    },
  };
}
