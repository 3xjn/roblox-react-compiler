import ts from 'typescript';
import { createRequire } from 'node:module';
import type Luau from '@roblox-ts/luau-ast';
const { default: luau } = createRequire(import.meta.url)(
  '@roblox-ts/luau-ast',
) as { default: typeof Luau.default };

/** Use the native backend's identifier policy, preserving source symbols and public keys. */
export function createIdentifierHygiene(
  source: ts.SourceFile,
  checker: ts.TypeChecker,
  fresh: (name: string) => string,
) {
  const f = ts.factory;
  const aliases = new Map<ts.Symbol, string>();
  const rootClasses = new Set<ts.Symbol>();
  for (const statement of source.statements)
    if (ts.isClassDeclaration(statement) && statement.name) {
      const symbol = checker.getSymbolAtLocation(statement.name);
      if (symbol) rootClasses.add(symbol);
    }
  function bind(name: ts.BindingName | ts.Identifier) {
    if (!ts.isIdentifier(name)) {
      for (const entry of name.elements)
        if (ts.isBindingElement(entry)) bind(entry.name);
      return;
    }
    if (
      luau.isValidIdentifier(name.text) &&
      !luau.isReservedIdentifier(name.text)
    )
      return;
    const symbol = checker.getSymbolAtLocation(name);
    if (symbol && !aliases.has(symbol))
      aliases.set(
        symbol,
        fresh('__source_' + name.text.replace(/[^A-Za-z0-9_]/g, '_')),
      );
  }
  function scan(node: ts.Node) {
    if (ts.isVariableDeclaration(node) || ts.isParameter(node)) bind(node.name);
    if (
      (ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isClassDeclaration(node) ||
        ts.isClassExpression(node)) &&
      node.name
    )
      bind(node.name);
    if (ts.isImportClause(node) && node.name) bind(node.name);
    if (ts.isImportSpecifier(node) || ts.isNamespaceImport(node))
      bind(node.name);
    ts.forEachChild(node, scan);
  }
  scan(source);
  const top = new Map<string, string>();
  const rootName = (name: ts.BindingName) => {
    if (!ts.isIdentifier(name)) {
      for (const element of name.elements)
        if (ts.isBindingElement(element)) rootName(element.name);
      return;
    }
    const symbol = checker.getSymbolAtLocation(name);
    if (symbol && aliases.has(symbol)) top.set(name.text, aliases.get(symbol)!);
  };
  for (const statement of source.statements) {
    if (ts.isVariableStatement(statement))
      for (const declaration of statement.declarationList.declarations)
        rootName(declaration.name);
    if (
      (ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement)) &&
      statement.name
    )
      rootName(statement.name);
    if (ts.isImportDeclaration(statement) && statement.importClause) {
      const clause = statement.importClause;
      if (clause.name) rootName(clause.name);
      if (clause.namedBindings) {
        if (ts.isNamespaceImport(clause.namedBindings))
          rootName(clause.namedBindings.name);
        else
          for (const specifier of clause.namedBindings.elements)
            rootName(specifier.name);
      }
    }
  }
  function alias(node: ts.Identifier) {
    const original = ts.getOriginalNode(node);
    if (!ts.isIdentifier(original)) return;
    const symbol = checker.getSymbolAtLocation(original);
    return symbol && aliases.get(symbol);
  }
  return {
    count: aliases.size,
    local: (name: string) => top.get(name) ?? name,
    transform(input: ts.SourceFile) {
      const result = ts.transform(input, [
        (context) => (root) => {
          const visit: ts.Visitor = (node) => {
            if (ts.isShorthandPropertyAssignment(node)) {
              const original = ts.getOriginalNode(node);
              const symbol =
                ts.isShorthandPropertyAssignment(original) &&
                checker.getShorthandAssignmentValueSymbol(original);
              const renamed = symbol && aliases.get(symbol);
              if (renamed)
                return f.createPropertyAssignment(
                  f.createStringLiteral(node.name.text),
                  f.createIdentifier(renamed),
                );
            }
            if (ts.isBindingElement(node) && ts.isIdentifier(node.name)) {
              const renamed = alias(node.name);
              if (renamed)
                return f.updateBindingElement(
                  node,
                  node.dotDotDotToken,
                  node.propertyName ??
                    (!node.dotDotDotToken &&
                    ts.isObjectBindingPattern(ts.getOriginalNode(node).parent)
                      ? f.createIdentifier(node.name.text)
                      : undefined),
                  f.createIdentifier(renamed),
                  node.initializer &&
                    (ts.visitNode(node.initializer, visit) as ts.Expression),
                );
            }
            if (ts.isIdentifier(node)) {
              const parent = node.parent;
              if (
                parent &&
                ((ts.isPropertyAccessExpression(parent) &&
                  parent.name === node) ||
                  (ts.isPropertyAssignment(parent) && parent.name === node) ||
                  (ts.isBindingElement(parent) && parent.propertyName === node))
              )
                return node;
              const original = ts.getOriginalNode(node);
              const symbol =
                ts.isIdentifier(original) &&
                checker.getSymbolAtLocation(original);
              if (
                symbol &&
                rootClasses.has(symbol) &&
                parent &&
                ts.isTypeReferenceNode(parent) &&
                parent.typeName === node
              )
                return node;
              const renamed = alias(node);
              if (renamed) return f.createIdentifier(renamed);
            }
            return ts.visitEachChild(node, visit, context);
          };
          return ts.visitNode(root, visit) as ts.SourceFile;
        },
      ]);
      const output = result.transformed[0]!;
      result.dispose();
      return output;
    },
  };
}
