import ts from 'typescript';

export type DefineValue = string | number | boolean | null | undefined;
/** Every substituted path must be checked against the runtime context by the
 * project owner. This pass never assumes an environment or package version. */
export type Defines = Readonly<Record<string, DefineValue>>;
export const COMMONJS_RECORD_MODULE = '@3xjn/roblox-react-compiler/__commonjs_record';
export const commonJsLoaderModule = (filename: string, module: string) =>
  `@3xjn/roblox-react-compiler/__commonjs_loader/${encodeURIComponent(filename)}/${encodeURIComponent(module)}`;
export interface CommonJsOptions {
  readonly defines?: Defines;
  /** Project-owned lazy module records; standalone normalization retains the
   * original static contract unless its owner supplies this lifecycle. */
  readonly records?: boolean;
  readonly exportNames?: readonly string[];
  /** Only a platform with an explicit closed global registry may prove that an
   * unbound identifier is absent. Ordinary value reads remain diagnostics. */
  readonly closedGlobals?: readonly string[];
}
export interface CommonJsDiagnostic { readonly code: string; readonly message: string; readonly line: number; readonly column: number }
export interface CommonJsRequire { readonly module: string; readonly local: string; readonly position: number; readonly forwarded?: boolean; readonly importModule?: string }
export interface CommonJsResult {
  readonly source: ts.SourceFile;
  readonly text: string;
  readonly requires: readonly CommonJsRequire[];
  readonly exports: readonly string[];
  readonly commonJs: boolean;
  readonly appliedDefines: Defines;
  readonly absentGlobals: readonly string[];
  readonly diagnostics: readonly CommonJsDiagnostic[];
  readonly record?: { readonly moduleLocal: string; readonly namespaceExport: string };
}
const missing = Symbol('unknown constant');
function lexicalChecker(source: ts.SourceFile) {
  const host = ts.createCompilerHost({ noLib: true, noResolve: true, allowJs: true });
  host.getSourceFile = filename => filename === source.fileName ? source : undefined;
  return ts.createProgram([source.fileName], { noLib: true, noResolve: true, allowJs: true }, host).getTypeChecker();
}
function accessPath(node: ts.Node): string | undefined {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node)) { const parent = accessPath(node.expression); return parent ? `${parent}.${node.name.text}` : undefined; }
  if (ts.isElementAccessExpression(node) && node.argumentExpression && ts.isStringLiteral(node.argumentExpression)) {
    const parent = accessPath(node.expression); return parent ? `${parent}.${node.argumentExpression.text}` : undefined;
  }
  return undefined;
}
function constant(node: ts.Expression): DefineValue | typeof missing {
  if (ts.isParenthesizedExpression(node)) return constant(node.expression);
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isVoidExpression(node) && constant(node.expression) !== missing) return undefined;
  if (ts.isTypeOfExpression(node)) { const value = constant(node.expression); return value === missing ? missing : typeof value; }
  if (ts.isPrefixUnaryExpression(node)) {
    const value = constant(node.operand); if (value === missing) return missing;
    if (node.operator === ts.SyntaxKind.ExclamationToken) return !value;
    if (node.operator === ts.SyntaxKind.MinusToken && typeof value === 'number') return -value;
    if (node.operator === ts.SyntaxKind.PlusToken && typeof value === 'number') return value;
  }
  if (ts.isBinaryExpression(node)) {
    const left = constant(node.left), right = constant(node.right); if (left === missing || right === missing) return missing;
    switch (node.operatorToken.kind) {
      case ts.SyntaxKind.EqualsEqualsEqualsToken: return left === right;
      case ts.SyntaxKind.ExclamationEqualsEqualsToken: return left !== right;
      // JavaScript primitive coercion is deliberately evaluated by JavaScript.
      case ts.SyntaxKind.EqualsEqualsToken: return left == right;
      case ts.SyntaxKind.ExclamationEqualsToken: return left != right;
      case ts.SyntaxKind.AmpersandAmpersandToken: return left && right;
      case ts.SyntaxKind.BarBarToken: return left || right;
      case ts.SyntaxKind.QuestionQuestionToken: return left ?? right;
    }
  }
  return missing;
}
function literal(value: DefineValue): ts.Expression {
  if (value === undefined) return ts.factory.createVoidZero();
  if (value === null) return ts.factory.createNull();
  if (typeof value === 'string') return ts.factory.createStringLiteral(value);
  if (typeof value === 'boolean') return value ? ts.factory.createTrue() : ts.factory.createFalse();
  return value < 0 || Object.is(value, -0)
    ? ts.factory.createPrefixUnaryExpression(ts.SyntaxKind.MinusToken, ts.factory.createNumericLiteral(Math.abs(value)))
    : ts.factory.createNumericLiteral(value);
}
function hoistedVariables(node: ts.Node | undefined): ts.VariableStatement | undefined {
  const names = new Set<string>();
  const binding = (name: ts.BindingName) => {
    if (ts.isIdentifier(name)) names.add(name.text);
    else for (const item of name.elements) if (ts.isBindingElement(item)) binding(item.name);
  };
  const visit = (current: ts.Node) => {
    if (ts.isFunctionLike(current) || ts.isClassLike(current)) return;
    if (ts.isVariableDeclarationList(current) && !(current.flags & ts.NodeFlags.BlockScoped))
      for (const declaration of current.declarations) binding(declaration.name);
    ts.forEachChild(current, visit);
  };
  if (node) visit(node);
  return names.size ? ts.factory.createVariableStatement(undefined,
    ts.factory.createVariableDeclarationList([...names].map(name => ts.factory.createVariableDeclaration(name)))) : undefined;
}

