import path from 'node:path';
import ts from 'typescript';

export interface ExecutableModule {
  readonly filename: string;
  /** TypeScript's declaration owner, retained alongside its executable source. */
  readonly declarationFile?: string;
  readonly packageJson?: string;
  readonly origin: 'typescript' | 'package' | 'source' | 'source-map';
}
export interface ExecutableResolver {
  resolve(specifier: string, containingFile: string): ExecutableModule | undefined;
  /** Original sources embedded in a shipped single-source map, without copies
   * in node_modules or a separate vendored package tree. */
  readonly sources: ReadonlyMap<string, string>;
}

const declaration = (filename: string) => /\.d\.[cm]?ts$/i.test(filename);
const executable = (filename: string) => !declaration(filename) && /\.[cm]?[jt]sx?$/i.test(filename);
const normalized = (filename: string) => path.resolve(filename).replaceAll('\\', '/');

/** Resolve package code separately from its declarations. TypeScript owns
 * exports/imports conditions, subpath patterns, paths and Node search order.
 * Hiding declarations on the executable pass lets its resolver follow the
 * package's import/default branch rather than ending at a .d.ts file. */
export function createExecutableResolver(options: ts.CompilerOptions, host: ts.ModuleResolutionHost): ExecutableResolver {
  const sources = new Map<string, string>();
  const caseSensitive = typeof host.useCaseSensitiveFileNames === 'function' ? host.useCaseSensitiveFileNames()
    : host.useCaseSensitiveFileNames ?? ts.sys.useCaseSensitiveFileNames;
  const canonical = (filename: string) => {
    const name = normalized(filename);
    return caseSensitive ? name : name.toLowerCase();
  };
  const currentDirectory = host.getCurrentDirectory?.() ?? process.cwd();
  const declarationsCache = ts.createModuleResolutionCache(currentDirectory, canonical, options);
  const runtimeOptions: ts.CompilerOptions = {
    ...options,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowJs: true,
    resolvePackageJsonExports: true,
    resolvePackageJsonImports: true,
    customConditions: [...new Set(['source', 'module', ...(options.customConditions ?? [])])],
  };
  const runtimeHost: ts.ModuleResolutionHost = {
    ...host,
    fileExists: filename => !declaration(filename) && (sources.has(normalized(filename)) || host.fileExists(filename)),
    readFile: filename => sources.get(normalized(filename)) ?? host.readFile(filename),
  };
  const runtimeCache = ts.createModuleResolutionCache(currentDirectory, canonical, runtimeOptions);
  const results = new Map<string, ExecutableModule | undefined>();
  const sourceProofs = new Map<string, boolean>();
  const jsons = new Map<string, Record<string, unknown> | undefined>();
  function json(filename: string): Record<string, unknown> | undefined {
    const key = normalized(filename);
    if (jsons.has(key)) return jsons.get(key);
    let value: Record<string, unknown> | undefined;
    try {
      const text = host.readFile(filename);
      const parsed: unknown = text === undefined ? undefined : JSON.parse(text);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) value = parsed as Record<string, unknown>;
    } catch { /* Invalid package/source-map metadata is not executable source. */ }
    jsons.set(key, value);
    return value;
  }
  function packageOwner(filename: string): { filename: string; value: Record<string, unknown> } | undefined {
    for (let directory = path.dirname(filename); ; directory = path.dirname(directory)) {
      const filename = path.join(directory, 'package.json');
      const value = json(filename);
      if (value) return { filename: normalized(filename), value };
      if (path.dirname(directory) === directory) return undefined;
    }
  }
  function inside(directory: string, filename: string): boolean {
    const relative = path.relative(canonical(directory), canonical(filename));
    return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  }
  function physical(filename: string): string | undefined {
    if (!host.realpath) return normalized(filename);
    let existing = filename;
    while (!host.fileExists(existing) && !host.directoryExists?.(existing)) {
      const parent = path.dirname(existing);
      if (parent === existing) return undefined;
      existing = parent;
    }
    try { return normalized(path.resolve(host.realpath(existing), path.relative(existing, filename))); }
    catch { return undefined; }
  }
  function ownedSource(owner: string, filename: string): boolean {
    const root = path.dirname(owner);
    if (!inside(root, filename)) return false;
    const realRoot = physical(root), realFile = physical(filename);
    if (!realRoot || !realFile || !inside(realRoot, realFile)) return false;
    // A nested dependency may be physically inside the package directory but
    // still owns its own module identities.
    const nearest = packageOwner(filename);
    return !!nearest && canonical(nearest.filename) === canonical(owner);
  }
  function packageFile(owner: string, value: unknown): string | undefined {
    if (typeof value !== 'string' || /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(value)) return undefined;
    const candidate = normalized(path.resolve(path.dirname(owner), value));
    return executable(candidate) && host.fileExists(candidate) && ownedSource(owner, candidate) ? candidate : undefined;
  }
  function sameApi(candidate: string, published: string, declarationFile: string | undefined): boolean {
    const key = JSON.stringify([canonical(candidate), canonical(published), declarationFile && canonical(declarationFile)]);
    const previous = sourceProofs.get(key);
    if (previous !== undefined) return previous;
    const verificationOptions: ts.CompilerOptions = { ...runtimeOptions,
      noLib: false, lib: ['lib.es2023.d.ts'], types: [], strict: true,
      noEmit: true, skipLibCheck: true, checkJs: false, maxNodeModuleJsDepth: 0,
    };
    const verificationHost = ts.createCompilerHost(verificationOptions);
    verificationHost.getCurrentDirectory = () => currentDirectory;
    verificationHost.useCaseSensitiveFileNames = () => caseSensitive;
    verificationHost.fileExists = filename => sources.has(normalized(filename)) || host.fileExists(filename);
    verificationHost.readFile = filename => sources.get(normalized(filename)) ?? host.readFile(filename);
    verificationHost.directoryExists = directory => [...sources.keys()].some(filename => filename.startsWith(`${normalized(directory)}/`))
      || !!host.directoryExists?.(directory);
    verificationHost.realpath = filename => host.realpath?.(filename) ?? filename;
    verificationHost.getSourceFile = (filename, version) => {
      const text = verificationHost.readFile(filename);
      return text === undefined ? undefined : ts.createSourceFile(filename, text, version, true);
    };
    const program = ts.createProgram([candidate, published, ...(declarationFile ? [declarationFile] : [])], verificationOptions, verificationHost);
    const checker = program.getTypeChecker();
    const opaque = ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never;
    const primitive = (type: ts.Type): boolean => type.isUnion() ? type.types.every(primitive)
      : !!(type.flags & (ts.TypeFlags.StringLike | ts.TypeFlags.NumberLike | ts.TypeFlags.BooleanLike | ts.TypeFlags.BigIntLike
        | ts.TypeFlags.ESSymbolLike | ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void));
    const primitiveCompatible = (source: ts.Type, target: ts.Type) => !primitive(source) && !primitive(target)
      || source.flags & (ts.TypeFlags.TypeParameter | ts.TypeFlags.Conditional | opaque)
      || target.flags & (ts.TypeFlags.TypeParameter | ts.TypeFlags.Conditional | opaque)
      || checker.isTypeAssignableTo(source, target);
    // Conditional generic utilities can be structurally identical in source
    // and rolled declarations without TS proving full mutual assignability.
    // For those exports, verify the public callable API's overload, parameter,
    // optional/rest and generic shapes, plus concrete primitive contracts.
    const checked = new Map<ts.Type, Set<ts.Type>>();
    function genericSurface(source: ts.Type, target: ts.Type): boolean {
      const prior = checked.get(source) ?? new Set<ts.Type>();
      if (prior.has(target)) return true;
      prior.add(target); checked.set(source, prior);
      const calls = checker.getSignaturesOfType(source, ts.SignatureKind.Call), publicCalls = checker.getSignaturesOfType(target, ts.SignatureKind.Call);
      const constructs = checker.getSignaturesOfType(source, ts.SignatureKind.Construct), publicConstructs = checker.getSignaturesOfType(target, ts.SignatureKind.Construct);
      if (calls.length !== publicCalls.length || constructs.length !== publicConstructs.length
        || ![...calls, ...constructs].some(signature => signature.typeParameters?.length)) return false;
      for (const [index, signature] of [...calls, ...constructs].entries()) {
        const expected = [...publicCalls, ...publicConstructs][index]!;
        const params = signature.parameters, publicParams = expected.parameters;
        if ((signature.typeParameters?.length ?? 0) !== (expected.typeParameters?.length ?? 0) || params.length !== publicParams.length
          || !!signature.thisParameter !== !!expected.thisParameter) return false;
        for (const [index, parameter] of params.entries()) {
          const original = parameter.valueDeclaration ?? parameter.declarations?.[0];
          const declared = publicParams[index]!.valueDeclaration ?? publicParams[index]!.declarations?.[0];
          if (!original || !declared || !ts.isParameter(original) || !ts.isParameter(declared)
            || !!original.dotDotDotToken !== !!declared.dotDotDotToken
            || !!(original.questionToken || original.initializer) !== !!(declared.questionToken || declared.initializer)) return false;
          if (!primitiveCompatible(checker.getTypeOfSymbolAtLocation(publicParams[index]!, declared), checker.getTypeOfSymbolAtLocation(parameter, original))) return false;
        }
        if (!primitiveCompatible(checker.getReturnTypeOfSignature(signature), checker.getReturnTypeOfSignature(expected))) return false;
      }
      const members = checker.getPropertiesOfType(source), publicMembers = checker.getPropertiesOfType(target);
      if (members.length !== publicMembers.length) return false;
      for (const member of members) {
        const expected = publicMembers.find(item => item.name === member.name);
        const original = member.valueDeclaration ?? member.declarations?.[0], declared = expected?.valueDeclaration ?? expected?.declarations?.[0];
        if (!expected || !original || !declared || !!(member.flags & ts.SymbolFlags.Optional) !== !!(expected.flags & ts.SymbolFlags.Optional)) return false;
        const type = checker.getTypeOfSymbolAtLocation(member, original), publicType = checker.getTypeOfSymbolAtLocation(expected, declared);
        if (!(checker.isTypeAssignableTo(type, publicType) && checker.isTypeAssignableTo(publicType, type)) && !genericSurface(type, publicType)) return false;
      }
      return true;
    }
    const surface = (filename: string) => {
      const source = program.getSourceFile(filename);
      const symbol = source && checker.getSymbolAtLocation(source);
      if (!source || !symbol || program.getSyntacticDiagnostics(source).length) return undefined;
      const values = new Map<string, ts.Type>();
      for (const exported of checker.getExportsOfModule(symbol)) {
        const target = exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
        const typeOnly = exported.declarations?.some(declaration => ts.isExportSpecifier(declaration)
          && (declaration.isTypeOnly || declaration.parent.parent.isTypeOnly));
        if (!typeOnly && target.flags & ts.SymbolFlags.Value) values.set(exported.name, checker.getTypeOfSymbolAtLocation(target, source));
      }
      return values;
    };
    const original = surface(candidate), executable = surface(published);
    const declared = declarationFile ? surface(declarationFile) : undefined;
    const sameNames = (left: Map<string, ts.Type>, right: Map<string, ts.Type>) => left.size === right.size && [...left.keys()].every(name => right.has(name));
    let matches = !!original?.size && !!executable && sameNames(original, executable)
      && (!declarationFile || !!declared && sameNames(original, declared));
    if (matches && original) {
      // Declaration signatures are the precise public contract. JS inference
      // can be broad; without declarations compare against its known types.
      const contract = declared ?? executable!;
      for (const [name, sourceType] of original) {
        const publicType = contract.get(name)!;
        const publishedType = executable!.get(name)!;
        const runtimeKindMatches = !!(publishedType.flags & opaque)
          || !!checker.getSignaturesOfType(sourceType, ts.SignatureKind.Call).length === !!checker.getSignaturesOfType(publishedType, ts.SignatureKind.Call).length
            && !!checker.getSignaturesOfType(sourceType, ts.SignatureKind.Construct).length === !!checker.getSignaturesOfType(publishedType, ts.SignatureKind.Construct).length
            && (primitiveCompatible(sourceType, publishedType) || primitiveCompatible(publishedType, sourceType));
        if (sourceType.flags & opaque || publicType.flags & opaque
          || !runtimeKindMatches
          || !(checker.isTypeAssignableTo(sourceType, publicType) && checker.isTypeAssignableTo(publicType, sourceType)) && !genericSurface(sourceType, publicType)) {
          matches = false;
          break;
        }
      }
      if (program.getSemanticDiagnostics().some(diagnostic => [2307, 2308, 2305, 2459, 2614, 2724].includes(diagnostic.code))) matches = false;
    }
    sourceProofs.set(key, matches);
    return matches;
  }
  function rootSource(owner: { filename: string; value: Record<string, unknown> }, published: string, declarationFile: string | undefined): string | undefined {
    const directories = owner.value.directories;
    const metadata = directories && typeof directories === 'object' && !Array.isArray(directories)
      ? directories as Record<string, unknown> : {};
    const roots = [owner.value.source, metadata.source, metadata.src, 'src'];
    const packageRoot = path.dirname(owner.filename);
    for (const root of [...new Set(roots.filter((value): value is string => typeof value === 'string'))]) {
      if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(root)) continue;
      const directory = path.resolve(packageRoot, root);
      const relative = path.relative(packageRoot, directory);
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) continue;
      for (const entry of ['index.ts', 'index.tsx', 'index.mts', 'index.cts']) {
        const candidate = normalized(path.join(directory, entry));
        if (host.fileExists(candidate) && ownedSource(owner.filename, candidate) && sameApi(candidate, published, declarationFile)) return candidate;
      }
    }
    return undefined;
  }
  function mappedSource(filename: string, owner: string | undefined): string | undefined {
    if (!owner || !/\.[cm]?jsx?$/i.test(filename)) return undefined;
    const text = host.readFile(filename);
    const mapping = text && [...text.matchAll(/(?:\/\/[#@]\s*sourceMappingURL=([^\s]+)|\/\*[#@]\s*sourceMappingURL=([^\s*]+)\s*\*\/)/g)].at(-1);
    const reference = mapping?.[1] ?? mapping?.[2];
    if (!reference) return undefined;
    let map: Record<string, unknown> | undefined;
    let directory = path.dirname(filename);
    if (reference.startsWith('data:')) {
      const data = /^data:application\/json(?:;charset=[^;,]+)?(;base64)?,(.*)$/i.exec(reference);
      if (!data) return undefined;
      try {
        map = JSON.parse(data[1] ? Buffer.from(data[2]!, 'base64').toString('utf8') : decodeURIComponent(data[2]!));
      } catch { return undefined; }
    } else {
      if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(reference)) return undefined;
      const mapFile = path.resolve(directory, reference);
      if (!ownedSource(owner, mapFile)) return undefined;
      map = json(mapFile);
      directory = path.dirname(mapFile);
    }
    // A bundled map does not identify a unique original entry module. Keep
    // the published bundle rather than guess which source is its entrypoint.
    if (!map || !Array.isArray(map.sources) || map.sources.length !== 1 || typeof map.sources[0] !== 'string') return undefined;
    const root = typeof map.sourceRoot === 'string' ? map.sourceRoot : '';
    if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(root) || /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(map.sources[0])) return undefined;
    const source = normalized(path.resolve(directory, root, map.sources[0]));
    if (!executable(source) || source === normalized(filename) || !ownedSource(owner, source)) return undefined;
    if (sources.has(source)) {
      const content = Array.isArray(map.sourcesContent) ? map.sourcesContent[0] : undefined;
      return typeof content !== 'string' || content === sources.get(source) ? source : undefined;
    }
    if (host.fileExists(source)) return source;
    if (Array.isArray(map.sourcesContent) && typeof map.sourcesContent[0] === 'string') {
      sources.set(source, map.sourcesContent[0]);
      return source;
    }
    return undefined;
  }
  function resolve(specifier: string, containingFile: string): ExecutableModule | undefined {
    const key = JSON.stringify([normalized(containingFile), specifier]);
    if (results.has(key)) return results.get(key);
    const typed = ts.resolveModuleName(specifier, containingFile, options, host, declarationsCache).resolvedModule;
    const runtime = ts.resolveModuleName(specifier, containingFile, runtimeOptions, runtimeHost, runtimeCache).resolvedModule;
    if (!runtime || !executable(runtime.resolvedFileName)) {
      results.set(key, undefined);
      return undefined;
    }
    let filename = normalized(runtime.resolvedFileName);
    let origin: ExecutableModule['origin'] = /\.[cm]?tsx?$/i.test(filename) ? 'typescript' : 'package';
    const declarationFile = typed && declaration(typed.resolvedFileName) ? normalized(typed.resolvedFileName) : undefined;
    const owner = packageOwner(filename);
    const packageName = owner?.value.name;
    // The package's source/module fields describe its root entry, not every
    // private relative file or exported subpath in the package.
    if (owner && typeof packageName === 'string' && specifier === packageName) {
      const source = packageFile(owner.filename, owner.value.source);
      const module = owner.value.exports === undefined ? packageFile(owner.filename, owner.value.module) : undefined;
      if (source) { filename = source; origin = 'source'; }
      else if (module) filename = module;
      // A multi-source map identifies a bundled executable. A matching root
      // source API does not prove that compiling its separate internal modules
      // preserves the bundle's transforms and runtime behavior.
      const publishedText = host.readFile(filename);
      const mapRef = publishedText && [...publishedText.matchAll(/\/\/[#@]\s*sourceMappingURL=([^\s]+)/g)].at(-1)?.[1];
      const map = mapRef && !/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(mapRef)
        ? json(path.resolve(path.dirname(filename), mapRef)) : undefined;
      const bundled = Array.isArray(map?.sources) && map.sources.length > 1;
      if (!source && !bundled && !/\.[cm]?tsx?$/i.test(filename)) {
        const verified = rootSource(owner, filename, declarationFile);
        if (verified) { filename = verified; origin = 'source'; }
      }
    }
    const source = mappedSource(filename, owner?.filename);
    if (source) { filename = source; origin = 'source-map'; }
    const result: ExecutableModule = { filename, origin,
      ...(declarationFile ? { declarationFile } : {}), ...(owner ? { packageJson: owner.filename } : {}) };
    results.set(key, result);
    return result;
  }
  return { resolve, sources };
}
