import { compileInlineStyle, compileValue, type Declaration, type PropertyMetadata } from '@3xjn/roblox-css-compiler';
import { unitlessNumbers } from './react-style-data.ts';

export interface StyleObject {
  readonly kind: 'style-object';
  readonly entries: readonly { readonly name: string; readonly declaration?: Declaration }[];
  readonly properties: Readonly<Record<string, PropertyMetadata>>;
}
export type StyleValue = string | number | boolean | null | undefined;

/** Build-time React style normalization; values use the existing CSS parser/IR. */
export function compileStyleObject(styles: Readonly<Record<string, StyleValue>>, options: { from?: string } = {}): StyleObject {
  if (!styles || typeof styles !== 'object' || Array.isArray(styles)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(styles))) throw Error('Style objects require a plain property record');
  const entries: { name: string; declaration?: Declaration }[] = [];
  const properties: Record<string, PropertyMetadata> = Object.create(null);
  for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(styles))) {
    if (!descriptor.enumerable) continue;
    if (!('value' in descriptor)) throw Error(`Style getter requires an explicit adapter: ${name}`);
    const custom = name.startsWith('--');
    const property = custom ? name : name.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`).replace(/^ms-/, '-ms-');
    if (!/^(?:--[\w-]+|-?[a-z][a-z0-9-]*)$/.test(property)) throw Error(`Style property needs a name adapter: ${name}`);
    const value: unknown = descriptor.value;
    if (value == null || typeof value === 'boolean' || value === '') { entries.push({ name }); continue; }
    if (typeof value !== 'string' && typeof value !== 'number') throw Error(`Style value needs a scalar adapter: ${name}`);
    if (typeof value === 'number' && !Number.isFinite(value)) throw Error(`Nonfinite style number: ${name}`);
    const text = typeof value === 'number' && value !== 0 && !custom && !unitlessNumbers.has(name)
      ? `${value}px` : custom ? String(value) : String(value).trim();
    if (!custom && !text) { entries.push({ name }); continue; }
    const packet = compileInlineStyle(`${property}:${text}`, options);
    const declaration = packet.declarations[0];
    if (packet.declarations.length !== 1 || !declaration || declaration.property !== property || declaration.important) {
      throw Error(`Style value is not one ordinary property assignment: ${name}`);
    }
    const tokens = compileValue(text);
    if (JSON.stringify(tokens) !== JSON.stringify(declaration.tokens)) {
      throw Error(`Style value changed when parsed as a property assignment: ${name}`);
    }
    // Keep the original custom-property token input, including outer whitespace.
    entries.push({ name, declaration: custom ? { ...declaration, value: text, tokens } : declaration });
    Object.assign(properties, packet.properties);
  }
  return { kind: 'style-object', entries, properties };
}
