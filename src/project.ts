import path from 'node:path';
import crypto from 'node:crypto';
import ts from 'typescript';
import { compileComponent, type CompileOptions, type CompileResult, type ImportBinding, type ValueTypeBinding, type Diagnostic } from './index.ts';
import { compileDataModule, type DataModuleOptions, type DataTypeBinding, type DataModuleResult } from './data-module.ts';
import type { SourceResolution } from './source-program.ts';
import {projectOptions} from './roblox-profile.ts';
import {sourceMode,sourceFrontend,containsJsx} from './source-mode.ts';
import {createTypeProjection} from './helper-types.ts';
import {createExecutableResolver, type ExecutableModule, type ExecutableResolver} from './package-resolution.ts';
import {COMMONJS_RECORD_MODULE, normalizeCommonJs, type CommonJsResult, type Defines} from './commonjs.ts';
import {moduleRecordsSource} from './module-records.ts';
import {createDeclarationBundle} from './declaration-bundle.ts';
import {moduleBindingStability} from './module-stability.ts';
import {compileJavaScriptModule} from './javascript-module.ts';

export interface ProjectOptions {
  readonly entryFile: string;
  readonly exports: readonly string[];
  /** Shared platform capabilities. Local source dependencies are discovered by TypeScript. */
  readonly bindings?: readonly ImportBinding[];
  /** Standard shared helper semantics; create its context with SourceRuntime. */
  readonly platform?: 'roblox';
  readonly compilerOptions?: ts.CompilerOptions;
  /** Primitive build definitions, checked against the context before any
   * specialized module initializes. No environment is assumed implicitly. */
  readonly defines?: Defines;
  /** Standard TypeScript host, also usable for in-memory builds. */
  readonly host?: ts.CompilerHost;
  readonly component?: Omit<CompileOptions, 'filename' | 'exports' | 'bindings' | 'typeSources' | 'sourceResolution'>;
  readonly data?: Omit<DataModuleOptions, 'filename' | 'bindings' | 'typeSources' | 'sourceResolution'>;
  /** Checked operations for actual JS bodies. Authored TS never uses this path. */
  readonly javascript?:{
    readonly operations:Pick<import('./index.ts').GlobalBinding,'name'|'valueType'>;
    readonly nulls:Pick<import('./index.ts').GlobalBinding,'name'|'valueType'>;
  };
}
export interface ProjectFile { readonly filename: string; readonly source: string }
export interface ProjectModule {
  readonly filename: string;
  readonly declarationFile?: string;
  readonly outputFile?: string;
  readonly kind: 'component' | 'data';
  readonly frontendOrigin?:'javascript'|'typescript';
  readonly sourceSha256: string;
  readonly exports: readonly string[];
  readonly runtime: boolean;
  readonly component?: Pick<CompileResult, 'intrinsics' | 'sourceFeatures' | 'variantDefinitions' | 'svgAssets' | 'typeProofs' | 'renamedIdentifiers' | 'sourceValueContext' | 'trustedJavaScriptContracts'>;
  readonly data?: Pick<DataModuleResult, 'classCollisions' | 'nulls' | 'arrayLiterals' | 'arrayOperations' | 'unknownAssertions' | 'renamedIdentifiers' | 'trustedJavaScriptContracts'>;
  readonly implementationTyping?:'dynamic-js-value';
  readonly publicTyping?:'published-declaration'|'inferred-js-exports';
  readonly declarationSha256?:string;
  readonly implementationTypeProof?:false;
  readonly internalRuntimeExports?:readonly string[];
  readonly internalRuntimeTyping?:'same-package-js-values';
  readonly declarationInterop?:'commonjs-namespace'|'commonjs-export-equals';
}
export interface ProjectResult {
  /** Absent on any graph or module diagnostic. No partial executable build is returned. */
  readonly files?: readonly ProjectFile[];
  readonly diagnostics: readonly Diagnostic[];
  readonly modules: readonly ProjectModule[];
  /** Unconditional module boundaries in dependency order. Lazy require bodies
   * execute at their source call sites between these boundaries. */
  readonly initializationOrder: readonly string[];
  readonly inputs: readonly { readonly filename: string; readonly sha256: string }[];
}
interface Import {
  readonly module: string;
  readonly name: string;
  readonly local: string;
  readonly typeOnly: boolean;
  readonly target?: Module;
  readonly binding?: ImportBinding;
  readonly sourceName?: string;
  readonly lazy?: boolean;
  readonly loaderType?: string;
  readonly record?: boolean;
  readonly internal?:boolean;
}
interface Module {
  readonly source: ts.SourceFile;
  readonly declarationFile?: string;
  readonly packageJson?:string;
  readonly id: number;
  readonly kind: 'component' | 'data';
  readonly frontendOrigin:'javascript'|'typescript';
  readonly values: Set<string>;
  readonly types: Set<string>;
  readonly requests: Set<string>;
  readonly imports: Map<string, Import>;
  readonly runtime: Module[];
  readonly lazy: Module[];
  readonly commonJs?: CommonJsResult;
  readonly rawType: string;
  readonly edits: Edit[];
  readonly typeBindings: DataTypeBinding[];
  readonly typeRequests: Set<string>;
  readonly typeMembers: Map<string, Set<string>>;
  readonly exportsType: string;
  readonly runtimeExportsType:string;
  javascript?:boolean;
  runtimeExports?:readonly string[];
  compiled?: string;
  dependencyKeys?: string[];
  component?: ProjectModule['component'];
  valueContext?:NonNullable<CompileResult['sourceValueContext']>;
  data?: ProjectModule['data'];
}
interface Edit { start: number; end: number; text: string }
const quote = JSON.stringify;
const moduleName = (name:string) => /^[A-Za-z_$][\w$]*$/.test(name) ? name : quote(name);
const hash = (text: string) => crypto.createHash('sha256').update(text).digest('hex');

/** Link existing source compilers. TypeScript owns module resolution; roblox-ts
 * owns TS-to-Luau emission. CommonJS require edges use lazy module records;
 * cycles involving ESM bindings remain unsupported. */
