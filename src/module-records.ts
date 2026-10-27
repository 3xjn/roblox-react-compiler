/** Compiler-owned module lifecycle, emitted once per project. Package bodies
 * remain in their own factories; creating a record does not execute them. */
export function moduleRecordsSource(): string {
  return `export interface Module { exports: unknown }
export interface CommonJs<T, R> { readonly require: () => R; readonly load: () => T }
export function commonJs<T, R = unknown>(initialize: (module: Module) => () => T, createExports: () => unknown): CommonJs<T,R> {
  let record: { module: Module; namespace?: () => T; value?: T; snapshot: boolean } | undefined;
  function requireValue(): R {
    if (record !== undefined) return record.module.exports as R;
    const current = { module: { exports: createExports() }, namespace: undefined as (() => T) | undefined, value: undefined as T | undefined, snapshot: false };
    record = current;
    try {
      current.namespace = initialize(current.module);
      return current.module.exports as R;
    } catch (failure) {
      if (record === current) record = undefined;
      throw failure;
    }
  }
  return { require: requireValue, load: () => {
    requireValue();
    const current = record!;
    if (current.namespace === undefined) throw 'An ESM namespace cannot be read during CommonJS initialization';
    if (!current.snapshot) { current.value = current.namespace(); current.snapshot = true; }
    return current.value!;
  } };
}
export function esm<T>(initialize: () => T): () => T {
  let state = 0, value: T | undefined, failure: unknown;
  return () => {
    if (state === 2) return value!;
    if (state === 3) throw failure;
    if (state === 1) throw 'An ESM cycle requires live module bindings';
    state = 1;
    try { value = initialize(); state = 2; return value; }
    catch (caught) { failure = caught; state = 3; throw caught; }
  };
}
`;
}
