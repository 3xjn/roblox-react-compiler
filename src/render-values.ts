import ts from 'typescript';
import type { SourceFunction } from './helper-types.ts';

/** Prove that replacing a source null with React's empty false cannot escape
 * into data code. False also keeps array child slots dense in Luau. */
export function renderNulls(source: ts.SourceFile, checker: ts.TypeChecker,
  components: ReadonlySet<SourceFunction>, syntax: {
    readonly renderSlot?: (node: ts.Node) => boolean;
    readonly componentTag?: (node: ts.Node) => boolean;
  } = {}): ReadonlySet<ts.Node> {
  const references = new Map<ts.Symbol, ts.Identifier[]>();
  const nulls: ts.Node[] = [];
  function index(node: ts.Node) {
    if (ts.isTypeNode(node)) return;
    if (node.kind === ts.SyntaxKind.NullKeyword) nulls.push(node);
    if (ts.isIdentifier(node)) {
      const p = node.parent;
      const name = (ts.isVariableDeclaration(p) || ts.isParameter(p) || ts.isFunctionDeclaration(p)
        || ts.isFunctionExpression(p) || ts.isBindingElement(p)) && p.name === node;
      const key = (ts.isPropertyAccessExpression(p) || ts.isPropertyAssignment(p)
        || ts.isJsxAttribute(p) || ts.isBindingElement(p)) && (p as ts.NamedDeclaration).name === node;
      if (!name && !key) {
        const symbol = ts.isShorthandPropertyAssignment(p)
          ? checker.getShorthandAssignmentValueSymbol(p) : checker.getSymbolAtLocation(node);
        if (symbol) {
          const values = references.get(symbol) ?? [];
          values.push(node); references.set(symbol, values);
        }
      }
    }
    ts.forEachChild(node, index);
  }
  index(source);
  function unwrap(node: ts.Node): ts.Node {
    while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)
      || ts.isNonNullExpression(node)) node = node.expression;
    return node;
  }
  function transparent(node: ts.Node): boolean {
    return ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)
      || ts.isNonNullExpression(node);
  }
  function constant(declaration: ts.Node): declaration is ts.VariableDeclaration {
    return ts.isVariableDeclaration(declaration) && ts.isIdentifier(declaration.name)
      && ts.isVariableDeclarationList(declaration.parent) && !!(declaration.parent.flags & ts.NodeFlags.Const)
      && !(ts.isVariableStatement(declaration.parent.parent)
        && declaration.parent.parent.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword));
  }
  function uses(name: ts.Identifier): readonly ts.Identifier[] {
    const symbol = checker.getSymbolAtLocation(name);
    return symbol ? references.get(symbol) ?? [] : [];
  }
  function owner(node: ts.Node): ts.SignatureDeclaration | undefined {
    for (let current = node.parent; current; current = current.parent) {
      if (ts.isFunctionLike(current)) return current;
    }
    return undefined;
  }
  function booleanUse(node: ts.Node, active: ReadonlySet<ts.Node>): boolean {
    const p = node.parent;
    if (!p) return false;
    if (transparent(p)) return booleanUse(p, active);
    if (ts.isPrefixUnaryExpression(p) && p.operator === ts.SyntaxKind.ExclamationToken) return true;
    if ((ts.isIfStatement(p) || ts.isWhileStatement(p) || ts.isDoStatement(p)) && p.expression === node) return true;
    if (ts.isConditionalExpression(p) && p.condition === node) return true;
    if (ts.isBinaryExpression(p) && p.left === node) {
      // || consumes its left operand only for truthiness. && also returns the
      // falsy operand, so its result must itself be boolean-only or rendered.
      if (p.operatorToken.kind === ts.SyntaxKind.BarBarToken) return true;
      if (p.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) return booleanUse(p, active) || rendered(p, active);
    }
    return false;
  }
  function guardedTag(node: ts.Identifier): boolean {
    const p = node.parent;
    if (!((ts.isJsxOpeningElement(p) || ts.isJsxSelfClosingElement(p) || ts.isJsxClosingElement(p)) && p.tagName === node)
      && !syntax.componentTag?.(node)) return false;
    const symbol = checker.getSymbolAtLocation(node);
    const positive = (condition: ts.Node): boolean => {
      condition = unwrap(condition);
      return ts.isIdentifier(condition) && checker.getSymbolAtLocation(condition) === symbol;
    };
    let child: ts.Node = node;
    for (let current = p as ts.Node; current; child = current, current = current.parent) {
      if (ts.isFunctionLike(current)) return false;
      if (ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
        && current.right === child && positive(current.left)) return true;
      if (ts.isConditionalExpression(current) && current.whenTrue === child && positive(current.condition)) return true;
      if (ts.isIfStatement(current) && current.thenStatement === child && positive(current.expression)) return true;
    }
    return false;
  }
  function componentIdentity(node: ts.Identifier, active: ReadonlySet<ts.Node>): boolean {
    if (active.has(node)) return false;
    const next = new Set(active).add(node);
    let current: ts.Node = node;
    while (transparent(current.parent)) current = current.parent;
    const p = current.parent;
    if (syntax.componentTag?.(current)) return true;
    if ((ts.isJsxOpeningElement(p) || ts.isJsxSelfClosingElement(p) || ts.isJsxClosingElement(p)) && p.tagName === current) return true;
    if (ts.isCallExpression(p) && p.expression === current) return rendered(p, next);
    if (constant(p) && p.initializer === current) return uses(p.name as ts.Identifier).every(use => componentIdentity(use, next));
    // A selected component export declares a render contract. An arbitrary
    // callback argument or property does not establish one.
    if (ts.isExportSpecifier(p) && !p.isTypeOnly && !p.parent.parent.isTypeOnly && !p.parent.parent.moduleSpecifier) return true;
    return false;
  }
  function renderReturn(fn: ts.SignatureDeclaration, active: ReadonlySet<ts.Node>): boolean {
    if (ts.isFunctionDeclaration(fn)) return components.has(fn) && !!fn.name
      && uses(fn.name).every(use => componentIdentity(use, active));
    if ((ts.isFunctionExpression(fn) || ts.isArrowFunction(fn)) && components.has(fn)) {
      let current: ts.Node = fn;
      while (transparent(current.parent)) current = current.parent;
      const declaration = current.parent;
      if (!ts.isVariableDeclaration(declaration) || !ts.isIdentifier(declaration.name)
        || !ts.isVariableDeclarationList(declaration.parent) || !(declaration.parent.flags & ts.NodeFlags.Const)) return false;
      return uses(declaration.name).every(use => componentIdentity(use, active))
        && (!ts.isFunctionExpression(fn) || !fn.name || uses(fn.name).every(use => componentIdentity(use, active)));
    }
    // Inline array callbacks can be proved separately once the source type
    // environment establishes a real Array.map. Method spelling alone is not
    // sufficient: a user-defined map could inspect callback nulls as data.
    return false;
  }
  function rendered(node: ts.Node, active: ReadonlySet<ts.Node> = new Set(), scalar = true): boolean {
    if (active.has(node)) return false;
    const next = new Set(active).add(node);
    const p = node.parent;
    if (!p) return false;
    if (syntax.renderSlot?.(node)) return true;
    if (transparent(p)) return rendered(p, next, scalar);
    if (ts.isJsxExpression(p)) return ts.isJsxElement(p.parent) || ts.isJsxFragment(p.parent);
    if (ts.isConditionalExpression(p) && (p.whenTrue === node || p.whenFalse === node)) return rendered(p, next, scalar);
    if (ts.isBinaryExpression(p) && p.right === node && [ts.SyntaxKind.AmpersandAmpersandToken,
      ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(p.operatorToken.kind)) return rendered(p, next, scalar);
    if (ts.isArrayLiteralExpression(p)) return rendered(p, next, false);
    if (ts.isReturnStatement(p)) {
      const fn = owner(p);
      return !!fn && renderReturn(fn, next);
    }
    if (ts.isArrowFunction(p) && p.body === node) return renderReturn(p, next);
    if (constant(p) && p.initializer === node) {
      const reads = uses(p.name as ts.Identifier);
      // Boolean consumption is safe for the null value itself. A truthy array
      // containing null can escape intact through ||, so do not generalize
      // that rule to the collection that contains an empty render slot.
      return reads.length > 0 && reads.every(use => rendered(use, next, scalar)
        || (scalar && (booleanUse(use, next) || guardedTag(use))));
    }
    return false;
  }
  return new Set(nulls.filter(node => rendered(node)));
}
