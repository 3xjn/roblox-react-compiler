import { cx } from 'class-variance-authority';
type ClassValue = Parameters<typeof cx>[0];

export type Scalar = { kind: 'undefined' | 'null' | 'nan' | 'positive-infinity' | 'negative-infinity' }
  | { kind: 'string'; value: string } | { kind: 'boolean'; value: boolean } | { kind: 'number'; value: number };
export interface VariantMetadata {
  version: 1;
  base: string;
  axes: { name: string; choices: { key: string; classes: string; numberKey?: number }[] }[];
  defaults: { name: string; value: Scalar }[];
  compounds: { conditions: { name: string; values: Scalar[]; array: boolean }[]; classes: string }[];
}

/** Literal class lists for the stylesheet/merger build, without variant products. */
export function variantClassLists(metadata: VariantMetadata): string[] {
  if (metadata.version !== 1) throw new Error('Unsupported variant metadata');
  return [metadata.base, ...metadata.axes.flatMap(axis => axis.choices.map(choice => choice.classes)),
    ...metadata.compounds.map(compound => compound.classes)].filter(value => value !== '');
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error(`${label} must be a literal record`);
  return value as Record<string, unknown>;
}
function scalar(value: unknown): Scalar {
  if (value === undefined) return { kind: 'undefined' };
  if (value === null) return { kind: 'null' };
  if (typeof value === 'string' || typeof value === 'boolean') return { kind: typeof value, value } as Scalar;
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return { kind: 'nan' };
    if (value === Infinity) return { kind: 'positive-infinity' };
    if (value === -Infinity) return { kind: 'negative-infinity' };
    return { kind: 'number', value };
  }
  throw new Error('Variant defaults and compound choices require scalar values');
}
function classes(value: unknown, active = new Set<unknown>(), depth = 0): string {
  if (depth > 64 || active.has(value)) throw new Error('Cyclic or excessively nested class definition');
  if (Array.isArray(value)) {
    active.add(value);
    for (const child of value) classes(child, active, depth + 1);
    active.delete(value);
  } else if (value && typeof value === 'object') {
    record(value, 'Class object');
    // clsx tests object values for truthiness; it does not recurse into them.
    for (const child of Object.values(value)) {
      if (typeof child === 'function' || typeof child === 'symbol' || typeof child === 'bigint') throw new Error('Nonliteral class object condition');
    }
  } else if (!['undefined', 'string', 'number', 'boolean'].includes(typeof value) && value !== null) {
    throw new Error('Unsupported class definition');
  }
  return cx(value as ClassValue);
}

/** Normalize static class data with official clsx, retaining CVA selection order. */
export function compileVariants(base: unknown, configuration?: unknown): VariantMetadata {
  const result: VariantMetadata = { version: 1, base: classes(base), axes: [], defaults: [], compounds: [] };
  if (configuration === undefined || configuration === null) return result;
  const config = record(configuration, 'CVA configuration');
  for (const key of Object.keys(config)) if (!['variants', 'defaultVariants', 'compoundVariants'].includes(key)) throw new Error(`Unknown CVA option: ${key}`);
  if (config.variants === undefined || config.variants === null) return result;
  for (const [name, value] of Object.entries(record(config.variants, 'Variants'))) {
    const choices = Object.entries(record(value, `Variant ${name}`)).map(([key, value]) => {
      const number = Number(key);
      return { key, classes: classes(value), ...(Number.isFinite(number) && String(number) === key ? { numberKey: number } : {}) };
    });
    result.axes.push({ name, choices });
  }
  if (config.defaultVariants !== undefined && config.defaultVariants !== null) {
    result.defaults = Object.entries(record(config.defaultVariants, 'Default variants')).map(([name, value]) => ({ name, value: scalar(value) }));
  }
  if (config.compoundVariants !== undefined && config.compoundVariants !== null) {
    if (!Array.isArray(config.compoundVariants)) throw new Error('Compound variants must be an array');
    result.compounds = config.compoundVariants.map(value => {
      const item = record(value, 'Compound variant');
      const conditions = Object.entries(item).filter(([name]) => name !== 'class' && name !== 'className').map(([name, value]) => ({
        name, array: Array.isArray(value), values: (Array.isArray(value) ? value : [value]).map(scalar),
      }));
      return { conditions, classes: cx(classes(item.class), classes(item.className)) };
    });
  }
  return result;
}
