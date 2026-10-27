import ts from 'typescript';
import { createTypeProjection, type SourceFunction } from './helper-types.ts';

export function typeOnlyNamespace(node: ts.Node): node is ts.ModuleDeclaration {
  return ts.isModuleDeclaration(node) && !!node.body
    && (ts.isModuleBlock(node.body) ? node.body.statements.every(item => ts.isTypeAliasDeclaration(item)
      || ts.isInterfaceDeclaration(item) || typeOnlyNamespace(item)) : typeOnlyNamespace(node.body));
}

export interface TypeProofs {
  readonly arguments: number;
  readonly annotations: number;
  readonly nativeInferences: readonly { readonly line: number; readonly column: number; readonly type: string; readonly reason: string }[];
}
const sourceFunction = (node: ts.Node | undefined): node is SourceFunction =>
  node !== undefined && (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node));

/** Project source-owned data types before the ordinary TS lowering pass.
 * UI bindings deliberately replace source signatures. Other call signatures
 * must retain their type arguments, or fail rather than silently narrowing. */
export function createSourceTypes(source: ts.SourceFile, checker: ts.TypeChecker, options: {
  boundary: (fn: SourceFunction) => boolean;
  replacesCall: (node: ts.CallExpression) => boolean;
  report: (node: ts.Node, code: string, message: string) => void;
  project?:(node:ts.TypeNode)=>ts.TypeNode|undefined;
  trustedDeclaration?:(file:ts.SourceFile)=>boolean;
}) {
  const f = ts.factory;
  const proofs = { arguments: 0, annotations: 0,
    nativeInferences: [] as { line: number; column: number; type: string; reason: string }[] };
  function rewrite(node: ts.Node, next: ts.Node): ts.Node {
    const original = ts.getOriginalNode(node);
    if (!(ts.isCallExpression(original) || ts.isNewExpression(original) || ts.isVariableDeclaration(original)
      || ts.isParameter(original) || sourceFunction(original) || ts.isAsExpression(original)
      || ts.isTypeAssertionExpression(original) || ts.isSatisfiesExpression(original))) return next;
    const parameters: ts.TypeParameterDeclaration[] = [];
    for (let owner: ts.Node | undefined = original; owner; owner = owner.parent)
      if (sourceFunction(owner)) parameters.push(...owner.typeParameters ?? []);
    const projection = createTypeProjection(checker, parameters,options.project,options.trustedDeclaration);
    function annotation(type: ts.TypeNode | undefined, required = false): ts.TypeNode | undefined {
      if (!type) return undefined;
      try {
        const value = projection.data(type);
        if (required) proofs.arguments++; else proofs.annotations++;
        return value;
      } catch (error) {
        if (required) options.report(type, 'type-argument', (error as Error).message);
        else if (type.pos >= 0) {
          const position = source.getLineAndCharacterOfPosition(type.getStart(source));
          proofs.nativeInferences.push({ line: position.line + 1, column: position.character + 1,
            type: type.getText(source), reason: (error as Error).message });
        }
        return undefined;
      }
    }
    if ((ts.isCallExpression(next) || ts.isNewExpression(next)) && (ts.isCallExpression(original) || ts.isNewExpression(original)) && original.typeArguments?.length) {
      const replaced = ts.isCallExpression(original) && options.replacesCall(original);
      const types = replaced ? undefined : original.typeArguments.map(type => annotation(type, true)).filter((type): type is ts.TypeNode => type !== undefined);
      return ts.isNewExpression(next) ? f.updateNewExpression(next, next.expression, types, next.arguments)
        : ts.isCallChain(next) ? f.updateCallChain(next, next.expression, next.questionDotToken, types, next.arguments)
          : f.updateCallExpression(next, next.expression, types, next.arguments);
    }
    if (ts.isVariableDeclaration(next) && ts.isVariableDeclaration(original) && original.type)
      return f.updateVariableDeclaration(next, next.name, next.exclamationToken, annotation(original.type), next.initializer);
    if (ts.isParameter(next) && ts.isParameter(original) && original.type) {
      // Parameters inside an already projected function type are type syntax,
      // not executable function boundaries. Synthesized projection nodes can
      // legitimately have no source parent.
      if (!original.parent || ts.isTypeNode(original.parent)) return next;
      const boundary = original.parent && sourceFunction(original.parent) && options.boundary(original.parent);
      return f.updateParameterDeclaration(next, next.modifiers, next.dotDotDotToken, next.name, next.questionToken,
        boundary || !sourceFunction(original.parent) ? undefined : annotation(original.type), next.initializer);
    }
    if (sourceFunction(next) && sourceFunction(original)) {
      const boundary = options.boundary(original);
      const types = boundary ? undefined : original.typeParameters?.map(parameter => f.updateTypeParameterDeclaration(parameter,
        parameter.modifiers, parameter.name, annotation(parameter.constraint), annotation(parameter.default)));
      const result = boundary ? undefined : annotation(original.type);
      if (ts.isArrowFunction(next)) return f.updateArrowFunction(next, next.modifiers, types, next.parameters, result, next.equalsGreaterThanToken, next.body);
      if (ts.isFunctionDeclaration(next)) return f.updateFunctionDeclaration(next, next.modifiers, next.asteriskToken, next.name, types, next.parameters, result, next.body);
      return f.updateFunctionExpression(next, next.modifiers, next.asteriskToken, next.name, types, next.parameters, result, next.body);
    }
    if ((ts.isAsExpression(next) || ts.isTypeAssertionExpression(next) || ts.isSatisfiesExpression(next))
      && (ts.isAsExpression(original) || ts.isTypeAssertionExpression(original) || ts.isSatisfiesExpression(original))) {
      const type = ts.isTypeReferenceNode(original.type) && ts.isIdentifier(original.type.typeName) && original.type.typeName.text === 'const'
        ? f.createTypeReferenceNode('const') : annotation(original.type);
      return type ? ts.isSatisfiesExpression(next) ? f.updateSatisfiesExpression(next, next.expression, type)
        : f.createAsExpression(next.expression, type) : next.expression;
    }
    return next;
  }
  return { proofs, rewrite };
}

