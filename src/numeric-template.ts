import ts from 'typescript';

export interface NumericTemplateValue { readonly value: ts.Expression; readonly unit: string }
/** A single numeric CSS token, prepared at build time. This is not a runtime
 * string parser. Preserve branch/call evaluation while removing interpolation. */
export function numericTemplateValue(input: ts.Expression, checker: ts.TypeChecker,
  sourceNumber?: (expression: ts.Expression) => boolean): NumericTemplateValue | undefined {
  const f = ts.factory;
  type Branch = NumericTemplateValue | { readonly value: ts.Expression; readonly clear: true };
  function numbers(type: ts.Type, active = new Set<ts.Type>()): boolean {
    if (active.has(type)) return false;
    active.add(type);
    if (type.isUnion()) return type.types.every(member => numbers(member, new Set(active)));
    if (type.flags & ts.TypeFlags.NumberLike) return true;
    const constraint = checker.getBaseConstraintOfType(type);
    return !!constraint && constraint !== type && numbers(constraint, active);
  }
  function clear(type: ts.Type): boolean {
    return (type.isUnion() ? type.types : [type]).every(member =>
      !!(member.flags & (ts.TypeFlags.BooleanLike | ts.TypeFlags.Undefined | ts.TypeFlags.Null | ts.TypeFlags.Void))
      || (!!(member.flags & ts.TypeFlags.StringLiteral) && (member as ts.StringLiteralType).value === ''));
  }
  function lower(node: ts.Expression): Branch | undefined {
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) return lower(node.expression);
    if (ts.isTemplateExpression(node) && node.head.text === '' && node.templateSpans.length === 1) {
      const span = node.templateSpans[0]!;
      if (!/^(?:[a-zA-Z]+|%)?$/.test(span.literal.text)
        || !(numbers(checker.getTypeAtLocation(span.expression)) || sourceNumber?.(span.expression))) return undefined;
      return { value: span.expression, unit: span.literal.text };
    }
    if (ts.isConditionalExpression(node)) {
      const yes = lower(node.whenTrue), no = lower(node.whenFalse);
      if (!yes || !no) return undefined;
      const a = 'unit' in yes ? yes.unit : undefined, b = 'unit' in no ? no.unit : undefined;
      if (a !== undefined && b !== undefined && a !== b) return undefined;
      const unit = a ?? b;
      const value = f.updateConditionalExpression(node, node.condition, node.questionToken, yes.value, node.colonToken, no.value);
      return unit === undefined ? {value, clear:true} : {value, unit};
    }
    return clear(checker.getTypeAtLocation(node)) ? {value:node, clear:true} : undefined;
  }
  const result = lower(input);
  return result && 'unit' in result ? result : undefined;
}