export function compileProject(input: ProjectOptions): ProjectResult {
  const options=projectOptions(input);
  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler, jsx: ts.JsxEmit.Preserve,
    allowJs: true, checkJs: true, maxNodeModuleJsDepth: 10000,
    ...options.compilerOptions, noEmit: true, noLib: true, types: [], noResolve: false,
  };
  const baseHost = options.host ?? ts.createCompilerHost(compilerOptions);
  const sourcePaths = {...compilerOptions.paths};
  compilerOptions.paths = sourcePaths;
  let executableResolver: ExecutableResolver | undefined;
  const packageJsons = new Map<string, string>();
  const normalizedSources = new Map<string, {original: string; result: CommonJsResult}>();
  const appliedDefines: Record<string, import('./commonjs.ts').DefineValue> = {};
  const normalizationOptions = {
    records:true,
    ...(options.defines ? {defines:options.defines} : {}),
    ...(options.platform === 'roblox' ? {closedGlobals:[...(options.data?.globals ?? []),...(options.component?.globals ?? [])].map(binding=>binding.name)} : {}),
  };
  const compilerTypes = new Map<string, string>();
  const compilerTypeModules = new Set<string>();
  const virtual = (filename: string) => compilerTypes.get(path.resolve(filename).replaceAll('\\', '/'))
    ?? executableResolver?.sources.get(path.resolve(filename).replaceAll('\\', '/'));
  function virtualType(module: string, owner: string, text: string) {
    if (compilerTypeModules.has(module)) return;
    let filename = path.join(path.dirname(owner), `.__compiler_cjs_${hash(module).slice(0, 16)}.d.ts`).replaceAll('\\', '/');
    while (baseHost.fileExists(filename) || compilerTypes.has(filename)) filename = filename.replace(/\.d\.ts$/, '_.d.ts');
    compilerTypes.set(filename, text);
    sourcePaths[module] = [filename];
    compilerTypeModules.add(module);
  }
  const prepare = (filename: string) => {
    if (/\.d\.[cm]?ts$/i.test(filename) || !/\.[cm]?[jt]sx?$/i.test(filename)) return undefined;
    const key = path.resolve(filename).replaceAll('\\', '/');
    let current = normalizedSources.get(key);
    if (!current) {
      const original = virtual(filename) ?? baseHost.readFile(filename);
      if (original === undefined) return undefined;
      const source = ts.createSourceFile(filename, original, ts.ScriptTarget.Latest, true);
      const normalized = normalizeCommonJs(source, normalizationOptions);
      const changed = normalized.commonJs || Object.keys(normalized.appliedDefines).length > 0 || normalized.diagnostics.length > 0
        || normalized.absentGlobals.length > 0;
      const result: CommonJsResult = { ...normalized,
        text: changed ? normalized.text : original,
        source: !changed ? source : source.languageVariant === ts.LanguageVariant.JSX
          ? ts.createSourceFile(filename, normalized.text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX) : normalized.source,
      };
      current = {original, result};
      normalizedSources.set(key, current);
      Object.assign(appliedDefines, result.appliedDefines);
      if (result.record) virtualType(COMMONJS_RECORD_MODULE, filename, 'export declare const module: {exports:unknown};');
      for (const dependency of result.requires) if (dependency.importModule)
        virtualType(dependency.importModule, filename, `import type * as Value from ${quote(dependency.module)};export declare const load:()=>typeof Value;`);
    }
    return current;
  };
  const host: ts.CompilerHost = { ...baseHost,
    fileExists: filename => virtual(filename) !== undefined || baseHost.fileExists(filename),
    readFile: filename => {
      const text = prepare(filename)?.result.text ?? virtual(filename) ?? baseHost.readFile(filename);
      if (text !== undefined && path.basename(filename) === 'package.json') packageJsons.set(path.resolve(filename).replaceAll('\\', '/'), text);
      return text;
    },
    getSourceFile: (filename, version, onError, fresh) => {
      const prepared = prepare(filename);
      if (prepared) return prepared.result.source;
      const text = virtual(filename);
      return text === undefined ? baseHost.getSourceFile(filename, version, onError, fresh)
        : ts.createSourceFile(filename, text, version, true);
    },
    directoryExists: directory => [...compilerTypes.keys(), ...executableResolver?.sources.keys() ?? []].some(filename => filename.startsWith(`${path.resolve(directory).replaceAll('\\', '/')}/`))
      || !!baseHost.directoryExists?.(directory),
    realpath: filename => virtual(filename) !== undefined ? filename : baseHost.realpath?.(filename) ?? filename,
  };
  const absolute = (name: string) => path.resolve(host.getCurrentDirectory(), name).replaceAll('\\', '/');
  const canonical = (name: string) => {
    const resolved = absolute(host.realpath?.(name) ?? name);
    return host.useCaseSensitiveFileNames() ? resolved : resolved.toLowerCase();
  };
  const entryFile = absolute(options.entryFile);
  const cache = ts.createModuleResolutionCache(host.getCurrentDirectory(), canonical, compilerOptions);
  executableResolver = createExecutableResolver(compilerOptions, host);
  const diagnostics: Diagnostic[] = [];
  const nodes = new Map<string, Module>();
  const nativeTypes = new Set<Module>();
  const platforms = new Map(options.bindings.map(binding => [quote([binding.module, binding.name]), binding]));
  const platformTypes = new Map((options.data?.types ?? []).filter(type => type.module !== undefined)
    .map(type => [quote([type.module, type.name]), type]));
  const platformType = (module: string, name: string) =>
    platformTypes.get(quote([module, name])) ?? platformTypes.get(quote([module, '*']));
  const jsxSyntax = (module: string, name: string) =>
    module === 'react/jsx-runtime' && ['jsx', 'jsxs', 'Fragment'].includes(name)
    || module === 'react/jsx-dev-runtime' && ['jsxDEV', 'Fragment'].includes(name);
  function platformBinding(source: ts.SourceFile, module: string, name: string): ImportBinding | undefined {
    const exact = platforms.get(quote([module, name]));
    if (exact) return exact;
    // Package sources frequently use relative imports for the same capability
    // exposed by a public package path. TypeScript's resolved file identity is
    // the boundary; a coincidentally matching basename is not a capability.
    const resolved = ts.resolveModuleName(module, source.fileName, compilerOptions, host, cache).resolvedModule;
    if (!resolved) return undefined;
    const target = canonical(resolved.resolvedFileName);
    for (const binding of options.bindings) {
      if (binding.name !== name) continue;
      const candidate = ts.resolveModuleName(binding.module, source.fileName, compilerOptions, host, cache).resolvedModule;
      if (candidate && canonical(candidate.resolvedFileName) === target) return binding;
    }
    return undefined;
  }
  // Keep declaration resolution for signatures, while discovering executable
  // roots separately. A package declaration never stands in for its JS code.
  const implementations = new Map<string, ExecutableModule>();
  function discover(implementation: ExecutableModule) {
    const key = canonical(implementation.filename);
    if (implementations.has(key)) return;
    implementations.set(key, implementation);
    const text = host.readFile(implementation.filename);
    if (text === undefined) return;
    const source = ts.createSourceFile(implementation.filename, text, ts.ScriptTarget.Latest, true);
    const commonJs = prepare(implementation.filename)?.result;
    for (const dependency of commonJs?.requires ?? []) {
      if (platformBinding(source, dependency.module, '*')) continue;
      const target = executableResolver!.resolve(dependency.module, implementation.filename);
      if (target) discover(target);
    }
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue;
      if (!statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const module = statement.moduleSpecifier.text;
      if (module === COMMONJS_RECORD_MODULE || commonJs?.requires.some(dependency => dependency.importModule === module)) continue;
      if (ts.isImportDeclaration(statement) && statement.importClause) {
        const clause = statement.importClause;
        const names = [
          ...(clause.name ? ['default'] : []),
          ...(clause.namedBindings && ts.isNamespaceImport(clause.namedBindings) ? ['*']
            : clause.namedBindings ? clause.namedBindings.elements.map(item => (item.propertyName ?? item.name).text) : []),
        ];
        if (names.length && names.every(name => jsxSyntax(module, name) || !!platformBinding(source, module, name)
          || clause.isTypeOnly && (platformTypes.has(quote([module, name])) || platformTypes.has(quote([module, '*']))))) continue;
      }
      const dependency = executableResolver!.resolve(module, implementation.filename);
      if (dependency) discover(dependency);
    }
  }
  discover({ filename: entryFile, origin: 'typescript' });
  const declarationFiles = Object.fromEntries([...implementations.values()].flatMap(implementation =>
    implementation.declarationFile ? [[implementation.filename, implementation.declarationFile]] : []));
  const roots = () => [...new Set([...implementations.values()].flatMap(implementation =>
    [implementation.filename, ...(implementation.declarationFile ? [implementation.declarationFile] : [])]))];
  let program = ts.createProgram(roots(), compilerOptions, host);
  let checker = program.getTypeChecker();
  // CommonJS forwarding can cross conditional require edges. Discover its
  // possible public names without running either branch or lifting its calls.
  const cjsExports = new Map<string, Set<string>>();
  for (const [key, implementation] of implementations) {
    const prepared = prepare(implementation.filename)?.result;
    const source = program.getSourceFile(implementation.filename);
    const values = prepared?.record ? new Set(prepared.exports) : source ? exported(source).values : new Set<string>();
    const declaration = implementation.declarationFile && program.getSourceFile(implementation.declarationFile);
    if (prepared?.record && declaration) for (const name of exported(declaration).values) values.add(name);
    cjsExports.set(key, values);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const [key, implementation] of implementations) {
      const prepared = prepare(implementation.filename)?.result;
      if (!prepared?.record) continue;
      for (const dependency of prepared.requires) {
        if (!dependency.forwarded) continue;
        const target = executableResolver!.resolve(dependency.module, implementation.filename);
        if (!target) continue;
        for (const name of cjsExports.get(canonical(target.filename)) ?? []) if (name !== 'default' && !cjsExports.get(key)!.has(name)) {
          cjsExports.get(key)!.add(name); changed = true;
        }
      }
    }
  }
  for (const [key, implementation] of implementations) {
    const prepared = prepare(implementation.filename);
    if (!prepared?.result.record) continue;
    const source = ts.createSourceFile(implementation.filename, prepared.original, ts.ScriptTarget.Latest, true);
    const result = normalizeCommonJs(source, {...normalizationOptions, exportNames:[...cjsExports.get(key)!]});
    normalizedSources.set(path.resolve(implementation.filename).replaceAll('\\','/'), {original:prepared.original,result});
  }
  if ([...implementations.values()].some(implementation => prepare(implementation.filename)?.result.record)) {
    program = ts.createProgram(roots(), compilerOptions, host);
    checker = program.getTypeChecker();
  }
  const declarationBundle = createDeclarationBundle(compilerOptions, host, options.data?.types);
  for (const implementation of implementations.values()) {
    for (const diagnostic of prepare(implementation.filename)?.result.diagnostics ?? [])
      diagnostics.push({...diagnostic, filename: implementation.filename});
  }
  function report(source: ts.SourceFile, node: ts.Node, code: string, message: string) {
    const position = source.getLineAndCharacterOfPosition(node.getStart(source));
    diagnostics.push({ filename: source.fileName, code, message, line: position.line + 1, column: position.character + 1 });
  }
  function exported(source: ts.SourceFile) {
    const values = new Set<string>(), types = new Set<string>();
    const symbol = checker.getSymbolAtLocation(source);
    for (const item of symbol ? checker.getExportsOfModule(symbol) : []) {
      const target = item.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(item) : item;
      const typeOnly = item.declarations?.some(declaration =>
        ts.isExportSpecifier(declaration) && (declaration.isTypeOnly || declaration.parent.parent.isTypeOnly));
      if (!typeOnly && target.flags & ts.SymbolFlags.Value) values.add(item.name);
      if (typeOnly || target.flags & (ts.SymbolFlags.Type | ts.SymbolFlags.Namespace)) types.add(item.name);
    }
    return { values, types };
  }
  function load(filename: string): Module | undefined {
    const key = canonical(filename);
    const previous = nodes.get(key);
    if (previous) return previous;
    const source = program.getSourceFile(filename);
    if (!source || source.isDeclarationFile || !/\.(?:[cm]?[jt]s|[jt]sx)$/.test(filename)) return undefined;
    const names = new Set<string>();
    function scan(node: ts.Node) {
      if (ts.isIdentifier(node)) names.add(node.text);
      ts.forEachChild(node, scan);
    }
    scan(source);
    let exportsType = '__SourceExports';
    while (names.has(exportsType)) exportsType += '_';
    const modeBindings = [...options.bindings];
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)
        || !statement.importClause || statement.importClause.isTypeOnly) continue;
      const module = statement.moduleSpecifier.text, clause = statement.importClause;
      const imported = [
        ...(clause.name ? ['default'] : []),
        ...(clause.namedBindings && ts.isNamespaceImport(clause.namedBindings) ? ['*']
          : clause.namedBindings ? clause.namedBindings.elements.filter(item => !item.isTypeOnly).map(item => (item.propertyName ?? item.name).text) : []),
      ];
      for (const name of imported) {
        const binding = platformBinding(source, module, name);
        if (binding && binding.module !== module) modeBindings.push({ ...binding, module });
      }
    }
    const implementation = implementations.get(key);
    const commonJs = prepare(source.fileName)?.result;
    const namesExported = commonJs?.record ? {values:new Set(['default', ...commonJs.exports]),types:new Set<string>()} : exported(source);
    const declaration = implementation?.declarationFile && program.getSourceFile(implementation.declarationFile);
    if (declaration) for (const name of exported(declaration).types) namesExported.types.add(name);
    let runtimeExportsType=`${exportsType}_Runtime_${nodes.size}`;while(names.has(runtimeExportsType))runtimeExportsType+='_';
    const node: Module = { source, ...(implementation?.declarationFile ? { declarationFile: implementation.declarationFile } : {}),
      ...(implementation?.packageJson?{packageJson:implementation.packageJson}:{}),runtimeExportsType,
      ...(commonJs?.record ? {commonJs} : {}), rawType:`${exportsType}_Raw`,
      id: nodes.size, kind: sourceMode(source,checker,modeBindings), frontendOrigin:sourceFrontend(source), ...namesExported,
      requests: new Set(), imports: new Map(), runtime: [], lazy: [], edits: [], typeBindings: [], typeRequests: new Set(), typeMembers: new Map(), exportsType };
    nodes.set(key, node);
    // Reuse TypeScript's import erasure, rather than initializing a module just
    // because a class/function name appears in a source annotation.
    const emitted = ts.transpileModule(source.text, { compilerOptions: { ...compilerOptions,
      module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.Preserve, noEmit: false } }).outputText;
    const emittedSource = ts.createSourceFile('imports.jsx', emitted, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const runtimeImports = new Set<string>(), runtimeSpecifiers = new Set<string>(), references = new Set<ts.Symbol>();
    for (const statement of emittedSource.statements) if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      runtimeSpecifiers.add(statement.moduleSpecifier.text);
      const clause = statement.importClause;
      if (clause?.name) runtimeImports.add(clause.name.text);
      if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) runtimeImports.add(clause.namedBindings.name.text);
      else if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings))
        for (const item of clause.namedBindings.elements) runtimeImports.add(item.name.text);
    }
    function referenced(current: ts.Node) {
      if (ts.isImportDeclaration(current)) return;
      if (ts.isIdentifier(current)) {
        const symbol = ts.isExportSpecifier(current.parent) ? checker.getExportSpecifierLocalTargetSymbol(current.parent) : checker.getSymbolAtLocation(current);
        if (symbol) references.add(symbol);
      }
      ts.forEachChild(current, referenced);
    }
    referenced(source);
    const fresh = () => { let name = '__linkedImport'; while (names.has(name)) name += '_'; names.add(name); return name; };
    const explicitExports = new Set<string>();
    const sourceSymbol = checker.getSymbolAtLocation(source);
    for (const item of sourceSymbol ? checker.getExportsOfModule(sourceSymbol) : [])
      if (item.declarations?.some(declaration => declaration.getSourceFile() === source)) explicitExports.add(item.name);
    const starExports = new Set<string>();
    function resolve(specifier: string, at: ts.Node, runtime: boolean): Module | undefined {
      const resolved = executableResolver!.resolve(specifier, source!.fileName);
      const target = resolved && load(resolved.filename);
      if (!target) report(source!, at, runtime ? 'graph-implementation' : 'graph-type-binding',
        `No source implementation for ${specifier}; resolve its TypeScript source or supply a shared platform ${runtime ? 'value' : 'type'} binding.`);
      return target;
    }
    function add(module: string, name: string, local: string, explicitType: boolean, at: ts.Node): Import {
      if (node.commonJs?.record && module === COMMONJS_RECORD_MODULE && local === node.commonJs.record.moduleLocal) {
        const item: Import = {module,name,local,typeOnly:false,record:true,
          binding:{module,name,kind:'value',valueType:{module:'../module-records',name:'Module'}}};
        node.imports.set(local,item); return item;
      }
      const requirement = node.commonJs?.requires.find(item => item.importModule === module && item.local === local);
      const sourceName = name;
      const specifier = requirement?.module ?? module;
      if (requirement) name = '*';
      const binding = !explicitType && platformBinding(source!, specifier, name);
      const nativeType = platformType(module, name);
      // Component annotations are projected by its compiler, using the source
      // program's types. They do not create a native runtime/type import.
      const target = binding || jsxSyntax(module, name) || (explicitType && (nativeType || node.kind === 'component')) ? undefined : resolve(specifier, at, !explicitType);
      if (requirement && target?.commonJs?.record) name = 'default';
      const typeOnly = explicitType || !!target && name !== '*' && !target.values.has(name) && target.types.has(name);
      const internal=!!options.javascript&&node.frontendOrigin==='javascript'&&target?.frontendOrigin==='javascript'
        &&!!node.packageJson&&!!target.packageJson&&canonical(node.packageJson)===canonical(target.packageJson);
      if (target && name !== '*' && !target.values.has(name) && !target.types.has(name))
        report(source!, at, 'graph-export', `${module} has no export named ${name}.`);
      if (target && !typeOnly) {
        for (const value of name === '*' ? target.values : [name]) target.requests.add(value);
        const edges = requirement ? node.lazy : node.runtime;
        if (!edges.includes(target)) edges.push(target);
      }
      let usedAsType = false;
      if (target && node.kind === 'data' && !typeOnly) {
        function typeReference(current: ts.Node) {
          if (usedAsType) return;
          if (ts.isTypeReferenceNode(current)) {
            let root = current.typeName;
            while (ts.isQualifiedName(root)) root = root.left;
            const imported = checker.getSymbolAtLocation(root);
            usedAsType = root.text === local && !!imported?.declarations?.some(declaration => declaration.getSourceFile() === source
              && (ts.isImportSpecifier(declaration) || ts.isNamespaceImport(declaration) || ts.isImportClause(declaration)));
          }
          ts.forEachChild(current, typeReference);
        }
        typeReference(source!);
      }
      // A declaration can merge a component value with a type namespace.
      // Re-exporting/calling that value does not consume its namespace types.
      // Runtime typeof already uses the generated native dependency contract.
      if (target && node.kind === 'data' && (typeOnly || usedAsType && (name === '*' || target.types.has(name)))) {
        if (target.declarationFile) {
          const declaration = declarationBundle.add(target.declarationFile);
          if (!node.typeBindings.some(binding => binding.module === module && binding.name === name))
            node.typeBindings.push({module, name, target:{module:`../declarations/${declaration}`, name}});
          const item: Import = {module, name, local, typeOnly, target, ...(internal?{internal:true}:{})};
          node.imports.set(local, item);
          return item;
        }
        nativeTypes.add(target);
        for (const type of name === '*' ? target.types : [name]) target.typeRequests.add(type);
        if (target.kind === 'component') {
          const parts = (value: ts.EntityName): string[] => ts.isIdentifier(value) ? [value.text] : [...parts(value.left), value.right.text];
          function typeUse(current: ts.Node) {
            if (ts.isTypeReferenceNode(current) || ts.isTypeQueryNode(current)) {
              const qualified = ts.isTypeReferenceNode(current) ? current.typeName : current.exprName;
              let root = qualified;
              while (ts.isQualifiedName(root)) root = root.left;
              const imported = checker.getSymbolAtLocation(root);
              if (root.text === local && imported?.declarations?.some(declaration => declaration.getSourceFile() === source
                && (ts.isImportSpecifier(declaration) || ts.isNamespaceImport(declaration) || ts.isImportClause(declaration)))) {
                const path = parts(qualified).slice(1);
                const exported = name === '*' ? path.shift() : name;
                if (ts.isTypeQueryNode(current) && typeOnly) {
                  report(source!, current, 'graph-type-export', `Component value type query ${qualified.getText(source)} requires a linked native value contract.`);
                } else if (ts.isTypeReferenceNode(current) && exported && path.length) {
                  const members = target!.typeMembers.get(exported) ?? new Set<string>();
                  members.add(path.join('.'));
                  target!.typeMembers.set(exported, members);
                }
              }
            }
            ts.forEachChild(current, typeUse);
          }
          typeUse(source!);
        }
        if (!node.typeBindings.some(binding => binding.module === module && binding.name === name))
          node.typeBindings.push({ module, name, target: { module: `./m${target.id}`, name } });
      }
      const item: Import = { module, name, local, typeOnly,
        ...(requirement ? {sourceName,lazy:true,loaderType:`__Require_${node.id}_${node.imports.size}`} : {}),
        ...(binding ? { binding } : {}), ...(target ? { target } : {}), ...(internal?{internal:true}:{}) };
      node.imports.set(local, item);
      return item;
    }
    // Published signatures can introduce real type-only imports while the JS
    // body remains unchanged. Bundle those declarations as types, not runtime
    // modules or handwritten package bindings.
    const published = node.declarationFile ? program.getSourceFile(node.declarationFile) : undefined;
    for (const statement of published ? published.statements : []) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || !statement.importClause) continue;
      const module = statement.moduleSpecifier.text;
      if ((options.data?.types ?? []).some(binding => binding.module === module && binding.name === '*')) continue;
      const resolved = ts.resolveModuleName(module, published!.fileName, compilerOptions, host, cache).resolvedModule;
      if (!resolved || !/\.d\.[cm]?ts$/.test(resolved.resolvedFileName)) continue;
      const declaration = declarationBundle.add(resolved.resolvedFileName);
      const clause = statement.importClause;
      const names = [
        ...(clause.name ? ['default'] : []),
        ...(clause.namedBindings && ts.isNamespaceImport(clause.namedBindings) ? ['*']
          : clause.namedBindings ? clause.namedBindings.elements.map(item => (item.propertyName ?? item.name).text) : []),
      ];
      for (const name of names) if (!node.typeBindings.some(binding => binding.module === module && binding.name === name))
        node.typeBindings.push({module, name, target:{module:`../declarations/${declaration}`, name}});
    }
    for (const statement of source.statements) {
      if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
        const specifier = statement.moduleSpecifier.text, clause = statement.importClause;
        if (!clause) {
          const target = resolve(specifier, statement, true);
          if (target && !node.runtime.includes(target)) node.runtime.push(target);
          node.edits.push({ start: statement.getStart(source), end: statement.end, text: '' });
          continue;
        }
        let changed = false;
        const parts: string[] = [];
        const used = (local: ts.Identifier) => {
          const symbol = checker.getSymbolAtLocation(local);
          return runtimeImports.has(local.text) || !!symbol && references.has(symbol);
        };
        if (clause.name) {
          if (used(clause.name)) {
            const item = add(specifier, 'default', clause.name.text, clause.isTypeOnly || !runtimeImports.has(clause.name.text), clause.name);
            if (item.typeOnly && !clause.isTypeOnly) changed = true;
            parts.push(`import ${item.typeOnly ? 'type ' : ''}${clause.name.text} from ${quote(specifier)};`);
          } else changed = true;
        }
        if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
          if (used(clause.namedBindings.name)) {
            const item = add(specifier, '*', clause.namedBindings.name.text, clause.isTypeOnly || !runtimeImports.has(clause.namedBindings.name.text), clause.namedBindings);
            if (item.typeOnly && !clause.isTypeOnly || item.name === 'default') changed = true;
            parts.push(`import ${item.typeOnly ? 'type ' : ''}${item.name === 'default' ? item.local : `* as ${item.local}`} from ${quote(specifier)};`);
          } else changed = true;
        } else if (clause.namedBindings) {
          const entries = clause.namedBindings.elements.flatMap(entry => {
            if (!used(entry.name)) { changed = true; return []; }
            const item = add(specifier, (entry.propertyName ?? entry.name).text, entry.name.text,
              clause.isTypeOnly || entry.isTypeOnly || !runtimeImports.has(entry.name.text), entry);
            if (item.typeOnly !== (clause.isTypeOnly || entry.isTypeOnly)) changed = true;
            return [`${item.typeOnly ? 'type ' : ''}${entry.propertyName ? `${entry.propertyName.text} as ` : ''}${entry.name.text}`];
          });
          if (entries.length) parts.push(`import {${entries.join(',')}} from ${quote(specifier)};`);
          else {
            changed = true;
            if (!clause.name && runtimeSpecifiers.has(specifier)) {
              const target = resolve(specifier, statement, true);
              if (target && !node.runtime.includes(target)) node.runtime.push(target);
            }
          }
        }
        if (changed) node.edits.push({ start: statement.getStart(source), end: statement.end, text: parts.join('') });
      } else if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
        const specifier = statement.moduleSpecifier.text;
        const parts: string[] = [];
        function reexport(name: string, output: string, typeOnly: boolean, at: ts.Node) {
          const local = fresh();
          const item = add(specifier, name, local, typeOnly, at);
          const imported = name === '*' ? `* as ${local}` : `{${moduleName(name)} as ${local}}`;
          parts.push(`import ${item.typeOnly ? 'type ' : ''}${imported} from ${quote(specifier)};export ${item.typeOnly ? 'type ' : ''}{${local} as ${moduleName(output)}};`);
        }
        if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
          for (const entry of statement.exportClause.elements) reexport((entry.propertyName ?? entry.name).text, entry.name.text,
            statement.isTypeOnly || entry.isTypeOnly, entry);
        } else if (statement.exportClause) reexport('*', statement.exportClause.name.text, statement.isTypeOnly, statement);
        else {
          const target = resolve(specifier, statement, !statement.isTypeOnly);
          if (target) {
            if (!statement.isTypeOnly && !node.runtime.includes(target)) node.runtime.push(target);
            for (const name of new Set([...target.values, ...target.types])) {
              if (name === 'default' || explicitExports.has(name) || starExports.has(name)) continue;
              starExports.add(name);
              reexport(name, name, statement.isTypeOnly || !target.values.has(name), statement);
            }
          }
        }
        node.edits.push({ start: statement.getStart(source), end: statement.end, text: parts.join('') });
      } else if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
        const local = fresh();
        node.edits.push({start: statement.getStart(source), end: statement.end,
          text: `const ${local} = ${statement.expression.getText(source)};export { ${local} as default };`});
      } else if (ts.isImportEqualsDeclaration(statement) || ts.isExportAssignment(statement)) {
        report(source, statement, 'graph-module-form', 'CommonJS/import-equals and export assignments need a source module contract.');
      }
    }
    function dynamic(current: ts.Node) {
      if (ts.isCallExpression(current) && current.expression.kind === ts.SyntaxKind.ImportKeyword)
        report(source!, current, 'graph-dynamic-import', 'Dynamic imports require an asynchronous module owner.');
      ts.forEachChild(current, dynamic);
    }
    dynamic(source);
    return node;
  }
  const entry = load(entryFile);
  if (!entry) diagnostics.push({ filename: entryFile, line: 1, column: 1, code: 'graph-entry', message: 'The entry must be a TypeScript or JavaScript source implementation.' });
  if (!options.exports.length || new Set(options.exports).size !== options.exports.length)
    diagnostics.push({ filename: entryFile, line: 1, column: 1, code: 'graph-export', message: 'Choose a nonempty list of unique runtime exports.' });
  if (entry) for (const name of options.exports) {
    if (!entry.values.has(name)) report(entry.source, entry.source, 'graph-export', `The entry has no runtime export named ${name}.`);
    entry.requests.add(name);
  }
  if (entry && (platforms.size !== options.bindings.length || options.bindings.some(binding =>
    !binding.module || !binding.name || binding.kind === 'value' && !binding.valueType)))
    report(entry.source, entry.source, 'graph-binding', 'Shared bindings must have unique module/export keys; value bindings require a checked native type.');
  for (const node of nodes.values()) {
    const publicBindings = new Set<ts.Symbol>();
    const moduleSymbol = checker.getSymbolAtLocation(node.source);
    for (const item of moduleSymbol ? checker.getExportsOfModule(moduleSymbol) : []) {
      const target = item.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(item) : item;
      if (target.declarations?.some(declaration => declaration.getSourceFile() === node.source)) publicBindings.add(target);
    }
    for(const write of moduleBindingStability(node.source,checker).writes)if(write.deferred&&publicBindings.has(write.symbol))
      report(node.source,write.identifier,'graph-live-binding','Reassigning an exported binding after module initialization requires a live module reference.');
    if (!node.source.statements.some(statement => ts.isExportDeclaration(statement) && !statement.exportClause && !statement.isTypeOnly)) continue;
    // TypeScript already knows whether multiple star paths have the same
    // original binding or an ambiguous export. Do not invent a second rule.
    for (const diagnostic of program.getSemanticDiagnostics(node.source)) if (diagnostic.code === 2308) {
      const at = node.source.getLineAndCharacterOfPosition(diagnostic.start ?? 0);
      diagnostics.push({ filename: node.source.fileName, line: at.line + 1, column: at.character + 1,
        code: 'graph-ambiguous-export', message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n') });
    }
  }
  const order: Module[] = [], visiting = new Set<Module>(), visited = new Set<Module>();
  function visit(node: Module, trail: Module[]) {
    if (visiting.has(node)) {
      const cycle = trail.slice(trail.indexOf(node));
      if (cycle.every((owner,index) => owner.commonJs?.record && owner.lazy.includes(cycle[(index + 1) % cycle.length]!))) return;
      report(node.source, node.source, 'graph-cycle', `Runtime module cycle requires live bindings: ${[...trail, node].map(value => value.source.fileName).join(' -> ')}`);
      return;
    }
    if (visited.has(node)) return;
    visiting.add(node);
    for (const child of [...node.runtime,...node.lazy]) visit(child, [...trail, node]);
    visiting.delete(node); visited.add(node); order.push(node);
  }
  if (entry) visit(entry, []);
  const eagerOrder: Module[] = [], eager = new Set<Module>();
  function eagerVisit(node: Module) {
    if (eager.has(node)) return;
    eager.add(node);
    for (const dependency of node.runtime) eagerVisit(dependency);
    eagerOrder.push(node);
  }
  if (entry) eagerVisit(entry);
  const metadata = () => [...nodes.values()].map(node => ({ filename: node.source.fileName,
    ...(node.declarationFile ? { declarationFile: node.declarationFile } : {}),
    ...(node.compiled ? { outputFile: `modules/m${node.id}.ts` } : {}), kind: node.kind,frontendOrigin:node.frontendOrigin,
    sourceSha256: hash(prepare(node.source.fileName)?.original ?? node.source.text),
    exports: [...node.requests], runtime: visited.has(node), ...(node.component ? { component: node.component } : {}),
    ...(node.data ? { data: node.data } : {}),...(node.javascript?{implementationTyping:'dynamic-js-value' as const,
      publicTyping:node.declarationFile?'published-declaration' as const:'inferred-js-exports' as const,
      ...(node.declarationFile?{declarationSha256:hash(program.getSourceFile(node.declarationFile)?.text??'')}:{}),
      implementationTypeProof:false as const,internalRuntimeExports:node.runtimeExports??[],internalRuntimeTyping:'same-package-js-values' as const}:{}),
    ...(node.commonJs?.record&&node.declarationFile?{declarationInterop:'commonjs-namespace' as const}:{}) }));
  const inputs = program.getSourceFiles().filter(source => !program.isSourceFileDefaultLibrary(source));
  const result = (): ProjectResult => ({ diagnostics, modules: metadata(), initializationOrder: eagerOrder.map(node => node.source.fileName),
    inputs: inputs.map(source => ({ filename: source.fileName, sha256: hash(prepare(source.fileName)?.original ?? source.text) })) });
  if (diagnostics.length || !entry) return result();
  const resolution: SourceResolution = {};
  Object.assign(resolution, { declarationFiles, packageJsons: Object.fromEntries(packageJsons), typedJavaScript: true,
    dynamicProperties: Boolean(options.data?.dynamicProperties || options.component?.values?.dynamicProperties) });
  for (const key of ['baseUrl', 'paths', 'module', 'moduleResolution', 'jsx'] as const) {
    const value = compilerOptions[key];
    if (value !== undefined) Object.assign(resolution, { [key]: value });
  }
  const typeInputs = inputs;
  const typeFiles=new Map(typeInputs.map(source=>[canonical(source.fileName),source]));
  const typeEdges=new Map<ts.SourceFile,Set<ts.SourceFile>>();
  const globalTypeInputs=typeInputs.filter(source=>!ts.isExternalModule(source)||compilerTypes.has(canonical(source.fileName))
    ||source.statements.some(statement=>ts.isNamespaceExportDeclaration(statement)
      ||ts.isModuleDeclaration(statement)&&!!(statement.flags&ts.NodeFlags.GlobalAugmentation)));
  function typeDependencies(source:ts.SourceFile):Set<ts.SourceFile>{
    const previous=typeEdges.get(source);if(previous)return previous;
    const dependencies=new Set<ts.SourceFile>();typeEdges.set(source,dependencies);
    const add=(name:string)=>{const target=typeFiles.get(canonical(name));if(target&&target!==source)dependencies.add(target);};
    for(const reference of source.referencedFiles)add(path.resolve(path.dirname(source.fileName),reference.fileName));
    const inspect=(node:ts.Node)=>{
      const specifier=ts.isImportDeclaration(node)||ts.isExportDeclaration(node)?node.moduleSpecifier
        :ts.isImportTypeNode(node)&&ts.isLiteralTypeNode(node.argument)?node.argument.literal
        :ts.isExternalModuleReference(node)?node.expression:undefined;
      if(specifier&&ts.isStringLiteralLike(specifier)){
        const symbol=checker.getSymbolAtLocation(specifier);
        for(const declaration of symbol?.declarations??[])add(declaration.getSourceFile().fileName);
      }
      ts.forEachChild(node,inspect);
    };
    inspect(source);return dependencies;
  }
  function moduleTypeSources(node:Module){
    const reachable=new Set<ts.SourceFile>(),pending=[...globalTypeInputs];
    const modules=new Set<Module>();
    const include=(current:Module)=>{
      if(modules.has(current))return;modules.add(current);pending.push(current.source);
      if(current.declarationFile){const declaration=typeFiles.get(canonical(current.declarationFile));if(declaration)pending.push(declaration);}
      for(const dependency of [...current.runtime,...current.lazy,...[...current.imports.values()].flatMap(item=>item.target?[item.target]:[])])include(dependency);
    };
    include(node);
    while(pending.length){
      const source=pending.pop()!;if(reachable.has(source))continue;reachable.add(source);
      for(const dependency of typeDependencies(source))pending.push(dependency);
    }
    const own=canonical(node.source.fileName);
    return [...reachable].filter(source=>canonical(source.fileName)!==own)
      .map(source=>({filename:source.fileName,source:source.text}));
  }
  const globals = new Set([
    ...(options.component?.globals ?? []).map(binding => binding.name),
    ...(options.data?.globals ?? []).map(binding => binding.name),
    ...(['forInKeys', 'records', 'arrays', 'nulls', 'propertyKeyString', 'propertyHas', 'objectMethods', 'typeIs', 'typeOf', 'functions', 'numberStrings', 'classChecks', 'strings', 'dynamicProperties'] as const)
      .flatMap(key => { const binding = options.data?.[key]; return binding ? [binding.name] : []; }),
  ]);
  const files: ProjectFile[] = [];
  const hostFields = new Map<string, string>(), globalFields = new Map<string, string>();
  const platformFields = new Map<string, Map<string, string>>();
  const calls: string[] = [];
  const loaderDeclarations: string[] = [], recordImports: string[] = [], recordTypes: string[] = [], rootTypes: string[] = [];
  const hasCommonJs = order.some(node => node.commonJs?.record);
  let nativeSerial = 0;
  const nativeType = (binding: ImportBinding): ValueTypeBinding => binding.valueType ?? binding.componentType ?? {
    module: options.component?.typesModule ?? '@3xjn/roblox-css-react/src/Html',
    name: { component: 'Component', className: 'ClassName', variants: 'VariantFactory', mergeProps: 'MergeProps', render: 'ElementRenderer', value: 'Node' }[binding.kind],
  };
  function referencedType(binding: ValueTypeBinding, imports: string[], factoryRelative = false): string {
    const alias = `__ModuleRecordType${nativeSerial++}`;
    const module = factoryRelative && binding.module.startsWith('.') ? `./${path.posix.normalize(`modules/${binding.module}`)}` : binding.module;
    imports.push(binding.name === '*' ? `import type * as ${alias} from ${quote(module)};`
      : `import type {${binding.name} as ${alias}} from ${quote(module)};`);
    const base = binding.typeOf ? `(typeof ${alias})` : alias;
    return binding.member === undefined ? base : `${base}[${quote(binding.member)}]`;
  }
  if (hasCommonJs && options.data?.records) {
    const records = options.data.records;
    if (!globalFields.has(records.name)) globalFields.set(records.name, referencedType(records.valueType, rootTypes, true));
  }
  // Component factories erase source annotations. Reuse their checked portable
  // type projection for types consumed by data modules, without importing or
  // running the component merely to make its type available.
  function componentTypeExports(node: Module): string {
    const symbol = checker.getSymbolAtLocation(node.source);
    const exports = new Map((symbol ? checker.getExportsOfModule(symbol) : []).map(item => [item.name, item]));
    const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
    const declarations: string[] = [];
    const html = `${node.exportsType}_NativeTypes`;
    let needsHtml = false;
    const unalias = (symbol: ts.Symbol) => symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
    function emitType(symbol: ts.Symbol, local: string, requested: Set<string> | undefined, nested = false): ts.Statement {
      const target = unalias(symbol);
      const shapes = target.declarations?.filter(item => ts.isTypeAliasDeclaration(item) || ts.isInterfaceDeclaration(item)) ?? [];
      const declaration = shapes[0];
      const modifiers = nested ? [ts.factory.createModifier(ts.SyntaxKind.ExportKeyword)] : undefined;
      if (!shapes.length && target.declarations?.some(ts.isModuleDeclaration)) {
        const members = new Map(checker.getExportsOfModule(target).map(member => [member.name, member]));
        const wanted = requested?.size ? new Set([...requested].map(path => path.split('.')[0]!))
          : new Set([...members].filter(([, member]) => unalias(member).flags & (ts.SymbolFlags.Type | ts.SymbolFlags.Namespace)).map(([name]) => name));
        const body = [...wanted].map(name => {
          const member = members.get(name);
          if (!member) throw new Error(`Namespace type member ${name} is not exported.`);
          const paths = requested && new Set([...requested].filter(path => path.startsWith(`${name}.`)).map(path => path.slice(name.length + 1)));
          return emitType(member, name, paths, true);
        });
        return ts.factory.createModuleDeclaration([...(modifiers ?? []), ...(!nested ? [ts.factory.createModifier(ts.SyntaxKind.DeclareKeyword)] : [])],
          ts.factory.createIdentifier(local), ts.factory.createModuleBlock(body), ts.NodeFlags.Namespace);
      }
      if (shapes.length !== 1 || target.flags & ts.SymbolFlags.Class
        || !declaration || !(ts.isTypeAliasDeclaration(declaration) || ts.isInterfaceDeclaration(declaration)))
        throw new Error('This export needs an explicit platform type binding.');
      const active = new Set<ts.Symbol>();
      const projection = createTypeProjection(checker, declaration.typeParameters, type => {
        if (!ts.isTypeReferenceNode(type)) return undefined;
        let root = type.typeName;
        while (ts.isQualifiedName(root)) root = root.left;
        const rootSymbol = checker.getSymbolAtLocation(root);
        const react = rootSymbol?.declarations?.some(declaration => {
          const imported = ts.findAncestor(declaration, ts.isImportDeclaration);
          return imported && ts.isStringLiteral(imported.moduleSpecifier) && imported.moduleSpecifier.text === 'react';
        }) || !rootSymbol?.declarations?.length && root.text === 'React';
        const label = type.typeName.getText(type.getSourceFile());
        if ((react && ['ReactNode', 'React.ReactNode'].includes(label))
          || (react && ['ReactElement', 'React.ReactElement', 'React.JSX.Element'].includes(label))
          || !rootSymbol?.declarations?.length && label === 'JSX.Element') {
          needsHtml = true;
          return ts.factory.createTypeReferenceNode(`${html}.${label.endsWith('ReactNode') ? 'Node' : 'Element'}`);
        }
        if (!ts.isQualifiedName(type.typeName)) return undefined;
        const memberSymbol = checker.getSymbolAtLocation(type.typeName);
        const member = memberSymbol && unalias(memberSymbol);
        const shape = member?.declarations?.find(item => !item.getSourceFile().isDeclarationFile
          && (ts.isTypeAliasDeclaration(item) || ts.isInterfaceDeclaration(item)));
        if (!member || !shape || !(ts.isTypeAliasDeclaration(shape) || ts.isInterfaceDeclaration(shape))) return undefined;
        if (active.has(member)) throw new Error('Recursive namespace types need a platform type binding.');
        active.add(member);
        try { return projection.data(ts.factory.createTypeReferenceNode(shape.name, type.typeArguments)); }
        finally { active.delete(member); }
      });
      const parameters = declaration.typeParameters?.map(parameter => ts.factory.createTypeParameterDeclaration(undefined, parameter.name.text,
        parameter.constraint && projection.data(parameter.constraint), parameter.default && projection.data(parameter.default)));
      const own = projection.data(ts.isTypeAliasDeclaration(declaration) ? declaration.type : ts.factory.createTypeLiteralNode(declaration.members));
      const inherited = ts.isInterfaceDeclaration(declaration) ? declaration.heritageClauses?.flatMap(clause => clause.types.map(base => {
        if (!ts.isIdentifier(base.expression)) throw new Error('Qualified interface bases need a platform type binding.');
        return projection.data(ts.factory.createTypeReferenceNode(base.expression, base.typeArguments));
      })) ?? [] : [];
      const type = inherited.length ? ts.factory.createIntersectionTypeNode([...inherited, own]) : own;
      return ts.factory.createTypeAliasDeclaration(modifiers, local, parameters, type);
    }
    for (const name of node.typeRequests) {
      const exported = exports.get(name);
      try {
        if (!exported) throw new Error('This type is not exported.');
        // An export alias can be called "default" or another non-identifier.
        // Keep its public spelling in an export specifier, not a declaration.
        const local = `${node.exportsType}_${declarations.length}`;
        declarations.push(printer.printNode(ts.EmitHint.Unspecified, emitType(exported, local, node.typeMembers.get(name)), node.source)
          + `\nexport type { ${local} as ${moduleName(name)} };`);
      } catch (error) {
        report(node.source, node.source, 'graph-type-export',
          `Native type export ${name}: ${(error as Error).message}`);
      }
    }
    return (needsHtml ? `import type * as ${html} from ${quote(options.component?.typesModule ?? '@3xjn/roblox-css-react/src/Html')};\n` : '') + declarations.join('\n');
  }
  for (const node of nodes.values()) {
    if (!visited.has(node) && !nativeTypes.has(node)) continue; // Source-only type proof.
    const javascript=!!options.javascript&&node.frontendOrigin==='javascript';
    const exportedTypes = node.kind === 'component' && !javascript ? componentTypeExports(node) : '';
    if (node.kind === 'component' && !visited.has(node)) {
      node.compiled = exportedTypes;
      files.push({ filename: `modules/m${node.id}.ts`, source: exportedTypes });
      continue;
    }
    const linked = link(node.source, node.edits);
    const sourceBindings: ImportBinding[] = [...node.imports.values()].flatMap(item => {
      if (item.typeOnly) return [];
      if (item.lazy) {
        const type = item.binding ? referencedType(nativeType(item.binding),recordImports,true)
          : referencedType({module:`./modules/m${item.target!.id}`,name:item.target!.commonJs?.record ? item.target!.rawType : item.target!.exportsType},recordImports);
        recordTypes.push(`export type ${item.loaderType} = () => ${type};`);
        return [{module:item.module,name:item.sourceName!,kind:'value',valueType:{module:'../module-records',name:item.loaderType!}}];
      }
      if (item.binding) return [{ ...item.binding, module: item.module }];
      if (!item.target) return [];
      return [{ module: item.module, name: item.name, kind: 'value',
        ...(item.name === '*' && item.target.values.size ? { members: [...item.target.values] } : {}),
        valueType: { module: `./m${item.target.id}`, name: item.internal ? item.target.runtimeExportsType : item.target.exportsType, ...(item.name === '*' ? {} : { member: item.name }) } }];
    });
    const bindings = [...new Map(sourceBindings.map(binding => [quote([binding.module, binding.name]), binding])).values()];
    const typeSources = moduleTypeSources(node);
    // Loader imports make CommonJS look like ESM. Use original strictness.
    const original = prepare(node.source.fileName)?.original ?? node.source.text;
    const originalSource = ts.createSourceFile(node.source.fileName, original, ts.ScriptTarget.Latest, true);
    let sourceStrict = ts.isExternalModule(originalSource) || /\.(?:mjs|mts)$/i.test(node.source.fileName);
    for (const statement of originalSource.statements) {
      if (!ts.isExpressionStatement(statement) || !ts.isStringLiteral(statement.expression)) break;
      if (statement.expression.text === 'use strict') sourceStrict = true;
    }
    const localTypeQueries:Record<string,{module:string;name:string}>=Object.create(null);
    if(node.declarationFile&&node.kind==='data'){
      const companion=program.getSourceFile(node.declarationFile);
      const runtimeConsts=new Set(node.source.statements.flatMap(statement=>ts.isVariableStatement(statement)&&statement.declarationList.flags&ts.NodeFlags.Const
        ?statement.declarationList.declarations.filter(declaration=>ts.isIdentifier(declaration.name)).map(declaration=>(declaration.name as ts.Identifier).text):[]));
      const inspect=(current:ts.Node)=>{
        if(ts.isTypeQueryNode(current)){
          let root=current.exprName;while(ts.isQualifiedName(root))root=root.left;
          const symbol=checker.getSymbolAtLocation(root),declaration=symbol?.valueDeclaration;
          if(runtimeConsts.has(root.text)&&declaration&&ts.isVariableDeclaration(declaration)
            &&declaration.getSourceFile()===companion&&ts.isVariableDeclarationList(declaration.parent)
            &&declaration.parent.flags&ts.NodeFlags.Const&&ts.isVariableStatement(declaration.parent.parent)
            &&declaration.parent.parent.parent===companion){
            const query=declarationBundle.exposeQuery(node.declarationFile!,root.text);
            if(query)localTypeQueries[root.text]={module:`../declarations/${query.module}`,name:query.name};
          }
        }
        ts.forEachChild(current,inspect);
      };
      if(companion)inspect(companion);
    }
    const sourceResolution = {...resolution, sourceStrict,localTypeQueries};
    let jsx:import('./javascript-module.ts').JavaScriptModuleOptions['jsx'];
    if(javascript&&containsJsx(node.source)){
      const names=new Set<string>();
      const scan=(current:ts.Node):void=>{if(ts.isIdentifier(current))names.add(current.text);ts.forEachChild(current,scan);};scan(node.source);
      const use=(name:'jsx'|'jsxs'|'Fragment')=>{
        const binding=platformBinding(node.source,'react/jsx-runtime',name);
        if(!binding||binding.kind!=='value'){report(node.source,node.source,'javascript-jsx',`JSX requires a shared react/jsx-runtime#${name} value binding.`);return undefined;}
        let local=name==='jsx'?'__sourceJsx':name==='jsxs'?'__sourceJsxs':'__sourceFragment';while(names.has(local)||node.imports.has(local))local+='_';names.add(local);
        node.imports.set(local,{module:'react/jsx-runtime',name,local,typeOnly:false,binding});
        return {name:local,valueType:nativeType(binding)};
      };
      const factory=use('jsx'),multiple=use('jsxs'),fragment=use('Fragment');
      if(factory&&multiple&&fragment)jsx={factory,multiple,fragment};
    }
    const compiled = javascript
      ?compileJavaScriptModule(linked.text,{filename:node.source.fileName,runtimeExportsType:node.runtimeExportsType,
        operations:options.javascript!.operations,nulls:options.javascript!.nulls,
        globals:options.data?.globals??[],bindings:bindings.map(binding=>({module:binding.module,name:binding.name,valueType:nativeType(binding)})),
        ...(node.declarationFile?{declarationModule:`../declarations/${declarationBundle.add(node.declarationFile)}`} :{}),
        ...(node.commonJs?.record?{declarationInterop:'commonjs-namespace' as const}:{}),commonJs:!!node.commonJs?.record,
        ...(jsx?{jsx}:{}),strict:sourceStrict})
      : node.kind === 'component'
      ? compileComponent(linked.text, { ...options.component, filename: node.source.fileName, bindings,
        types:[...(options.component?.types ?? []),...node.typeBindings],
        exports: node.requests.size ? [...node.requests] : [...node.values], typeSources, sourceResolution })
      : compileDataModule(linked.text, { ...options.data, filename: node.source.fileName,
        bindings: bindings.map(binding => ({ module: binding.module, name: binding.name, valueType: nativeType(binding) })),
        types: [...(options.data?.types ?? []), ...node.typeBindings], typeSources, sourceResolution });
    if ('sourceFeatures' in compiled) { if(compiled.sourceValueContext)node.valueContext=compiled.sourceValueContext;node.component = { intrinsics: compiled.intrinsics, sourceFeatures: compiled.sourceFeatures,
      variantDefinitions: compiled.variantDefinitions, svgAssets: compiled.svgAssets,
      typeProofs: compiled.typeProofs, renamedIdentifiers: compiled.renamedIdentifiers, trustedJavaScriptContracts:compiled.trustedJavaScriptContracts,
      ...(compiled.sourceValueContext?{sourceValueContext:compiled.sourceValueContext}:{}) };}
    else if('classCollisions' in compiled)node.data = {classCollisions:compiled.classCollisions, nulls:compiled.nulls,
      arrayLiterals:compiled.arrayLiterals, arrayOperations:compiled.arrayOperations,
      unknownAssertions:compiled.unknownAssertions, renamedIdentifiers:compiled.renamedIdentifiers, trustedJavaScriptContracts:compiled.trustedJavaScriptContracts};
    else {node.javascript=true;node.valueContext=compiled.sourceValueContext;node.runtimeExports=compiled.runtimeExports;}
    for (const diagnostic of compiled.diagnostics) {
      if (diagnostic.filename && canonical(diagnostic.filename) !== canonical(node.source.fileName)) diagnostics.push(diagnostic);
      else {
        const offset = linked.source.getPositionOfLineAndCharacter(diagnostic.line - 1, diagnostic.column - 1);
        const at = node.source.getLineAndCharacterOfPosition(linked.original(offset));
        diagnostics.push({ ...diagnostic, filename: node.source.fileName, line: at.line + 1, column: at.character + 1 });
      }
    }
    if (!compiled.source) continue;
    const factory = factoryContract(compiled.source);
    if (!factory) { report(node.source, node.source, 'graph-factory', 'Compiler output has no recognized typed module factory.'); continue; }
    node.dependencyKeys = factory.keys;
    let contract = javascript?`export type ${node.exportsType} = ReturnType<typeof ${factory.name}>;`
      :`export type ${node.exportsType} = Readonly<ReturnType<typeof ${factory.name}>>;`;
    if (node.commonJs?.record) {
      if (node.declarationFile) {
        const declaration = declarationBundle.add(node.declarationFile);
        contract = `import type * as __CommonJsPublished from "../declarations/${declaration}";\nexport type ${node.rawType} = typeof __CommonJsPublished;\nexport type ${node.exportsType} = Pick<${node.rawType},Exclude<keyof ${node.rawType},"default">> & {readonly default:${node.rawType}};`;
      } else contract = `export type ${node.exportsType} = ReturnType<ReturnType<typeof ${factory.name}>[${quote(node.commonJs.record.namespaceExport)}]>;\nexport type ${node.rawType} = ${node.exportsType}["default"];`;
    }
    const typeValueAliases:string[]=[];
    const moduleSource=ts.createSourceFile(node.source.fileName,compiled.source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
    const referencedTypeNames=new Set<string>();
    const rootName=(name:ts.EntityName):ts.Identifier=>ts.isIdentifier(name)?name:rootName(name.left);
    const scanTypes=(current:ts.Node)=>{
      if(ts.isTypeReferenceNode(current))referencedTypeNames.add(rootName(current.typeName).text);
      if(ts.isTypeQueryNode(current))referencedTypeNames.add(rootName(current.exprName).text);
      if(ts.isComputedPropertyName(current)&&ts.isPropertyAccessExpression(current.expression))referencedTypeNames.add(current.expression.expression.getText(moduleSource));
      ts.forEachChild(current,scanTypes);
    };
    scanTypes(moduleSource);
    for(const statement of moduleSource.statements){
      if(!ts.isImportDeclaration(statement)||!statement.importClause?.namedBindings||!ts.isNamedImports(statement.importClause.namedBindings))continue;
      for(const element of statement.importClause.namedBindings.elements){
        const imported=(element.propertyName??element.name).text,alias=element.name.text;
        if(imported===alias||!ts.isIdentifier(element.propertyName??element.name)||!referencedTypeNames.has(imported))continue;
        const dependency=node.imports.get(imported);
        if(dependency&&!dependency.typeOnly&&node.dependencyKeys?.includes(imported))
          typeValueAliases.push(`declare const ${imported}: __ModuleDependencies[${JSON.stringify(imported)}];`);
        else typeValueAliases.push(`type ${imported} = ${alias};`);
      }
    }
    node.compiled = `${compiled.source}\n${typeValueAliases.join('\n')}\n${contract}\n${exportedTypes}`;
    files.push({ filename: `modules/m${node.id}.ts`, source: node.compiled });
  }
  for (const node of order) {
    const entries: string[] = [];
    for (const name of node.dependencyKeys ?? []) {
      const type = `Parameters<typeof __create${node.id}>[0][${quote(name)}]`;
      const dependency = node.imports.get(name);
      let value: string;
      if(name===node.valueContext?.name){
        for(const binding of node.valueContext.bindings)if(!globalFields.has(binding.name))globalFields.set(binding.name,`${type}[${quote(binding.name)}]`);
        value='__context.globals';
      }
      else if (dependency?.record) value = '__cjsModule';
      else if (dependency?.target && !dependency.typeOnly) {
        const target = dependency.target;
        value = dependency.lazy ? `() => ${target.commonJs?.record ? `__record${target.id}.require()` : `__load${target.id}()`}`
          : `${hasCommonJs ? `__load${target.id}()` : `__m${target.id}`}${dependency.name === '*' ? '' : `[${quote(dependency.name)}]`}`;
      }
      else if (dependency?.binding) {
        const binding = dependency.binding;
        const fields = platformFields.get(binding.module) ?? new Map();
        if (!fields.has(binding.name)) fields.set(binding.name, dependency.lazy ? `ReturnType<${type}>` : type);
        platformFields.set(binding.module, fields);
        value = `__context.bindings[${quote(binding.module)}][${quote(binding.name)}]`;
        if (dependency.lazy) value = `() => ${value}`;
      } else if (globals.has(name)) {
        if (!globalFields.has(name)) globalFields.set(name, type);
        value = `__context.globals[${quote(name)}]`;
      } else if (node.kind === 'component' && ['element', 'fragment', 'rest', 'typeOf', 'numberStyle', 'strings', 'staticSvgProps'].includes(name)) {
        if (!hostFields.has(name)) hostFields.set(name, type);
        value = `__context.host[${quote(name)}]`;
      } else {
        report(node.source, node.source, 'graph-dependency', `No shared owner for generated dependency ${name}.`);
        continue;
      }
      entries.push(`${quote(name)}: ${value}`);
    }
    calls.push(`  const __m${node.id} = __create${node.id}({ ${entries.join(', ')} });`);
    if (hasCommonJs) {
      const initializeDependencies = node.runtime.map(dependency => `__load${dependency.id}();`).join('\n');
      if (node.commonJs?.record) {
        const type = `__CommonJsExports${node.id}`;
        const raw = `__CommonJsRaw${node.id}`;
        rootTypes.push(`import type {${node.exportsType} as ${type}, ${node.rawType} as ${raw}} from "./modules/m${node.id}";`);
        loaderDeclarations.push(`  const __record${node.id} = __commonJs<${type},${raw}>((__cjsModule) => {${initializeDependencies}\nreturn __create${node.id}({${entries.join(',')}})[${quote(node.commonJs.record.namespaceExport)}] as () => ${type};}, __createCommonJsExports);\n  const __load${node.id} = __record${node.id}.load;`);
      } else loaderDeclarations.push(`  const __load${node.id} = __esm(() => {${initializeDependencies}\nreturn __create${node.id}({${entries.join(',')}});});`);
    }
  }
  if (diagnostics.length) return result();
  diagnostics.push(...declarationBundle.diagnostics);
  if (diagnostics.length) return result();
  const defineChecks: string[] = [];
  const defineShapes = new Map<string, Map<string, unknown>>();
  for (const [name, value] of Object.entries(appliedDefines)) {
    const [root, ...path] = name.split('.') as [string, ...string[]];
    const shape = defineShapes.get(root) ?? new Map<string, unknown>();
    defineShapes.set(root, shape);
    let current = shape;
    for (const [index, member] of path.entries()) {
      const nested = current.get(member);
      if (index === path.length - 1) current.set(member, 'unknown');
      else {
        const next = nested instanceof Map ? nested : new Map<string, unknown>();
        current.set(member, next); current = next;
      }
    }
    const access = `__context.globals[${quote(root)}]${path.map(member => `[${quote(member)}]`).join('')}`;
    defineChecks.push(`  if (${access} !== ${value === undefined ? 'undefined' : JSON.stringify(value)}) throw ${quote(`Compiled project requires ${name} = ${String(value)}`)};`);
  }
  function defineShape(shape: Map<string, unknown>): string {
    return shape.size ? `{ ${[...shape].map(([name, value]) => `readonly ${quote(name)}: ${value instanceof Map ? defineShape(value) : 'unknown'};`).join(' ')} }` : 'unknown';
  }
  for (const [name, shape] of defineShapes) if (!globalFields.has(name)) globalFields.set(name, defineShape(shape));
  const fields = (items: Map<string, string>) => [...items].map(([name, type]) => `readonly ${quote(name)}: ${type};`).join('\n');
  const root = `${order.map(node => `import { ${node.javascript?'createRuntime':'create'} as __create${node.id} } from "./modules/m${node.id}";`).join('\n')}
${rootTypes.join('\n')}
${hasCommonJs ? 'import {commonJs as __commonJs, esm as __esm} from "./module-records";' : ''}
export interface Dependencies {
${hostFields.size ? `readonly host: { ${fields(hostFields)} };` : ''}
${globalFields.size ? `readonly globals: { ${fields(globalFields)} };` : ''}
${platformFields.size ? `readonly bindings: { ${[...platformFields].map(([module, values]) => `readonly ${quote(module)}: { ${fields(values)} };`).join('\n')} };` : ''}
}
export function create(__context: Dependencies) {
${defineChecks.join('\n')}
${hasCommonJs ? `  const __createCommonJsExports = () => ${options.data?.records ? `__context.globals[${quote(options.data.records.name)}].adopt({},[])` : '({})'};\n${loaderDeclarations.join('\n')}\n  const __entry = __load${entry.id}();` : calls.join('\n')}
  return { ${options.exports.map(name => `${quote(name)}: ${hasCommonJs ? '__entry' : `__m${entry.id}`}[${quote(name)}]`).join(', ')} };
}
`;
  const robloxTypes=options.platform==='roblox'?[{filename:'roblox-globals.d.ts',source:`import type * as __Browser from "@3xjn/roblox-css-react/src/BrowserHost";
declare global {
  type Event = __Browser.Event; type UIEvent = __Browser.UIEvent; type MouseEvent = __Browser.MouseEvent; type PointerEvent = __Browser.PointerEvent;
  type TouchEvent = __Browser.TouchEvent; type KeyboardEvent = __Browser.KeyboardEvent; type FocusEvent = __Browser.FocusEvent;
  type InputEvent = __Browser.InputEvent; type ClipboardEvent = __Browser.ClipboardEvent; type WheelEvent = __Browser.WheelEvent;
  type EventTarget = __Browser.EventTarget; type AbortSignal = __Browser.AbortSignal; type Window = __Browser.Window; type Document = __Browser.Document;
  type Node = __Browser.Node; type Element = __Browser.Element; type HTMLElement = __Browser.HTMLElement; type Text = __Browser.Text;
  type CSSStyleDeclaration = __Browser.CSSStyleDeclaration; type VisualViewport = __Browser.VisualViewport;
  type HTMLElementTagNameMap = __Browser.HTMLElementTagNameMap; type SVGElementTagNameMap = __Browser.SVGElementTagNameMap;
  type SVGElement = __Browser.SVGElement; type SVGSVGElement = __Browser.SVGSVGElement;
  type AddEventListenerOptions = __Browser.AddEventListenerOptions; type EventListenerOrEventListenerObject = __Browser.EventListenerOrEventListenerObject;
  type GetAnimationsOptions = unknown; type WithBaseUIEvent<T> = T;
}
export {};`}] : [];
  return { ...result(), files: [{ filename: 'index.ts', source: root }, ...files, ...robloxTypes,
    ...(hasCommonJs ? [{filename:'module-records.ts',source:`${recordImports.join('\n')}\n${moduleRecordsSource()}\n${recordTypes.join('\n')}`}] : []), ...declarationBundle.files.values()] };
}

/** Keep diagnostics on original source spans when import/re-export syntax is linked. */
function link(source: ts.SourceFile, edits: readonly Edit[]) {
  let text = '', cursor = 0;
  const spans: { start: number; end: number; original: number; replaced: boolean }[] = [];
  const append = (value: string, original: number, replaced: boolean) => {
    spans.push({ start: text.length, end: text.length + value.length, original, replaced }); text += value;
  };
  for (const edit of [...edits].sort((a, b) => a.start - b.start)) {
    append(source.text.slice(cursor, edit.start), cursor, false);
    append(edit.text, edit.start, true); cursor = edit.end;
  }
  append(source.text.slice(cursor), cursor, false);
  return { text, source: ts.createSourceFile(source.fileName, text, ts.ScriptTarget.Latest, true, source.languageVariant === ts.LanguageVariant.JSX ? ts.ScriptKind.TSX : ts.ScriptKind.TS),
    original(offset: number) { const span = spans.find(span => offset >= span.start && offset < span.end); return span ? span.original + (span.replaced ? 0 : offset - span.start) : source.text.length; } };
}
function factoryContract(text: string): { name: string; keys: string[] } | undefined {
  const source = ts.createSourceFile('compiled.ts', text, ts.ScriptTarget.Latest, true);
  let name: string | undefined;
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && (statement.name?.text === 'create'||statement.name?.text==='createRuntime')
      && statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) name = 'create';
    if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      const item = statement.exportClause.elements.find(item => item.name.text === 'create'||item.name.text==='createRuntime');
      if (item) name = (item.propertyName ?? item.name).text;
    }
  }
  const fn = source.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name);
  const type = fn?.parameters[0]?.type;
  if (!name || !type || !ts.isTypeReferenceNode(type) || !ts.isIdentifier(type.typeName)) return undefined;
  const identifier = type.typeName.text;
  const shape = source.statements.find((node): node is ts.InterfaceDeclaration => ts.isInterfaceDeclaration(node) && node.name.text === identifier);
  if (!shape) return undefined;
  const keys = shape.members.map(member => member.name && (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name)) ? member.name.text : undefined);
  return keys.every((key): key is string => key !== undefined) && new Set(keys).size === keys.length ? { name, keys } : undefined;
}