/** Generic CommonJS lowering. Project records preserve require calls at their
 * execution sites. Standalone static normalization accepts only an initial
 * require prefix unless an explicitly verified define removes the branch. */
export function normalizeCommonJs(source: ts.SourceFile, options: CommonJsOptions = {}): CommonJsResult {
  const diagnostics: CommonJsDiagnostic[] = [];
  const appliedDefines: Record<string, DefineValue> = {};
  const absentGlobals = new Set<string>();
  const sourceChecker = lexicalChecker(source);
  const knownGlobals = options.closedGlobals && new Set([...options.closedGlobals,'require','module','exports','undefined','NaN','Infinity']);
  const report = (node: ts.Node, code: string, message: string) => {
    const pos = source.getLineAndCharacterOfPosition(Math.max(0, node.getStart(source)));
    diagnostics.push({ code, message, line: pos.line + 1, column: pos.character + 1 });
  };
  for (const [key, value] of Object.entries(options.defines ?? {})) {
    if (!key.split('.').every(part => /^[A-Za-z_$][\w$]*$/.test(part)) || typeof value === 'number' && !Number.isFinite(value))
      report(source, 'define-contract', `Define ${key} requires an identifier path and a finite primitive value.`);
  }
  const folded = ts.transform(source, [context => {
    const visit: ts.Visitor = node => {
      if (ts.isTypeNode(node)) return node;
      if (knownGlobals && ts.isTypeOfExpression(node) && ts.isIdentifier(node.expression)
        && !sourceChecker.getSymbolAtLocation(node.expression) && !knownGlobals.has(node.expression.text)) {
        absentGlobals.add(node.expression.text);
        return ts.factory.createStringLiteral('undefined');
      }
      const path = accessPath(node);
      let root = node;
      while (ts.isPropertyAccessExpression(root) || ts.isElementAccessExpression(root)) root = root.expression;
      if (path && Object.prototype.hasOwnProperty.call(options.defines ?? {}, path)
        && ts.isIdentifier(root) && !sourceChecker.getSymbolAtLocation(root)) {
        const parent = node.parent;
        if (parent && ((ts.isBinaryExpression(parent) && parent.left === node && parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment)
          || ts.isDeleteExpression(parent) || ts.isPostfixUnaryExpression(parent) || ts.isPrefixUnaryExpression(parent) && (parent.operator === ts.SyntaxKind.PlusPlusToken || parent.operator === ts.SyntaxKind.MinusMinusToken))) {
          report(node, 'define-write', `The verified define ${path} is written by the source.`); return node;
        }
        const value = options.defines![path]; appliedDefines[path] = value; return ts.setTextRange(literal(value), node);
      }
      if (ts.isIfStatement(node)) {
        const condition = ts.visitNode(node.expression, visit) as ts.Expression;
        const value = constant(condition);
        if (value !== missing) {
          const selected = value ? node.thenStatement : node.elseStatement;
          const hoisted = hoistedVariables(value ? node.elseStatement : node.thenStatement);
          const branch = selected ? ts.visitNode(selected, visit) as ts.Statement : undefined;
          if (hoisted) return ts.factory.createBlock([hoisted, ...(branch ? [branch] : [])]);
          return branch ?? ts.factory.createEmptyStatement();
        }
        return ts.factory.updateIfStatement(node, condition, ts.visitNode(node.thenStatement, visit) as ts.Statement,
          node.elseStatement ? ts.visitNode(node.elseStatement, visit) as ts.Statement : undefined);
      }
      if (ts.isConditionalExpression(node)) {
        const condition = ts.visitNode(node.condition, visit) as ts.Expression;
        const value = constant(condition);
        if (value !== missing) return ts.visitNode(value ? node.whenTrue : node.whenFalse, visit);
      }
      if (ts.isBinaryExpression(node) && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(node.operatorToken.kind)) {
        const left = ts.visitNode(node.left, visit) as ts.Expression;
        const value = constant(left);
        if (value !== missing) {
          const selectRight = node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ? !!value
            : node.operatorToken.kind === ts.SyntaxKind.BarBarToken ? !value : value == null;
          return selectRight ? ts.visitNode(node.right, visit) : left;
        }
      }
      return ts.visitEachChild(node, visit, context);
    };
    return root => ts.visitNode(root, visit) as ts.SourceFile;
  }]);
  const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
  const foldedText = printer.printFile(folded.transformed[0]!); folded.dispose();
  const input = ts.createSourceFile(source.fileName, foldedText, ts.ScriptTarget.Latest, true, source.languageVariant === ts.LanguageVariant.JSX ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const names = new Set<string>();
  function collect(node: ts.Node) {
    if (ts.isIdentifier(node)) names.add(node.text);
    ts.forEachChild(node, collect);
  }
  collect(input);
  const checker = lexicalChecker(input);
  const globalIdentifier = (node: ts.Node, name: string) => ts.isIdentifier(node) && node.text === name && !checker.getSymbolAtLocation(node);
  let serial = 0;
  const fresh = (hint: string) => { let name = hint; while (names.has(name)) name = `${hint}${++serial}`; names.add(name); return name; };
  const moduleName = fresh(options.records ? '__cjsModule' : '__cjsModuleExports'), exportsName = fresh('__cjsExports');
  const requires: CommonJsRequire[] = [], exported = new Set<string>(options.exportNames), importStatements: ts.Statement[] = [], reexports = new Set<string>();
  const forwarded = new Set<ts.Node>();
  let commonJs = false, prefix = true, replacesModule = false, rebindsExports = false;
  const allowedRequires = new Set<ts.CallExpression>();
  const requireCall = (node: ts.Node): node is ts.CallExpression => ts.isCallExpression(node) && globalIdentifier(node.expression, 'require');
  const moduleExports = (node: ts.Node) => (ts.isPropertyAccessExpression(node) && node.name.text === 'exports'
    || ts.isElementAccessExpression(node) && node.argumentExpression && ts.isStringLiteral(node.argumentExpression) && node.argumentExpression.text === 'exports')
    && globalIdentifier(node.expression, 'module');
  const exportsProperty = (node: ts.Node): string | undefined => {
    if (ts.isPropertyAccessExpression(node) && (moduleExports(node.expression) || globalIdentifier(node.expression, 'exports'))) return node.name.text;
    if (ts.isElementAccessExpression(node) && node.argumentExpression && ts.isStringLiteral(node.argumentExpression)
      && (moduleExports(node.expression) || globalIdentifier(node.expression, 'exports'))) return node.argumentExpression.text;
    return undefined;
  };
  function markPrefix(statement: ts.Statement) {
    if (ts.isBlock(statement)) { for (const child of statement.statements) markPrefix(child); return; }
    if (ts.isEmptyStatement(statement) || ts.isFunctionDeclaration(statement) || ts.isImportDeclaration(statement)
      || ts.isExpressionStatement(statement) && ts.isStringLiteral(statement.expression)) return;
    if (ts.isVariableStatement(statement) && prefix) {
      for (const declaration of statement.declarationList.declarations) {
        if (prefix && declaration.initializer && requireCall(declaration.initializer)) allowedRequires.add(declaration.initializer);
        else if (declaration.initializer) prefix = false;
      }
      return;
    }
    if (ts.isExpressionStatement(statement) && prefix && ts.isBinaryExpression(statement.expression)
      && statement.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken && moduleExports(statement.expression.left) && requireCall(statement.expression.right)) {
      allowedRequires.add(statement.expression.right);
      const argument = statement.expression.right.arguments[0]; if (argument && ts.isStringLiteral(argument)) reexports.add(argument.text);
    }
    prefix = false;
  }
  for (const statement of input.statements) markPrefix(statement);
  function forward(expression: ts.Expression) {
    if (ts.isParenthesizedExpression(expression)) forward(expression.expression);
    else if (requireCall(expression)) forwarded.add(expression);
    else if (ts.isConditionalExpression(expression)) { forward(expression.whenTrue); forward(expression.whenFalse); }
    else if (ts.isBinaryExpression(expression) && [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.QuestionQuestionToken].includes(expression.operatorToken.kind)) {
      forward(expression.left); forward(expression.right);
    }
  }
  const transformed = ts.transform(input, [context => {
    const visit: ts.Visitor = node => {
      if (requireCall(node)) {
        commonJs = true;
        const argument = node.arguments[0];
        if (node.arguments.length !== 1 || !argument || !ts.isStringLiteral(argument)) {
          report(source, 'cjs-dynamic-require', 'CommonJS require needs one static module string.'); return node;
        }
        if (!options.records && !allowedRequires.has(node)) {
          report(source, 'cjs-lazy-require', `Require ${argument.text} is conditional, function-local, or follows observable initialization; a lazy module loader is required.`); return node;
        }
        const name = fresh('__cjsRequire');
        const importModule = options.records ? commonJsLoaderModule(source.fileName, argument.text) : undefined;
        requires.push({ module: argument.text, local: name, position: node.pos, ...(forwarded.has(node) ? { forwarded: true } : {}), ...(importModule ? { importModule } : {}) });
        const imported = options.records ? ts.factory.createNamedImports([ts.factory.createImportSpecifier(false, ts.factory.createIdentifier('load'), ts.factory.createIdentifier(name))])
          : ts.factory.createNamespaceImport(ts.factory.createIdentifier(name));
        importStatements.push(ts.factory.createImportDeclaration(undefined, ts.factory.createImportClause(false, undefined, imported), ts.factory.createStringLiteral(importModule ?? argument.text)));
        return options.records ? ts.factory.createCallExpression(ts.factory.createIdentifier(name), undefined, []) : ts.factory.createIdentifier(name);
      }
      if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
        const name = exportsProperty(node.left);
        if (name !== undefined) { commonJs = true; exported.add(name); }
        if (moduleExports(node.left)) {
          commonJs = true; replacesModule = true;
          forward(node.right);
          let parent: ts.Node | undefined = node.parent;
          while (parent && !ts.isSourceFile(parent)) {
            if (ts.isFunctionLike(parent)) {
              if (!options.records) report(source, 'cjs-live-replacement', 'Replacing module.exports after initialization needs a live CommonJS module record.');
              break;
            }
            parent = parent.parent;
          }
          if (ts.isObjectLiteralExpression(node.right)) for (const property of node.right.properties) {
            if (ts.isGetAccessorDeclaration(property) || ts.isSetAccessorDeclaration(property)) {
              report(source, 'cjs-export-accessor', 'CommonJS accessor exports require lazy named-export projection to preserve getter timing.');
              continue;
            }
            const name = property.name;
            if (name && (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name))) exported.add(name.text);
          }
        }
        if (globalIdentifier(node.left, 'exports')) rebindsExports = true;
      }
      if (moduleExports(node)) { commonJs = true; return options.records
        ? ts.factory.createPropertyAccessExpression(ts.factory.createIdentifier(moduleName), 'exports') : ts.factory.createIdentifier(moduleName); }
      if (ts.isShorthandPropertyAssignment(node) && globalIdentifier(node.name, 'exports')) {
        commonJs = true;
        return ts.factory.createPropertyAssignment('exports', ts.factory.createIdentifier(exportsName));
      }
      if (globalIdentifier(node, 'exports')
        && !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)) { commonJs = true; return ts.factory.createIdentifier(exportsName); }
      if (globalIdentifier(node, 'require') && !(ts.isCallExpression(node.parent) && node.parent.expression === node)) report(source, 'cjs-require-alias', 'Aliasing CommonJS require needs a lazy module loader.');
      if (globalIdentifier(node, 'module') && !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)) report(source, 'cjs-module-meta', 'CommonJS module metadata requires an explicit native module record.');
      return ts.visitEachChild(node, visit, context);
    };
    return root => ts.visitNode(root, visit) as ts.SourceFile;
  }]);
  let output = printer.printFile(transformed.transformed[0]!); transformed.dispose();
  let record: CommonJsResult['record'];
  if (commonJs) {
    const slots = [...exported].map(name => `${JSON.stringify(name)}?: unknown;`).join(' ');
    if (options.records) {
      const namespaceExport = fresh('__cjsNamespace');
      record = { moduleLocal: moduleName, namespaceExport };
      const declarations = `import {module as ${moduleName}} from ${JSON.stringify(COMMONJS_RECORD_MODULE)};\nlet ${exportsName}: { ${slots} } = ${moduleName}.exports as { ${slots} };\n`;
      const entries = [...exported].filter(name => name !== 'default').map(name =>
        `${JSON.stringify(name)}: (${moduleName}.exports as { ${slots} } | undefined)?.[${JSON.stringify(name)}]`);
      output = declarations + importStatements.map(statement => printer.printNode(ts.EmitHint.Unspecified, statement, input)).join('\n')
        + '\n' + output + `\nexport function ${namespaceExport}(){return {"default": ${moduleName}.exports${entries.length ? `, ${entries.join(', ')}` : ''}};}\n`;
    } else {
    const declarations = `let ${exportsName}: { ${slots} } = {};\nlet ${moduleName}: unknown = ${exportsName};\n`;
    const end = fresh('__cjsDefault');
    let footer = `\nconst ${end} = ${moduleName};\nexport { ${end} as default };\n`;
    for (const name of exported) {
      if (name === 'default') continue; // Node ESM default is the entire CJS value.
      const local = fresh('__cjsExport');
      const owner = !replacesModule && !rebindsExports ? exportsName : moduleName;
      footer += `const ${local} = ${owner} == null ? undefined : ${owner}[${JSON.stringify(name)}];\nexport { ${local} as ${JSON.stringify(name)} };\n`;
    }
    for (const module of reexports) footer += `export * from ${JSON.stringify(module)};\n`;
    output = importStatements.map(statement => printer.printNode(ts.EmitHint.Unspecified, statement, input)).join('\n') + '\n' + declarations + output + footer;
    }
  }
  return { source: ts.createSourceFile(source.fileName, output, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS), text: output,
    requires, exports: [...exported], commonJs, appliedDefines, absentGlobals:[...absentGlobals], diagnostics, ...(record ? { record } : {}) };
}
