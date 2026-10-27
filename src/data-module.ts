import crypto from 'node:crypto';
import ts from 'typescript';
import {unreachableFunctions} from './function-reachability.ts';
import { privateFunctionExpression } from './function-forms.ts';
import { scalarString } from './string-methods.ts';
import { sourceIteratorMethod } from './data-iteration.ts';
import { transformDataRecords } from './data-records.ts';
import {createSourceValues,type SourceValueOptions} from './source-values.ts';
import {implicitArgumentsOwner} from './data-arguments.ts';
import { sourceProgram, type TypeSource, type SourceResolution } from './source-program.ts';
import { propertyKeyStringCall } from './data-property-key.ts';
import { initializedProperty } from './data-initialization.ts';
import {typeOnlyNamespace} from './preserve-types.ts';
import { createIdentifierHygiene } from './data-identifiers.ts';
import { createClassCollisionLowering } from './class-collisions.ts';
import {moduleBindingStability} from './module-stability.ts';
import {createTypeProjection} from './helper-types.ts';
import {trustedJavaScriptReturns} from './javascript-contracts.ts';
import type {JavaScriptContract} from './javascript-types.ts';
import type { Diagnostic, GlobalBinding, ValueTypeBinding } from './index.ts';
export type { TypeSource } from './source-program.ts';

export interface DataImportBinding {
  readonly module: string;
  readonly name: string;
  readonly valueType: ValueTypeBinding;
}
export interface DataTypeBinding {
  /** Omit module for a source global type. */
  readonly module?: string;
  /** Replace a source-owned alias/interface rather than a global or import. */
  readonly local?: boolean;
  readonly name: string;
  readonly target: { readonly module: string; readonly name: string };
  /** A native method returning roblox-ts's next/done/value Generator ABI. */
  readonly iteratorMethod?: string;
  /** Read-only source properties implemented by zero-argument native methods. */
  readonly getters?: Readonly<Record<string, string>>;
}
export interface DataModuleOptions extends SourceValueOptions {
  readonly filename: string;
  readonly bindings: readonly DataImportBinding[];
  readonly types?: readonly DataTypeBinding[];
  readonly globals?: readonly GlobalBinding[];
  /** Explicit additional implementation/declaration files for source type proofs. */
  readonly typeSources?: readonly TypeSource[];
  readonly sourceResolution?: SourceResolution;
  /** Primitive property-key .toString() calls; the provider owns key formatting. */
  readonly propertyKeyString?: Pick<GlobalBinding, 'name' | 'valueType'>;
  /** Native predicate for source typeof comparisons; retains control-flow narrowing. */
  readonly typeIs?: Pick<GlobalBinding, 'name' | 'valueType'>;
  /** Native classification for standalone source typeof queries. */
  readonly typeOf?: Pick<GlobalBinding, 'name' | 'valueType'>;
  /** Treat explicitly any-typed function results as unknown at the native boundary. */
  readonly unknownReturns?: boolean;
  /** Keep explicit any assertions opaque until source code narrows them. */
  readonly unknownAssertions?: boolean;
}
export interface DataModuleResult {
  readonly trustedJavaScriptContracts: readonly JavaScriptContract[];
  readonly source?: string;
  readonly diagnostics: readonly Diagnostic[];
  readonly sourceSha256: string;
  readonly exports: readonly string[];
  readonly dependencies: readonly string[];
  readonly objectFunctions: number;
  readonly iterations: number;
  readonly propertyCalls: number;
  readonly keyTraversals: number;
  readonly recordLiterals: number;
  readonly recordRests: number;
  readonly arrayLiterals: number;
  readonly arrayOperations: number;
  readonly restFunctions: number;
  readonly callSpreads: number;
  readonly forwardFunctions: number;
  readonly propertyKeyStrings: number;
  readonly initializedProperties: number;
  readonly typeQueries: number;
  readonly unknownReturns: number;
  readonly unknownAssertions: number;
  readonly hoistedFunctions: number;
  readonly functionValues: {
    readonly names: number;
    readonly properties: number;
    readonly calls: number;
    readonly callableParameters: number;
    readonly checkedFields: number;
  };
  readonly nativePragmas: readonly string[];
  readonly renamedIdentifiers: number;
  readonly classCollisions: { readonly classes: number; readonly methods: number };
  readonly nulls: {
    readonly values: number;
    readonly types: number;
    readonly operations: number;
  };
  readonly typeSources: readonly {
    readonly filename: string;
    readonly sha256: string;
  }[];
}

/** Retain TypeScript's data signatures and module initialization; roblox-ts
 * owns the actual language lowering. This does not compile JSX or a DOM. */