/** TypeScript's standard lowering keeps original nodes. Restore annotations
 * already projected by the source compiler, without reimplementing JSX or
 * introducing runtime wrappers. No original unreviewed browser type is copied. */
export function preserveTypes(context: ts.TransformationContext): ts.Transformer<ts.SourceFile> {
  const f = context.factory;
  const visit: ts.Visitor = node => {
    const next = ts.visitEachChild(node, visit, context);
    const original = ts.getOriginalNode(node);
    if (ts.isCallExpression(next) && ts.isCallExpression(original) && original.typeArguments?.length) {
      return ts.isCallChain(next)
        ? f.updateCallChain(next, next.expression, next.questionDotToken, original.typeArguments, next.arguments)
        : f.updateCallExpression(next, next.expression, original.typeArguments, next.arguments);
    }
    if (ts.isNewExpression(next) && ts.isNewExpression(original) && original.typeArguments?.length)
      return f.updateNewExpression(next, next.expression, original.typeArguments, next.arguments);
    if (ts.isVariableDeclaration(next) && ts.isVariableDeclaration(original) && original.type)
      return f.updateVariableDeclaration(next, next.name, next.exclamationToken, original.type, next.initializer);
    if (ts.isParameter(next) && ts.isParameter(original) && original.type)
      return f.updateParameterDeclaration(next, next.modifiers, next.dotDotDotToken, next.name,
        original.questionToken, original.type, next.initializer);
    if (ts.isFunctionDeclaration(next) && ts.isFunctionDeclaration(original))
      return f.updateFunctionDeclaration(next, next.modifiers, next.asteriskToken, next.name,
        original.typeParameters, next.parameters, original.type, next.body);
    if (ts.isFunctionExpression(next) && ts.isFunctionExpression(original))
      return f.updateFunctionExpression(next, next.modifiers, next.asteriskToken, next.name,
        original.typeParameters, next.parameters, original.type, next.body);
    if (ts.isArrowFunction(next) && ts.isArrowFunction(original))
      return f.updateArrowFunction(next, next.modifiers, original.typeParameters, next.parameters,
        original.type, next.equalsGreaterThanToken, next.body);
    if (ts.isPartiallyEmittedExpression(next)) {
      if (ts.isAsExpression(original) || ts.isTypeAssertionExpression(original)) return f.createAsExpression(next.expression, original.type);
      if (ts.isNonNullExpression(original)) return f.createNonNullExpression(next.expression);
      if (ts.isSatisfiesExpression(original)) return f.createSatisfiesExpression(next.expression, original.type);
    }
    return next;
  };
  return root => ts.visitNode(root, visit) as ts.SourceFile;
}
