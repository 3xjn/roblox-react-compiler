import ts from 'typescript';

const staticMember = (node: ts.ClassElement) => ts.canHaveModifiers(node) && ts.getModifiers(node)?.some(m => m.kind === ts.SyntaxKind.StaticKeyword);
const key = (node: ts.ClassElement) => node.name && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) ? node.name.text : undefined;

/** Native classes share their static/prototype table. Give colliding instance
 * members own slots backed by one shared function, retaining both public names
 * and method identity. This bounded ABI does not implement JS prototypes. */
export function createClassCollisionLowering(options: {
  source: ts.SourceFile;
  checker: ts.TypeChecker;
  fresh: (name: string) => string;
  report: (node: ts.Node, code: string, message: string) => void;
}) {
  const f = ts.factory;
  let classes = 0, methods = 0;
  function names(node: ts.ClassLikeDeclaration) {
    const statics = new Set(node.members.filter(staticMember).map(key).filter(v => v !== undefined));
    const methods = new Set(node.members.filter(ts.isMethodDeclaration).map(key));
    return new Set(node.members.filter(member => !staticMember(member)).map(key)
      .filter(name => name !== undefined && statics.has(name) && methods.has(name)));
  }
  function classOf(expression: ts.Expression) {
    let symbol = options.checker.getTypeAtLocation(expression).getSymbol();
    if (!symbol) symbol = options.checker.getSymbolAtLocation(expression);
    if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = options.checker.getAliasedSymbol(symbol);
    return symbol?.declarations?.find((declaration): declaration is ts.ClassLikeDeclaration =>
      (ts.isClassDeclaration(declaration) || ts.isClassExpression(declaration)) && !declaration.getSourceFile().isDeclarationFile);
  }
  function validate(node: ts.Node) {
    if ((ts.isClassDeclaration(node) || ts.isClassExpression(node)) && names(node).size
      && (!ts.isClassDeclaration(node) || node.parent !== options.source))
      options.report(node, 'class-collision', 'Colliding members currently require a module-level class declaration.');
    if (ts.isExpressionWithTypeArguments(node) && ts.isHeritageClause(node.parent)) {
      const base = classOf(node.expression);
      if (base && names(base).size) options.report(node, 'class-collision',
        'Inheritance from a class with separated static/instance members needs a prototype contract.');
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const member = ts.isPropertyAccessExpression(node) ? node.name.text
        : ts.isStringLiteral(node.argumentExpression) ? node.argumentExpression.text : undefined;
      const owner = classOf(node.expression);
      if (owner && names(owner).size && (member === 'prototype' || (ts.isDeleteExpression(node.parent) && names(owner).has(member))))
        options.report(node, 'class-collision', 'Prototype access and deleting separated class members need a prototype contract.');
    }
    ts.forEachChild(node, validate);
  }
  validate(options.source);
  function lower(node: ts.Statement): readonly ts.Statement[] {
    if (!ts.isClassDeclaration(node)) return [node];
    const collisions = names(node);
    if (!collisions.size) return [node];
    if (!node.name || node.typeParameters?.length || node.heritageClauses?.length
      || node.members.some(member => member.name && ts.isComputedPropertyName(member.name))) {
      options.report(ts.getOriginalNode(node), 'class-collision',
        'Static/instance name collisions currently require a named, nongeneric class without inheritance or computed members.');
      return [node];
    }
    const shared: ts.Statement[] = [], fields: ts.ClassElement[] = [], remaining: ts.ClassElement[] = [];
    for (const member of node.members) {
      const name = key(member);
      if (name && collisions.has(name) && (ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member)))
        options.report(ts.getOriginalNode(member), 'class-collision', 'Colliding accessors need a property-descriptor contract.');
      if (!name || !collisions.has(name) || !ts.isMethodDeclaration(member)) {
        remaining.push(member);
        continue;
      }
      if (!member.body || member.asteriskToken || member.modifiers?.some(m => m.kind === ts.SyntaxKind.AsyncKeyword)) {
        options.report(ts.getOriginalNode(member), 'class-collision', 'Colliding overload, generator and async methods need another native class contract.');
        remaining.push(member);
        continue;
      }
      methods++;
      if (staticMember(member)) {
        fields.push(f.createPropertyDeclaration(member.modifiers, member.name, member.questionToken, undefined,
          f.createFunctionExpression(undefined, undefined, undefined, member.typeParameters,
            member.parameters, member.type, member.body)));
      } else {
        const helper = f.createIdentifier(options.fresh('__instance_' + name));
        const parameters = member.parameters.some(p => ts.isIdentifier(p.name) && p.name.text === 'this')
          ? member.parameters : [f.createParameterDeclaration(undefined, undefined, 'this', undefined,
            f.createTypeReferenceNode(node.name)), ...member.parameters];
        shared.push(f.createFunctionDeclaration(undefined, undefined, helper, member.typeParameters,
          parameters, member.type, member.body));
        fields.push(f.createPropertyDeclaration(member.modifiers, member.name, member.questionToken, undefined, helper));
      }
    }
    classes++;
    // Methods exist before source fields/static initialization can read them.
    return [...shared, f.updateClassDeclaration(node, node.modifiers, node.name,
      node.typeParameters, node.heritageClauses, [...fields, ...remaining])];
  }
  return {lower, stats:()=>({classes, methods})};
}