export function compileDataModule(
  text: string,
  options: DataModuleOptions,
): DataModuleResult {
  const filename = options.filename.replaceAll('\\', '/');
  const nativePragmas = (ts.getLeadingCommentRanges(text, 0) ?? [])
    .map((range) => text.slice(range.pos, range.end))
    .filter((comment) => comment.startsWith('//!'));
  const { source, program, references, duplicates, inputs, pairingDiagnostics, originalPosition, trustedJavaScriptContracts, trustedPublicFunction, standardLibraryFile } = sourceProgram(
    text,
    filename,
    !!options.arrays ||
      !!options.nulls ||
      !!options.numberStrings ||
      !!options.strings ||
      !!options.objectMethods ||
      !!options.typeSources?.length ||
      !!options.propertyKeyString,
    options.typeSources,
    options.sourceResolution,
  );
  const checker = program.getTypeChecker();
  const canonicalSource=(name:string)=>{
    const absolute=ts.sys.resolvePath(name).replaceAll('\\','/');return ts.sys.useCaseSensitiveFileNames?absolute:absolute.toLowerCase();
  };
  const declarationCompanions=new Map(Object.entries(options.sourceResolution?.declarationFiles??{})
    .map(([runtime,declaration])=>[canonicalSource(runtime),canonicalSource(declaration)]));
  const unusedFunctions=unreachableFunctions(source,checker);
  const sourceGlobal = (symbol: ts.Symbol | undefined) =>
    !symbol?.declarations?.some((d) => {
      const file = d.getSourceFile();
      if (program.isSourceFileDefaultLibrary(file)) return false;
      if (file === source) return true;
      for (
        let parent: ts.Node | undefined = d.parent;
        parent;
        parent = parent.parent
      )
        if (
          ts.isModuleDeclaration(parent) &&
          parent.flags & ts.NodeFlags.GlobalAugmentation
        )
          return false;
      return ts.isExternalModule(file);
    });
  const diagnostics: Diagnostic[] = [...pairingDiagnostics];
  const report = (node: ts.Node, code: string, message: string) => {
    const p = originalPosition(node.getStart(source));
    diagnostics.push({
      code,
      message,
      line: p.line + 1,
      column: p.character + 1,
    });
  };
  for (const name of duplicates)
    report(source, 'module-type-source', `Duplicate type source: ${name}`);
  for (const { source: input, filename: inputFilename } of inputs)
    for (const diagnostic of program.getSyntacticDiagnostics(input)) {
      const p = input.getLineAndCharacterOfPosition(diagnostic.start ?? 0);
      diagnostics.push({
        code: 'syntax',
        message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
        line: p.line + 1,
        column: p.character + 1,
        ...(input === source ? {} : { filename: inputFilename }),
      });
    }
  const identifiers = new Set<string>();
  function names(node: ts.Node) {
    if (ts.isIdentifier(node)) identifiers.add(node.text);
    ts.forEachChild(node, names);
  }
  names(source);
  function fresh(base: string) {
    let name = base;
    for (let i = 1; identifiers.has(name); i++) name = base + i;
    identifiers.add(name);
    return name;
  }
  const hygiene = createIdentifierHygiene(source, checker, fresh);
  const context = fresh('__moduleDependencies');
  const dependenciesName = fresh('__ModuleDependencies');
  const factoryName = fresh('__createModule');
  const moduleContextName = fresh('__ModuleContext');
  let needsModuleContext = false;
  const runtime = new Map<
    string,
    {
      type: ValueTypeBinding;
      node: ts.Node;
      members?: readonly string[];
      emitLocal: boolean;
      localName: string;
    }
  >();
  const keyHelpers = new Map<string, string>();
  const globalReferences = new Map<ts.Identifier, string>();
  const typeImports = new Map<
    string,
    { module: string; name: string; alias: string }
  >();
  const sourceTypes = new Map<ts.Symbol, string>();
  const iteratorMethods = new Map<ts.Symbol, string>();
  const getterMethods = new Map<
    ts.Symbol,
    NonNullable<DataTypeBinding['getters']>
  >();
  const globalTypes = new Map(
    (options.types ?? [])
      .filter((t) => t.module === undefined && !t.local)
      .map((t) => [t.name, t]),
  );
  const localTypes = new Map(
    (options.types ?? []).filter((t) => t.local).map((t) => [t.name, t]),
  );
  const valueImports = new Map<ts.Symbol, string>();
  const importedTypes = new Map<ts.Symbol, { module: string; name: string }>();
  const projectedTypeImports = new Set<ts.Symbol>();
  const suppliedDeclarations = new Set(inputs.map(input=>input.source).filter(file=>file.isDeclarationFile&&!program.isSourceFileDefaultLibrary(file)));
  const trustedDeclaration = (file:ts.SourceFile)=>suppliedDeclarations.has(file);
  const globals = new Map<string, GlobalBinding>();
  for (const value of options.globals ?? []) {
    if (globals.has(value.name))
      report(source, 'module-binding', `Duplicate global: ${value.name}`);
    globals.set(value.name, value);
  }
  const publicValues = new Map<string, string>();
  const localValues = new Set<ts.Symbol>();
  const classes = new Map<ts.Symbol, ts.ClassDeclaration>();
  const values: ts.Statement[] = [];
  const types: ts.Statement[] = [];
  const identifier = (value: string) =>
    /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value);
  function external(target: { module: string; name: string }) {
    const key = JSON.stringify([target.module, target.name]);
    let entry = typeImports.get(key);
    if (!entry) {
      entry = { ...target, alias: fresh('__ModuleType') };
      typeImports.set(key, entry);
    }
    return entry.alias;
  }
  function dependency(
    name: string,
    type: ValueTypeBinding,
    node: ts.Node,
    members?: readonly string[],
    helperOnly = false,
    localName = name,
  ) {
    if (
      !identifier(name) ||
      !type?.module ||
      !(identifier(type.name) || (type.name === '*' && type.typeOf)) ||
      (type.member !== undefined && typeof type.member !== 'string')
    ) {
      report(
        node,
        'module-binding',
        'Dependencies require an identifier and a checked external type.',
      );
      return;
    }
    const old = runtime.get(name);
    if (
      members &&
      (!members.length || new Set(members).size !== members.length)
    )
      report(node, 'module-binding', 'Namespace members require unique names.');
    if (
      old &&
      (JSON.stringify(old.type) !== JSON.stringify(type) ||
        JSON.stringify(old.members) !== JSON.stringify(members))
    )
      report(node, 'module-binding', `Conflicting dependency: ${name}`);
    else
      runtime.set(name, {
        type,
        node,
        emitLocal: old?.emitLocal === true || !helperOnly,
        localName: old?.localName ?? localName,
        ...(members ? { members } : {}),
      });
  }
  const typeBindings = new Map<string, DataTypeBinding>();
  const nativeTypeBinding=(module:string,name:string)=>typeBindings.get(JSON.stringify([module,name,false]))
    ??typeBindings.get(JSON.stringify([module,'*',false]));
  const nativeTypeTarget=(binding:DataTypeBinding,member:string)=>binding.name==='*'&&member!=='*'
    ?{module:binding.target.module,name:member}:binding.target;
  for (const binding of options.types ?? []) {
    const key = JSON.stringify([
      binding.module ?? '',
      binding.name,
      binding.local === true,
    ]);
    if (typeBindings.has(key))
      report(
        source,
        'module-type-binding',
        `Duplicate source type: ${binding.name}`,
      );
    if (
      !binding.target.module ||
      !(identifier(binding.target.name) || binding.target.name === '*')
    )
      report(
        source,
        'module-type-binding',
        'Types require a named target export or a namespace.',
      );
    typeBindings.set(key, binding);
    if (binding.local && binding.module !== undefined)
      report(
        source,
        'module-type-binding',
        'A local type binding cannot also name an imported module.',
      );
    if (
      binding.iteratorMethod !== undefined &&
      !identifier(binding.iteratorMethod)
    )
      report(
        source,
        'module-iterator-binding',
        'An iterator method requires a native identifier.',
      );
    for (const [property, method] of Object.entries(binding.getters ?? {}))
      if (!property || !identifier(method))
        report(
          source,
          'module-getter-binding',
          'Native property reads require a nonempty source property and a native method identifier.',
        );
  }
  const bindings = new Map<string, DataImportBinding>();
  for (const binding of options.bindings) {
    const key = JSON.stringify([binding.module, binding.name]);
    if (bindings.has(key))
      report(
        source,
        'module-binding',
        `Duplicate source import: ${binding.module}#${binding.name}`,
      );
    bindings.set(key, binding);
  }
  function importName(
    name: ts.Identifier,
    module: string,
    imported: string,
    typeOnly: boolean,
  ) {
    const symbol = checker.getSymbolAtLocation(name);
    if (!symbol) return;
    importedTypes.set(symbol, { module, name: imported });
    const type = nativeTypeBinding(module,imported);
    if (type) sourceTypes.set(symbol, external(nativeTypeTarget(type,imported)));
    if (type?.iteratorMethod) iteratorMethods.set(symbol, type.iteratorMethod);
    if (type?.getters) getterMethods.set(symbol, type.getters);
    if (typeOnly) {
      if(!type&&options.sourceResolution?.typedJavaScript){
        const target=symbol.flags&ts.SymbolFlags.Alias?checker.getAliasedSymbol(symbol):symbol;
        if(target.declarations?.length&&target.declarations.every(declaration=>trustedDeclaration(declaration.getSourceFile()))){
          projectedTypeImports.add(symbol);
          return;
        }
      }
      if (!type)
        report(
          name,
          'module-type-binding',
          `Missing native type for ${module}#${imported}.`,
        );
      return;
    }
    const binding = bindings.get(JSON.stringify([module, imported]));
    if (!binding) {
      report(
        name,
        'module-binding',
        `Missing native value for ${module}#${imported}.`,
      );
      return;
    }
    dependency(name.text, binding.valueType, name);
    valueImports.set(symbol, name.text);
  }
  function exported(node: ts.Node) {
    return (
      ts.canHaveModifiers(node) &&
      ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    );
  }
  function ordinary<T extends ts.Statement>(statement: T): T {
    if (!ts.canHaveModifiers(statement)) return statement;
    return ts.factory.replaceModifiers(
      statement,
      ts
        .getModifiers(statement)
        ?.filter(
          (m) =>
            m.kind !== ts.SyntaxKind.ExportKeyword &&
            m.kind !== ts.SyntaxKind.DefaultKeyword,
        ),
    ) as T;
  }
  const stability=moduleBindingStability(source,checker);
  const deferredBinding=(symbol:ts.Symbol|undefined)=>!symbol||!stability.stable(symbol);
  function addExport(name: string, local: string, node: ts.Node) {
    const symbol = ts.isExportSpecifier(node)?checker.getExportSpecifierLocalTargetSymbol(node)
      :checker.resolveName(local,node,ts.SymbolFlags.Value|ts.SymbolFlags.Alias,false);
    if(symbol&&deferredBinding(symbol))
      report(
        node,
        'module-live-export',
        'Mutable aliases require live-binding support; a snapshot would change module semantics.',
      );
    if (publicValues.has(name))
      report(node, 'module-export', `Duplicate runtime export: ${name}`);
    else publicValues.set(name, local);
  }
  function typeOnlyExport(
    statement: ts.ExportDeclaration,
    entry: ts.ExportSpecifier,
    symbol: ts.Symbol | undefined,
  ): boolean {
    if (statement.isTypeOnly || entry.isTypeOnly) return true;
    if (!symbol) return false;
    if (!(symbol.flags & (ts.SymbolFlags.Value | ts.SymbolFlags.Alias)))
      return true;
    return !!symbol.declarations?.some((declaration) =>
      ts.isImportClause(declaration)
        ? declaration.isTypeOnly
        : ts.isImportSpecifier(declaration)
          ? declaration.isTypeOnly || declaration.parent.parent.isTypeOnly
          : ts.isNamespaceImport(declaration) && declaration.parent.isTypeOnly,
    );
  }
  for (const statement of source.statements) {
    if(ts.isFunctionDeclaration(statement)&&unusedFunctions.has(statement))continue;
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      const module = statement.moduleSpecifier.text,
        clause = statement.importClause;
      if (!clause) {
        report(
          statement,
          'module-side-effect-import',
          'Side-effect imports need an explicit bootstrap owner.',
        );
        continue;
      }
      if (clause.name)
        importName(clause.name, module, 'default', clause.isTypeOnly);
      if (clause.namedBindings) {
        if (ts.isNamespaceImport(clause.namedBindings))
          importName(clause.namedBindings.name, module, '*', clause.isTypeOnly);
        else
          for (const entry of clause.namedBindings.elements)
            importName(
              entry.name,
              module,
              (entry.propertyName ?? entry.name).text,
              clause.isTypeOnly || entry.isTypeOnly,
            );
      }
    } else if (
      ts.isInterfaceDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement)
    ) {
      const binding = localTypes.get(statement.name.text);
      if (binding) {
        const symbol = checker.getSymbolAtLocation(statement.name);
        if (symbol) {
          sourceTypes.set(symbol, external(binding.target));
          if (binding.getters) getterMethods.set(symbol, binding.getters);
        }
      }
      types.push(statement);
    } else if (
      ts.isFunctionDeclaration(statement) ||
      ts.isVariableStatement(statement)
    ) {
      if (ts.isFunctionDeclaration(statement)) {
        if (!statement.body) {
          const symbol =
            statement.name && checker.getSymbolAtLocation(statement.name);
          const implementation = symbol?.declarations?.some(
            (declaration) =>
              ts.isFunctionDeclaration(declaration) &&
              declaration.body &&
              declaration.getSourceFile() === source,
          );
          const ambient = statement.modifiers?.some(
            (modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword,
          );
          if (implementation && !ambient) {
            values.push(ordinary(statement));
            continue;
          }
          report(
            statement,
            'module-ambient',
            'Ambient functions need a native dependency binding.',
          );
          continue;
        }
        if (!statement.name) {
          report(
            statement,
            'module-export',
            'Anonymous/default functions need a named source declaration.',
          );
          continue;
        }
        const symbol = checker.getSymbolAtLocation(statement.name);
        if (symbol) localValues.add(symbol);
        if (exported(statement))
          addExport(
            statement.modifiers?.some(
              (m) => m.kind === ts.SyntaxKind.DefaultKeyword,
            )
              ? 'default'
              : statement.name.text,
            statement.name.text,
            statement,
          );
      } else {
        if (
          statement.modifiers?.some(
            (m) => m.kind === ts.SyntaxKind.DeclareKeyword,
          )
        ) {
          report(
            statement,
            'module-ambient',
            'Ambient values need a native dependency binding.',
          );
          continue;
        }
        for (const declaration of statement.declarationList.declarations) {
          const names = (name: ts.BindingName): readonly ts.Identifier[] => ts.isIdentifier(name) ? [name]
            : name.elements.flatMap(element => ts.isOmittedExpression(element) ? [] : names(element.name));
          for (const name of names(declaration.name)) {
            const symbol = checker.getSymbolAtLocation(name);
            if (symbol) localValues.add(symbol);
            if (exported(statement)) {
              if (!(statement.declarationList.flags & ts.NodeFlags.Const)&&deferredBinding(symbol))
                report(declaration, 'module-live-export', 'Mutable exports require live-binding support; a snapshot would change module semantics.');
              addExport(name.text, name.text, declaration);
            }
          }
        }
      }
      values.push(ordinary(statement));
    } else if (ts.isClassDeclaration(statement)) {
      if (
        !statement.name ||
        statement.modifiers?.some(
          (m) => m.kind === ts.SyntaxKind.DeclareKeyword,
        )
      ) {
        report(
          statement,
          'module-class',
          'Classes require a named runtime declaration.',
        );
        continue;
      }
      const symbol = checker.getSymbolAtLocation(statement.name);
      if (symbol) {
        localValues.add(symbol);
        classes.set(symbol, statement);
        if (symbol.declarations?.some((d) => ts.isInterfaceDeclaration(d))) {
          report(
            statement,
            'module-class-merge',
            'Merged class/interface declarations need a shared native type owner.',
          );
        }
      }
      if (exported(statement))
        addExport(
          statement.modifiers?.some(
            (m) => m.kind === ts.SyntaxKind.DefaultKeyword,
          )
            ? 'default'
            : statement.name.text,
          statement.name.text,
          statement,
        );
      values.push(ordinary(statement));
    } else if (ts.isExportDeclaration(statement)) {
      if (
        statement.moduleSpecifier ||
        !statement.exportClause ||
        !ts.isNamedExports(statement.exportClause)
      ) {
        report(
          statement,
          'module-reexport',
          'External/star re-exports require a linked module graph.',
        );
        continue;
      }
      let hasTypes = statement.isTypeOnly;
      for (const entry of statement.exportClause.elements) {
        const symbol = checker.getExportSpecifierLocalTargetSymbol(entry);
        const isType = typeOnlyExport(statement, entry, symbol);
        if (isType) {
          hasTypes = true;
          continue;
        }
        if (!symbol) {
          report(
            entry,
            'module-export',
            'A runtime export must refer to a source value.',
          );
          continue;
        }
        addExport(
          entry.name.text,
          (entry.propertyName ?? entry.name).text,
          entry,
        );
      }
      if (hasTypes) types.push(statement);
    } else if (typeOnlyNamespace(statement)) {
      types.push(statement);
    } else if (
      ts.isEnumDeclaration(statement) ||
      ts.isModuleDeclaration(statement) ||
      ts.isExportAssignment(statement) ||
      ts.isImportEqualsDeclaration(statement) ||
      ts.isReturnStatement(statement)
    ) {
      report(
        statement,
        'module-declaration',
        'This declaration needs linked value/type ownership; functions, constants and source data types are supported here.',
      );
    } else values.push(statement);
  }
  for (const binding of localTypes.values())
    if (
      !source.statements.some(
        (s) =>
          (ts.isTypeAliasDeclaration(s) || ts.isInterfaceDeclaration(s)) &&
          s.name.text === binding.name,
      )
    )
      report(
        source,
        'module-type-binding',
        `Missing local alias/interface: ${binding.name}.`,
      );
  function runtimeReference(node: ts.Identifier) {
    const p = node.parent;
    if (
      ((ts.isVariableDeclaration(p) ||
        ts.isFunctionDeclaration(p) ||
        ts.isFunctionExpression(p) ||
        ts.isClassDeclaration(p) ||
        ts.isClassExpression(p) ||
        ts.isParameter(p) ||
        ts.isBindingElement(p) ||
        ts.isMethodDeclaration(p) ||
        ts.isGetAccessorDeclaration(p) ||
        ts.isSetAccessorDeclaration(p) ||
        ts.isPropertyDeclaration(p)) &&
        p.name === node) ||
      (ts.isPropertyAccessExpression(p) && p.name === node) ||
      (ts.isPropertyAssignment(p) && p.name === node) ||
      (ts.isBindingElement(p) && p.propertyName === node) ||
      ts.isLabeledStatement(p) ||
      ts.isBreakOrContinueStatement(p)
    )
      return;
    const symbol = (ts.isShorthandPropertyAssignment(p)
      ? checker.getShorthandAssignmentValueSymbol(p)
      : checker.getSymbolAtLocation(node))
      ?? checker.resolveName(node.text,node,ts.SymbolFlags.Value|ts.SymbolFlags.Type|ts.SymbolFlags.Alias,false);
    const declaration = symbol?.valueDeclaration;
    if (
      (symbol && valueImports.has(symbol)) ||
      declaration?.getSourceFile() === source
    )
      return;
    if (node.text === 'undefined') return;
    if (options.arrays && implicitArgumentsOwner(node, checker)) return;
    const global = globals.get(node.text);
    if (global) {
      const localName =
        runtime.get(global.name)?.localName ?? fresh('__global' + global.name);
      dependency(
        global.name,
        global.valueType,
        node,
        global.members,
        false,
        localName,
      );
      globalReferences.set(node, localName);
      if (
        global.members &&
        ts.isPropertyAccessExpression(p) &&
        p.expression === node &&
        !global.members.includes(p.name.text)
      )
        report(
          p,
          'module-member',
          `Missing native member ${global.name}.${p.name.text}.`,
        );
      if (
        global.members &&
        ts.isElementAccessExpression(p) &&
        p.expression === node &&
        (!ts.isStringLiteral(p.argumentExpression) ||
          !global.members.includes(p.argumentExpression.text))
      )
        report(
          p,
          'module-member',
          `Computed native lookup in ${global.name} requires a declared literal member.`,
        );
    } else report(node, 'module-global', `No native binding for ${node.text}.`);
  }
  function scan(node: ts.Node) {
    if(ts.isFunctionDeclaration(node)&&unusedFunctions.has(node))return;
    if (
      ts.isTypeNode(node) ||
      ts.isTypeParameterDeclaration(node) ||
      ts.isImportDeclaration(node) ||
      ts.isExportDeclaration(node) ||
      ts.isInterfaceDeclaration(node) ||
      ts.isTypeAliasDeclaration(node)
    )
      return;
    if (
      ts.isJsxElement(node) ||
      ts.isJsxSelfClosingElement(node) ||
      ts.isJsxFragment(node)
    )
      report(node, 'module-jsx', 'Compile JSX through the component compiler.');
    if (node.kind === ts.SyntaxKind.ThisKeyword) {
      let parent = node.parent;
      while (
        parent &&
        parent !== source &&
        !(ts.isFunctionLike(parent) && !ts.isArrowFunction(parent)) &&
        !ts.isClassLike(parent)
      )
        parent = parent.parent;
      if (parent === source)
        report(
          node,
          'module-this',
          'Top-level this needs a native module environment.',
        );
    }
    if (ts.isAwaitExpression(node)) {
      let parent = node.parent;
      while (parent && !ts.isFunctionLike(parent) && parent !== source)
        parent = parent.parent;
      if (parent === source)
        report(
          node,
          'module-async-initializer',
          'Top-level await requires an asynchronous module owner.',
        );
    }
    if (node.kind === ts.SyntaxKind.NullKeyword && !options.nulls)
      report(
        node,
        'null-value',
        'Data null needs a distinct native representation.',
      );
    if (
      (ts.isStringLiteralLike(node) ||
        ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node) ||
        ts.isTemplateTail(node)) &&
      !scalarString(node.text)
    )
      report(
        node,
        'unicode-string',
        'Native strings require Unicode scalar values.',
      );
    if (ts.isIdentifier(node)) runtimeReference(node);
    ts.forEachChild(node, scan);
  }
  for (const statement of source.statements) scan(statement);
  const f = ts.factory;
  function nativeType(type: ValueTypeBinding): ts.TypeNode {
    const alias = f.createIdentifier(external(type));
    let node: ts.TypeNode = type.typeOf
      ? f.createTypeQueryNode(alias)
      : f.createTypeReferenceNode(alias);
    if (type.member !== undefined)
      node = f.createIndexedAccessTypeNode(
        node,
        f.createLiteralTypeNode(f.createStringLiteral(type.member)),
      );
    return node;
  }
  function rootName(name: ts.EntityName): ts.Identifier {
    return ts.isIdentifier(name) ? name : rootName(name.left);
  }
  const constructorViews=new Map<string,{name:string;type:ts.TypeNode}>();
  const constructorIdentities=new Map<ts.Symbol,ts.Identifier|undefined>();
  const aliased=(symbol:ts.Symbol)=>symbol.flags&ts.SymbolFlags.Alias?checker.getAliasedSymbol(symbol):symbol;
  function sameClass(left:ts.Symbol,right:ts.Symbol):boolean {
    if(left===right)return true;
    const a=left.declarations?.find(ts.isClassDeclaration),b=right.declarations?.find(ts.isClassDeclaration);
    if(!a||!b)return false;
    const aFile=a.getSourceFile(),bFile=b.getSourceFile(),aPath=canonicalSource(aFile.fileName),bPath=canonicalSource(bFile.fileName);
    if(declarationCompanions.get(aPath)!==bPath&&declarationCompanions.get(bPath)!==aPath)return false;
    const exports=(file:ts.SourceFile,symbol:ts.Symbol)=>{
      const module=checker.getSymbolAtLocation(file);
      return module?checker.getExportsOfModule(module).filter(value=>aliased(value)===symbol).map(value=>value.name):[];
    };
    const names=new Set(exports(aFile,left));return exports(bFile,right).some(name=>names.has(name));
  }
  function constructorView(name:ts.EntityName):ts.Identifier|undefined {
    const reference=checker.getSymbolAtLocation(name),target=reference&&aliased(reference);
    if(!target?.declarations?.some(ts.isClassDeclaration))return undefined;
    if(constructorIdentities.has(target))return constructorIdentities.get(target);
    for(const [symbol,dependencyName]of valueImports){
      const metadata=importedTypes.get(symbol);if(!metadata)continue;
      const imported=aliased(symbol);
      const candidates=metadata.name==='*'?checker.getExportsOfModule(imported).map(value=>({target:aliased(value),members:[value.name]}))
        :[{target:imported,members:[]}];
      for(const candidate of candidates){
        if(!sameClass(target,candidate.target))continue;
        const key=JSON.stringify([dependencyName,...candidate.members]);
        let view=constructorViews.get(key);
        if(!view){
          let type:ts.TypeNode=f.createIndexedAccessTypeNode(f.createTypeReferenceNode(dependenciesName),f.createLiteralTypeNode(f.createStringLiteral(dependencyName)));
          for(const member of candidate.members)type=f.createIndexedAccessTypeNode(type,f.createLiteralTypeNode(f.createStringLiteral(member)));
          view={name:fresh('__ModuleConstructor'),type};constructorViews.set(key,view);
        }
        const result=f.createIdentifier(view.name);constructorIdentities.set(target,result);return result;
      }
    }
    constructorIdentities.set(target,undefined);return undefined;
  }
  function hasOwnThis(node: ts.Node): boolean {
    let found = false;
    function visit(current: ts.Node) {
      if (current.kind === ts.SyntaxKind.ThisKeyword) {
        found = true;
        return;
      }
      if (
        ts.isClassLike(current) ||
        (ts.isFunctionLike(current) && !ts.isArrowFunction(current))
      )
        return;
      if (!found) ts.forEachChild(current, visit);
    }
    ts.forEachChild(node, visit);
    return found;
  }
  let objectFunctions = 0;
  let iterations = 0;
  let propertyCalls = 0;
  let propertyKeyStrings = 0;
  let initializedProperties = 0;
  let typeQueries = 0;
  let unknownReturns = 0;
  let unknownAssertions = 0;
  let hoistedFunctions = 0;
  function hoistFunctions(
    statements: readonly ts.Statement[],
  ): readonly ts.Statement[] {
    let prologue = 0;
    const directive = (statement: ts.Statement | undefined) =>
      statement &&
      ts.isExpressionStatement(statement) &&
      ts.isStringLiteral(statement.expression);
    while (prologue < statements.length && directive(statements[prologue]))
      prologue++;
    const rest = statements.slice(prologue);
    const sourceDeclaration=(statement:ts.Statement)=>ts.isFunctionDeclaration(statement)
      ||ts.isVariableStatement(statement)&&ts.isFunctionDeclaration(ts.getOriginalNode(statement));
    let preceding = false;
    for (const statement of rest) {
      if (sourceDeclaration(statement)) {
        if (preceding) hoistedFunctions++;
      } else preceding = true;
    }
    return [
      ...statements.slice(0, prologue),
      ...rest.filter(sourceDeclaration),
      ...(functions?.registrations(rest) ?? []),
      ...rest.filter((s) => !sourceDeclaration(s)),
    ];
  }
  function helper(
    binding: Pick<GlobalBinding, 'name' | 'valueType'>,
    base: string,
    node: ts.Node,
  ) {
    dependency(binding.name, binding.valueType, node, undefined, true);
    let name = keyHelpers.get(binding.name);
    if (!name) {
      name = fresh(base);
      keyHelpers.set(binding.name, name);
    }
    return f.createIdentifier(name);
  }
  const {arrays,functions,nulls,keys,properties,numbers,classChecks,strings,reads}=createSourceValues(options,{checker,program,report,global:sourceGlobal,
    ...(options.sourceResolution?.sourceStrict!==undefined?{sourceStrict:options.sourceResolution.sourceStrict}:{}),
    dynamicSource:/\.[cm]?jsx?$/.test(filename)&&!!options.sourceResolution?.dynamicProperties,
    provider:(binding,base)=>helper(binding,base,source) as ts.Identifier,nativeType});
  function parameters(nodes: readonly ts.ParameterDeclaration[]) {
    return nodes.some((p) => ts.isIdentifier(p.name) && p.name.text === 'this')
      ? nodes
      : [
          f.createParameterDeclaration(
            undefined,
            undefined,
            'this',
            undefined,
            f.createKeywordTypeNode(ts.SyntaxKind.VoidKeyword),
          ),
          ...nodes,
        ];
  }
  const trustedReturn=trustedJavaScriptReturns(trustedPublicFunction);
  const transform = ts.transform(source, [
    (transformContext) => (root) => {
      const visit: ts.Visitor = (node) => {
        // JSDoc type-predicate returns can flow into an `as` assertion while
        // lowering JavaScript. A predicate is a signature, never an assertion
        // type; retain the boolean expression and let the annotated signature
        // provide control-flow narrowing.
        if(ts.isAsExpression(node)&&ts.isTypePredicateNode(node.type))
          return ts.visitNode(node.expression,visit) as ts.Expression;
        if(ts.isFunctionDeclaration(node)&&unusedFunctions.has(node))return node;
        const trusted=trustedReturn(node,visit);
        if(trusted)return trusted;
        const loweredNumber = numbers?.visit(node, visit);
        if (loweredNumber) return loweredNumber;
        const loweredClass = classChecks?.visit(node, visit);
        if (loweredClass) return loweredClass;
        const loweredString = strings?.visit(node, visit);
        if (loweredString) return loweredString;
        const loweredNull = nulls?.visit(node, visit);
        if (loweredNull) return loweredNull;
        if (ts.isBlock(node)) {
          const block = ts.visitEachChild(node, visit, transformContext);
          return f.updateBlock(block, hoistFunctions(block.statements));
        }
        const loweredFunction = functions?.visit(node, visit);
        if (loweredFunction) return loweredFunction;
        const loweredProperties=properties?.visit(node,visit);
        if(loweredProperties)return loweredProperties;
        const loweredRead=reads?.visit(node,visit);
        if(loweredRead)return loweredRead;
        const loweredKeys=keys?.visit(node,visit);
        if(loweredKeys)return loweredKeys;
        if (
          options.unknownAssertions &&
          (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) &&
          node.type.kind === ts.SyntaxKind.AnyKeyword
        ) {
          unknownAssertions++;
          return f.createAsExpression(
            ts.visitNode(node.expression, visit) as ts.Expression,
            f.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
          );
        }
        if (
          (ts.isTypeAliasDeclaration(node) ||
            ts.isInterfaceDeclaration(node)) &&
          node.parent === source &&
          localTypes.has(node.name.text)
        ) {
          const binding = localTypes.get(node.name.text)!;
          return f.createTypeAliasDeclaration(
            node.modifiers,
            node.name,
            node.typeParameters &&
              f.createNodeArray(
                node.typeParameters.map(
                  (p) => ts.visitNode(p, visit) as ts.TypeParameterDeclaration,
                ),
              ),
            f.createTypeReferenceNode(
              external(binding.target),
              node.typeParameters?.map((p) =>
                f.createTypeReferenceNode(p.name),
              ),
            ),
          );
        }
        if (
          ts.isShorthandPropertyAssignment(node) &&
          globalReferences.has(node.name)
        ) {
          return f.createPropertyAssignment(
            f.createStringLiteral(node.name.text),
            f.createIdentifier(globalReferences.get(node.name)!),
          );
        }
        if (ts.isIdentifier(node) && globalReferences.has(node))
          return f.createIdentifier(globalReferences.get(node)!);
        if (
          options.unknownReturns &&
          node.kind === ts.SyntaxKind.AnyKeyword &&
          ts.isFunctionLike(node.parent) &&
          node.parent.type === node
        ) {
          unknownReturns++;
          return f.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);
        }
        if (options.typeIs && ts.isBinaryExpression(node)) {
          const positive =
            node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
            node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsToken;
          const negative =
            node.operatorToken.kind ===
              ts.SyntaxKind.ExclamationEqualsEqualsToken ||
            node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsToken;
          const query =
            ts.isTypeOfExpression(node.left) && ts.isStringLiteral(node.right)
              ? { value: node.left.expression, kind: node.right }
              : ts.isTypeOfExpression(node.right) &&
                  ts.isStringLiteral(node.left)
                ? { value: node.right.expression, kind: node.left }
                : undefined;
          if (
            (positive || negative) &&
            query &&
            [
              'undefined',
              'function',
              'object',
              'string',
              'number',
              'boolean',
              'symbol',
              'bigint',
            ].includes(query.kind.text)
          ) {
            typeQueries++;
            const call = f.createCallExpression(
              helper(options.typeIs, '__typeIs', node),
              undefined,
              [ts.visitNode(query.value, visit) as ts.Expression, query.kind],
            );
            return negative
              ? f.createPrefixUnaryExpression(
                  ts.SyntaxKind.ExclamationToken,
                  call,
                )
              : call;
          }
        }
        if (options.typeOf && ts.isTypeOfExpression(node)) {
          typeQueries++;
          return f.createCallExpression(
            helper(options.typeOf, '__typeOf', node),
            undefined,
            [ts.visitNode(node.expression, visit) as ts.Expression],
          );
        }
        const initialized = initializedProperty(node);
        if (initialized) {
          initializedProperties++;
          return ts.visitEachChild(initialized, visit, transformContext);
        }
        const loweredArray = arrays?.visit(node, visit);
        if (loweredArray) return loweredArray;
        if (
          ts.isPropertyAccessExpression(node) ||
          (ts.isElementAccessExpression(node) &&
            ts.isStringLiteral(node.argumentExpression))
        ) {
          const property = ts.isPropertyAccessExpression(node)
            ? node.name.text
            : (node.argumentExpression as ts.StringLiteral).text;
          const method = sourceIteratorMethod(node.expression, {
            checker,
            binding: (symbol, name) =>
              sourceGlobal(symbol)
                ? globalTypes.get(name)?.getters?.[property]
                : symbol && getterMethods.get(symbol)?.[property],
          });
          if (method) {
            const parent = node.parent;
            const assignment =
              ts.isBinaryExpression(parent) &&
              parent.left === node &&
              parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
              parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment;
            if (
              node.questionDotToken ||
              assignment ||
              ts.isDeleteExpression(parent) ||
              (ts.isPrefixUnaryExpression(parent) &&
                (parent.operator === ts.SyntaxKind.PlusPlusToken ||
                  parent.operator === ts.SyntaxKind.MinusMinusToken)) ||
              ts.isPostfixUnaryExpression(parent) ||
              (ts.isCallExpression(parent) && parent.expression === node)
            ) {
              report(
                node,
                'module-getter-operation',
                'A mapped native getter supports ordinary reads, not optional access, writes, deletion, updates or invocation.',
              );
              return node;
            }
            propertyCalls++;
            return f.createCallExpression(
              f.createPropertyAccessExpression(
                ts.visitNode(node.expression, visit) as ts.Expression,
                method,
              ),
              undefined,
              [],
            );
          }
        }
        const keyString =
          options.propertyKeyString &&
          ts.isCallExpression(node) &&
          propertyKeyStringCall(node, checker, program);
        if (keyString) {
          if (keyString.optional || keyString.arguments) {
            report(
              node,
              'module-key-string',
              'Property-key formatting supports a non-optional, zero-argument toString call.',
            );
            return node;
          }
          const binding = options.propertyKeyString!;
          dependency(binding.name, binding.valueType, node, undefined, true);
          let helper = keyHelpers.get(binding.name);
          if (!helper) {
            helper = fresh('__keyString');
            keyHelpers.set(binding.name, helper);
          }
          propertyKeyStrings++;
          return f.createCallExpression(f.createIdentifier(helper), undefined, [
            ts.visitNode(keyString.receiver, visit) as ts.Expression,
          ]);
        }
        if (ts.isForOfStatement(node)) {
          const method = sourceIteratorMethod(node.expression, {
            checker,
            binding: (symbol, name) =>
              sourceGlobal(symbol)
                ? globalTypes.get(name)?.iteratorMethod
                : symbol && iteratorMethods.get(symbol),
          });
          if (method) {
            if (node.awaitModifier)
              report(
                node,
                'module-async-iteration',
                'This iterator contract supports synchronous traversal only.',
              );
            iterations++;
            return f.updateForOfStatement(
              node,
              node.awaitModifier,
              ts.visitNode(node.initializer, visit) as ts.ForInitializer,
              f.createCallExpression(
                f.createPropertyAccessExpression(
                  ts.visitNode(node.expression, visit) as ts.Expression,
                  method,
                ),
                undefined,
                [],
              ),
              ts.visitNode(node.statement, visit) as ts.Statement,
            );
          }
        }
        if (
          ts.isExportDeclaration(node) &&
          !node.moduleSpecifier &&
          node.exportClause &&
          ts.isNamedExports(node.exportClause)
        ) {
          const entries = node.exportClause.elements.flatMap((entry) => {
            const symbol = checker.getExportSpecifierLocalTargetSymbol(entry);
            const isType = typeOnlyExport(node, entry, symbol);
            if (!isType) return [];
            const alias = symbol && sourceTypes.get(symbol);
            return [
              f.updateExportSpecifier(
                entry,
                false,
                alias ? f.createIdentifier(alias) : entry.propertyName,
                ts.isStringLiteral(entry.name) && identifier(entry.name.text) ? f.createIdentifier(entry.name.text) : entry.name,
              ),
            ];
          });
          return f.updateExportDeclaration(
            node,
            node.modifiers,
            true,
            f.updateNamedExports(node.exportClause, entries),
            undefined,
            undefined,
          );
        }
        if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)
          && ts.isStringLiteral(node.argument.literal)) {
          const module = node.argument.literal.text;
          const parts = (name: ts.EntityName): string[] => ts.isIdentifier(name) ? [name.text] : [...parts(name.left), name.right.text];
          const members = node.qualifier ? parts(node.qualifier) : [];
          const exact = members[0] && typeBindings.get(JSON.stringify([module, members[0], false]));
          const binding = exact || typeBindings.get(JSON.stringify([module, '*', false]));
          if (binding) {
            let target: ts.EntityName = f.createIdentifier(external(binding.target));
            for (const member of members.slice(exact ? 1 : 0)) target = f.createQualifiedName(target, member);
            const arguments_ = node.typeArguments?.map(type => ts.visitNode(type, visit) as ts.TypeNode);
            return node.isTypeOf ? f.createTypeQueryNode(target, arguments_) : f.createTypeReferenceNode(target, arguments_);
          }
        }
        if (ts.isTypeReferenceNode(node)) {
          const root = rootName(node.typeName);
          const symbol = checker.getSymbolAtLocation(root);
          const imported = symbol && importedTypes.get(symbol);
          const constructor=!symbol||!sourceTypes.has(symbol)?constructorView(node.typeName):undefined;
          if(constructor)return f.createTypeReferenceNode('InstanceType',[f.createTypeQueryNode(constructor,
            node.typeArguments?.map(type=>ts.visitNode(type,visit)as ts.TypeNode))]);
          if(symbol&&projectedTypeImports.has(symbol)){
            const parameters:ts.TypeParameterDeclaration[]=[];
            for(let owner:ts.Node|undefined=node.parent;owner;owner=owner.parent){
              if(ts.isFunctionLike(owner)||ts.isTypeAliasDeclaration(owner)||ts.isInterfaceDeclaration(owner)||ts.isClassDeclaration(owner))
                parameters.push(...owner.typeParameters??[]);
            }
            try{return createTypeProjection(checker,parameters,undefined,trustedDeclaration,false,undefined,filename,standardLibraryFile).data(node);}
            catch(error){report(node,'module-type-projection',(error as Error).message);return node;}
          }
          const member = imported?.name === '*' && ts.isQualifiedName(node.typeName)
            && ts.isIdentifier(node.typeName.left)
            ? nativeTypeBinding(imported.module,node.typeName.right.text) : undefined;
          if (member) {
            const alias=external(member.target);
            const target=member.name==='*'&&ts.isQualifiedName(node.typeName)
              ?f.createQualifiedName(f.createIdentifier(alias),node.typeName.right.text):f.createIdentifier(alias);
            return f.createTypeReferenceNode(target,node.typeArguments?.map(type=>ts.visitNode(type,visit)as ts.TypeNode));
          }
          const alias = symbol && sourceTypes.get(symbol);
          const global = sourceGlobal(symbol)
            ? globalTypes.get(root.text)
            : undefined;
          function renamed(
            name: ts.EntityName,
            replacement: string,
          ): ts.EntityName {
            return ts.isIdentifier(name)
              ? f.createIdentifier(replacement)
              : f.updateQualifiedName(
                  name,
                  renamed(name.left, replacement),
                  name.right,
                );
          }
          if (alias || global)
            return f.updateTypeReferenceNode(
              node,
              renamed(node.typeName, alias ?? external(global!.target)),
              node.typeArguments &&
                f.createNodeArray(
                  node.typeArguments.map(
                    (a) => ts.visitNode(a, visit) as ts.TypeNode,
                  ),
                ),
            );
          if (symbol && importedTypes.has(symbol))
            report(
              node,
              'module-type-binding',
              `The imported type ${root.text} needs a native type binding.`,
            );
          return f.updateTypeReferenceNode(
            node,
            node.typeName,
            node.typeArguments &&
              f.createNodeArray(
                node.typeArguments.map(
                  (a) => ts.visitNode(a, visit) as ts.TypeNode,
                ),
              ),
          );
        }
        if (ts.isTypeQueryNode(node)) {
          if(node.typeArguments?.length){
            const constructor=constructorView(node.exprName);
            if(constructor)return f.createTypeQueryNode(constructor,node.typeArguments.map(type=>ts.visitNode(type,visit)as ts.TypeNode));
          }
          const root = rootName(node.exprName);
          const symbol = checker.getSymbolAtLocation(root);
          const global = sourceGlobal(symbol)
            ? globals.get(root.text)
            : undefined;
          const importedName = symbol ? valueImports.get(symbol) : undefined;
          const dependencyName =
            importedName ??
            (global && runtime.has(global.name) ? global.name : undefined);
          if (node.typeArguments?.length && (dependencyName || global))
            report(
              node,
              'module-type-query',
              'Instantiated dependency type queries need a linked native type export.',
            );
          let type = dependencyName
            ? f.createIndexedAccessTypeNode(
                f.createTypeReferenceNode(dependenciesName),
                f.createLiteralTypeNode(f.createStringLiteral(dependencyName)),
              )
            : global
              ? nativeType(global.valueType)
              : undefined;
          function members(
            name: ts.EntityName,
            base: ts.TypeNode,
          ): ts.TypeNode {
            return ts.isIdentifier(name)
              ? base
              : f.createIndexedAccessTypeNode(
                  members(name.left, base),
                  f.createLiteralTypeNode(
                    f.createStringLiteral(name.right.text),
                  ),
                );
          }
          if (type) return members(node.exprName, type);
          if (symbol && localValues.has(symbol)) {
            let parent: ts.Node = node;
            while (parent.parent && parent.parent !== source)
              parent = parent.parent;
            if (
              ts.isInterfaceDeclaration(parent) ||
              ts.isTypeAliasDeclaration(parent)
            ) {
              const exportedName = [...publicValues].find(
                ([, local]) => local === root.text,
              )?.[0];
              if (exportedName && identifier(exportedName)) {
                needsModuleContext = true;
                function qualified(name: ts.EntityName): ts.EntityName {
                  return ts.isIdentifier(name)
                    ? f.createQualifiedName(
                        f.createIdentifier(moduleContextName),
                        exportedName!,
                      )
                    : f.updateQualifiedName(
                        name,
                        qualified(name.left),
                        name.right,
                      );
                }
                return f.updateTypeQueryNode(
                  node,
                  qualified(node.exprName),
                  node.typeArguments,
                );
              }
              const declaration=symbol.valueDeclaration;
              if(declaration&&ts.isVariableDeclaration(declaration)&&ts.isVariableDeclarationList(declaration.parent)
                &&declaration.parent.flags&ts.NodeFlags.Const&&ts.isVariableStatement(declaration.parent.parent)
                &&declaration.parent.parent.parent===source){
                const queryBindings=options.sourceResolution?.localTypeQueries;
                const query=queryBindings&&Object.prototype.hasOwnProperty.call(queryBindings,root.text)?queryBindings[root.text]:undefined;
                if(query||declaration.type){
                  const staticType=query?f.createTypeReferenceNode(external(query))
                    :ts.visitNode(declaration.type!,visit)as ts.TypeNode;
                  if(!node.typeArguments?.length)return members(node.exprName,staticType);
                  const key=JSON.stringify(['const-query',root.text]);
                  let view=constructorViews.get(key);
                  if(!view){view={name:fresh('__ModuleConstQuery'),type:staticType};constructorViews.set(key,view);}
                  const qualified=(name:ts.EntityName):ts.EntityName=>ts.isIdentifier(name)?f.createIdentifier(view!.name)
                    :f.createQualifiedName(qualified(name.left),name.right.text);
                  return f.createTypeQueryNode(qualified(node.exprName),node.typeArguments.map(type=>ts.visitNode(type,visit)as ts.TypeNode));
                }
                try{return createTypeProjection(checker,[],undefined,trustedDeclaration,false,undefined,filename,standardLibraryFile).data(node);}
                catch{ /* Unsupported inferred shapes retain the explicit gap. */ }
              }
              report(
                node,
                'module-local-type-query',
                'A local runtime type query needs linked module type exports.',
              );
            }
          }
        }
        if (
          ts.isMethodDeclaration(node) &&
          (ts.isObjectLiteralExpression(node.parent) ||
            (ts.isClassDeclaration(node.parent) && node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.StaticKeyword))) &&
          node.body &&
          !hasOwnThis(node)
        ) {
          objectFunctions++;
          // JavaScript methods that never read this are callable after extraction.
          // An explicit void this parameter preserves the function-call ABI.
          return ts.visitEachChild(
            f.updateMethodDeclaration(
              node,
              node.modifiers,
              node.asteriskToken,
              node.name,
              node.questionToken,
              node.typeParameters,
              parameters(node.parameters),
              node.type,
              node.body,
            ),
            visit,
            transformContext,
          );
        }
        if (ts.isFunctionExpression(node) && !hasOwnThis(node)) {
          if (node.name) {
            return ts.visitEachChild(
              privateFunctionExpression(f.updateFunctionExpression(node, node.modifiers,
                node.asteriskToken, node.name, node.typeParameters,
                parameters(node.parameters), node.type, node.body)),
              visit,
              transformContext,
            );
          }
          return ts.visitEachChild(
            f.updateFunctionExpression(
              node,
              node.modifiers,
              node.asteriskToken,
              node.name,
              node.typeParameters,
              parameters(node.parameters),
              node.type,
              node.body,
            ),
            visit,
            transformContext,
          );
        }
        if (ts.isFunctionExpression(node) && node.name) {
          report(
            node,
            'module-named-this',
            'Named function expressions with dynamic this need an explicit native context boundary.',
          );
        }
        return ts.visitEachChild(node, visit, transformContext);
      };
      return ts.visitNode(root, visit) as ts.SourceFile;
    },
  ]);
  // Use original-to-transformed statement indices: no statement is discarded
  // by the visitor, and original node symbols remain the source of all proofs.
  let recordHelper: string | undefined;
  const records =
    options.records &&
    transformDataRecords(transform.transformed[0]!, {
      ignore:node=>ts.isFunctionDeclaration(node)&&unusedFunctions.has(node),
      fresh,
      report,
      helper: () => {
        const binding = options.records!;
        dependency(binding.name, binding.valueType, source, undefined, true);
        if (!recordHelper) {
          recordHelper = fresh('__records');
          keyHelpers.set(binding.name, recordHelper);
        }
        return recordHelper;
      },
    });
  const transformed = hygiene.transform(
    records?.source ?? transform.transformed[0]!,
  );
  const statementMap = new Map(
    source.statements.map((s, i) => [s, transformed.statements[i]!]),
  );
  const classTypes: ts.Statement[] = [];
  for (const [symbol, declaration] of classes) {
    const localName = declaration.name!.text;
    const exports = [...publicValues]
      .filter(([, local]) => local === localName)
      .map(([name]) => name);
    if (!exports.length) {
      for (const statement of types) {
        const find: (node: ts.Node) => void = (node) => {
          if (
            ts.isTypeReferenceNode(node) &&
            checker.getSymbolAtLocation(rootName(node.typeName)) === symbol
          )
            report(
              node,
              'module-class-type',
              'A module-level class type requires a public constructor export.',
            );
          ts.forEachChild(node, find);
        };
        find(statement);
      }
      continue;
    }
    const transformedClass = statementMap.get(
      declaration,
    ) as ts.ClassDeclaration;
    const parameters = transformedClass.typeParameters?.map((p) =>
      f.updateTypeParameterDeclaration(
        p,
        p.modifiers?.filter((m) => m.kind !== ts.SyntaxKind.ConstKeyword),
        p.name,
        p.constraint,
        p.default,
      ),
    );
    const arguments_ = parameters?.map((p) =>
      f.createTypeReferenceNode(p.name),
    );
    const publicTypeNames = new Set(
      exports.filter((name) => identifier(name) && name !== 'default'),
    );
    publicTypeNames.add(localName);
    needsModuleContext = true;
    for (const name of publicTypeNames) {
      const constructorName = exports.find(identifier);
      if (!constructorName) {
        report(
          declaration,
          'module-class-type',
          'A class constructor export needs an identifier name for its native type.',
        );
        continue;
      }
      classTypes.push(
        f.createTypeAliasDeclaration(
          exports.includes(name)
            ? [f.createModifier(ts.SyntaxKind.ExportKeyword)]
            : undefined,
          name,
          parameters,
          f.createTypeReferenceNode('InstanceType', [
            f.createTypeQueryNode(
              f.createQualifiedName(
                f.createIdentifier(moduleContextName),
                constructorName,
              ),
              arguments_,
            ),
          ]),
        ),
      );
    }
    if (exports.includes('default')) {
      classTypes.push(
        f.createExportDeclaration(
          undefined,
          true,
          f.createNamedExports([
            f.createExportSpecifier(false, localName, 'default'),
          ]),
          undefined,
        ),
      );
    }
  }
  const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
  const print = (node: ts.Node) =>
    printer.printNode(ts.EmitHint.Unspecified, node, source);
  const typeText = types
    .map((node) => print(statementMap.get(node) ?? node))
    .join('\n');
  const collisionClasses = createClassCollisionLowering({fresh, report, source, checker});
  const bodyText = hoistFunctions(values.map(node=>statementMap.get(ts.getOriginalNode(node) as ts.Statement)??node))
    .flatMap((node) => {
      return collisionClasses.lower(ordinary(node)).map(print);
    })
    .join('\n');
  transform.dispose();
  const fields = [...runtime]
    .map(([name, { type, members }]) => {
      let target = print(nativeType(type));
      if (members)
        target = `Pick<${target}, ${members.map((value) => JSON.stringify(value)).join(' | ')}>`;
      return `  readonly ${JSON.stringify(name)}: ${target};`;
    })
    .join('\n');
  const result = {
    diagnostics,
    sourceSha256: crypto.createHash('sha256').update(text).digest('hex'),
    exports: [...publicValues.keys()],
    dependencies: [...runtime.keys()],
    objectFunctions,
    iterations,
    propertyCalls,
    keyTraversals:keys?.stats()??0,
    recordLiterals: records?.literals ?? 0,
    recordRests: records?.rests ?? 0,
    arrayLiterals: arrays?.stats().literals ?? 0,
    arrayOperations: arrays?.stats().operations ?? 0,
    restFunctions: arrays?.stats().restFunctions ?? 0,
    callSpreads: arrays?.stats().callSpreads ?? 0,
    forwardFunctions: arrays?.stats().forwardFunctions ?? 0,
    propertyKeyStrings,
    initializedProperties,
    typeQueries,
    unknownReturns,
    unknownAssertions,
    hoistedFunctions,
    functionValues: functions?.stats() ?? {
      names: 0,
      properties: 0,
      calls: 0,
      callableParameters: 0,
      checkedFields: 0,
    },
    nativePragmas,
    renamedIdentifiers: hygiene.count,
    classCollisions: collisionClasses.stats(),
    nulls: nulls?.stats() ?? { values: 0, types: 0, operations: 0 },
    typeSources: references,
    trustedJavaScriptContracts,
  };
  if (diagnostics.length) return result;
  const code = `${nativePragmas.length ? nativePragmas.join('\n') + '\n' : ''}// Generated from ${JSON.stringify(options.filename)}. Compile with roblox-ts.
${[...typeImports.values()].map((entry) => (entry.name === '*' ? `import type * as ${entry.alias} from ${JSON.stringify(entry.module)};` : `import type { ${entry.name} as ${entry.alias} } from ${JSON.stringify(entry.module)};`)).join('\n')}
export interface ${dependenciesName} {
${fields}
}
${needsModuleContext ? `declare const ${moduleContextName}: ReturnType<typeof ${factoryName}>;` : ''}
${[...constructorViews.values()].map(view=>`declare const ${view.name}: ${print(view.type)};`).join('\n')}
${classTypes.map(print).join('\n')}
${typeText}
function ${factoryName}(${context}: ${dependenciesName}) {
${[...runtime]
  .filter(([, value]) => value.emitLocal)
  .map(
    ([name, value]) =>
      `  const ${hygiene.local(value.localName)} = ${context}[${JSON.stringify(name)}];`,
  )
  .join('\n')}
${[...keyHelpers].map(([name, local]) => `  const ${local} = ${runtime.get(name)?.emitLocal ? hygiene.local(runtime.get(name)!.localName) : `${context}[${JSON.stringify(name)}]`};`).join('\n')}
${records && recordHelper ? records.moduleDeclarations(recordHelper) : ''}
${bodyText
  .split('\n')
  .map((line) => '  ' + line)
  .join('\n')}
  return { ${[...publicValues].map(([name, local]) => `${JSON.stringify(name)}: ${hygiene.local(local)}`).join(', ')} };
}
export { ${factoryName} as create };
`;
  return { ...result, source: code.replace(/\s+as\s+[$A-Z_a-z][$\w]*\s+is\s+[$A-Z_a-z][$\w]*(?:\.[$A-Z_a-z][$\w]*)*/g, '') };
}


