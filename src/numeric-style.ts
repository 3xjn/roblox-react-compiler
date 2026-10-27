import { compileNumericDomain, type NumericDomain } from '@3xjn/roblox-css-compiler';
import { compileStyleObject, type StyleObject, type StyleValue } from './style-object.ts';
import { unitlessNumbers } from './react-style-data.ts';

export interface NumericStyleTemplate {
  readonly kind: 'numeric-style';
  readonly base: StyleObject;
  readonly arity: number;
  readonly slots: readonly {
    readonly entry: number;
    readonly argument: number;
    readonly pixels: boolean;
    readonly unit?: string;
    readonly domain: NumericDomain;
  }[];
  readonly keys?: readonly number[];
}

export function compileNumericStyle(
  styles: Readonly<Record<string, StyleValue>>,
  bindings: readonly { name: string; argument: number; unit?: string }[],
  arity: number,
  options: { from?: string; keys?: readonly number[] } = {},
): NumericStyleTemplate {
  const base = compileStyleObject(styles, options);
  const slots = bindings.map(({ name, argument, unit }) => {
    const entry = base.entries.findIndex(item => item.name === name);
    const declaration = base.entries[entry]?.declaration;
    if (!declaration) throw Error(`Numeric style requires a declaration prototype: ${name}`);
    const pixels = !name.startsWith('--') && !unitlessNumbers.has(name);
    // Emitted data uses Luau's one-based indices. Source arguments stay zero-based.
    if (unit !== undefined) {
      const token = declaration.tokens[0];
      if (!/^(?:[a-zA-Z]+|%)?$/.test(unit) || declaration.tokens.length !== 1 || !token
        || !(unit === '' ? token.kind === 'number' : unit === '%' ? token.kind === 'percentage'
          : token.kind === 'dimension' && token.unit?.toLowerCase() === unit.toLowerCase()))
        throw Error(`Numeric style unit must match a single numeric prototype: ${name}`);
    }
    return { entry: entry + 1, argument: argument + 1, pixels, ...(unit === undefined ? {} : {unit}),
      domain: compileNumericDomain(declaration.property, unit ?? pixels) };
  });
  const keys = options.keys?.map(argument => {
    if (!Number.isInteger(argument) || argument < 0 || argument >= arity || bindings.some(slot => slot.argument === argument)
      || options.keys!.indexOf(argument)!==options.keys!.lastIndexOf(argument))
      throw Error('Computed style keys need separate checked arguments.');
    return argument + 1;
  });
  return { kind: 'numeric-style', base, arity, slots, ...(keys?.length ? {keys} : {}) };
}
