import ts from 'typescript';
import { constAssertion, preserveConst } from './literal-const.ts';

interface Options {
  readonly helper: () => string;
  readonly fresh: (base: string) => string;
  readonly report: (node: ts.Node, code: string, message: string) => void;
  readonly ignore?: (node:ts.Node)=>boolean;
}

/** Instrument one intact literal, retaining its contextual method/value types.
 * Temporaries belong to the enclosing function activation, including async
 * bodies. Only defaults and class fields need a lexical construction closure. */
export function transformDataRecords(source: ts.SourceFile, options: Options) {
  const f = ts.factory;
  const moduleTemps: string[] = [];
  let literals = 0;
  let rests = 0;
  const transformed = ts.transform(source, [
    (context) => (root) => {
      let scope: string[] | undefined = moduleTemps;
      function call(name: string, args: readonly ts.Expression[]) {
        return f.createCallExpression(
          f.createPropertyAccessExpression(
            f.createIdentifier(options.helper()),
            name,
          ),
          undefined,
          args,
        );
      }
      function declarations(names: readonly string[]) {
        return names.length
          ? [
              f.createVariableStatement(
                undefined,
                f.createVariableDeclarationList(
                  names.map((name) =>
                    f.createVariableDeclaration(
                      name,
                      undefined,
                      f.createTypeReferenceNode('ReturnType', [
                        f.createTypeQueryNode(
                          f.createQualifiedName(
                            f.createIdentifier(options.helper()),
                            'begin',
                          ),
                        ),
                      ]),
                    ),
                  ),
                  ts.NodeFlags.Let,
                ),
              ),
            ]
          : [];
      }
      function block(body: ts.ConciseBody, names: readonly string[]) {
        if (!names.length) return body;
        const statements = ts.isBlock(body)
          ? [...body.statements]
          : [f.createReturnStatement(body)];
        let prologue = 0;
        while (
          statements[prologue] &&
          ts.isExpressionStatement(statements[prologue]!) &&
          ts.isStringLiteral(
            (statements[prologue] as ts.ExpressionStatement).expression,
          )
        )
          prologue++;
        statements.splice(prologue, 0, ...declarations(names));
        return ts.isBlock(body)
          ? f.updateBlock(body, statements)
          : f.createBlock(statements, true);
      }
      function unwrapped(node: ts.Expression): ts.Expression {
        return ts.isParenthesizedExpression(node)
          ? unwrapped(node.expression)
          : node;
      }
      function staticKey(name: ts.PropertyName): ts.Expression | undefined {
        if (ts.isIdentifier(name)) return f.createStringLiteral(name.text);
        if (ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name;
        if (ts.isComputedPropertyName(name)) {
          const value = unwrapped(name.expression);
          if (ts.isStringLiteral(value) || ts.isNumericLiteral(value))
            return value;
        }
        return undefined;
      }
      const expression = (node: ts.Expression) =>
        ts.visitNode(node, visit) as ts.Expression;
      function bindingNames(name:ts.BindingName):string[]{
        return ts.isIdentifier(name)?[name.text]:name.elements.flatMap(element=>
          ts.isOmittedExpression(element)?[]:bindingNames(element.name));
      }
      function entryBindingSafe(node:ts.SignatureDeclaration & {body?:ts.ConciseBody|undefined},parameter:ts.ParameterDeclaration):boolean{
        if(node.parameters.filter(item=>!(ts.isIdentifier(item.name)&&item.name.text==='this')).length!==1
          ||parameter.initializer||'asteriskToken' in node&&node.asteriskToken
          ||ts.canHaveModifiers(node)&&ts.getModifiers(node)?.some(modifier=>modifier.kind===ts.SyntaxKind.AsyncKeyword))return false;
        const names=new Set(bindingNames(parameter.name));
        const bodyNames=new Set<string>();
        let conflict=false;
        const inspect=(child:ts.Node)=>{
          if(ts.isFunctionLike(child)){
            if(ts.isFunctionDeclaration(child)&&child.name){
              bodyNames.add(child.name.text);
              if(names.has(child.name.text))conflict=true;
            }
            return;
          }
          if(ts.isClassDeclaration(child)){
            if(child.name)bodyNames.add(child.name.text);
            return;
          }
          if(ts.isVariableDeclarationList(child))
            for(const declaration of child.declarations)
              for(const name of bindingNames(declaration.name))bodyNames.add(name);
          if(ts.isVariableDeclarationList(child)&&!(child.flags&(ts.NodeFlags.Let|ts.NodeFlags.Const))
            &&child.declarations.some(declaration=>bindingNames(declaration.name).some(name=>names.has(name))))conflict=true;
          ts.forEachChild(child,inspect);
        };
        if(node.body)inspect(node.body);
        // A non-simple parameter has a scope outside the function body. Moving
        // its expressions into that body must not expose body-only bindings,
        // including inside closures created by a default or computed key.
        const inspectExpression=(child:ts.Node)=>{
          if(ts.isTypeNode(child))return;
          if(ts.isIdentifier(child)&&bodyNames.has(child.text))conflict=true;
          ts.forEachChild(child,inspectExpression);
        };
        const inspectBinding=(name:ts.BindingName)=>{
          if(ts.isIdentifier(name))return;
          for(const element of name.elements){
            if(ts.isOmittedExpression(element))continue;
            if(element.propertyName&&ts.isComputedPropertyName(element.propertyName))inspectExpression(element.propertyName.expression);
            if(element.initializer)inspectExpression(element.initializer);
            inspectBinding(element.name);
          }
        };
        inspectBinding(parameter.name);
        return !conflict;
      }
      const visit: ts.Visitor = (node) => {
        if(options.ignore?.(ts.getOriginalNode(node)))return node;
        if (ts.isTypeNode(node)) return node;
        if (
          constAssertion(node) &&
          ts.isObjectLiteralExpression(node.expression)
        )
          return expression(node.expression);
        if (ts.isFunctionLike(node) && 'body' in node && node.body) {
          const outer = scope;
          scope = undefined;
          const entries:ts.Statement[]=[];
          const parameters=new Map<ts.ParameterDeclaration,ts.ParameterDeclaration>();
          for(const parameter of node.parameters){
            if(ts.isObjectBindingPattern(parameter.name)&&parameter.name.elements.some(element=>element.dotDotDotToken)
              &&entryBindingSafe(node,parameter)){
              const name=f.createIdentifier(options.fresh('__recordArgument'));
              parameters.set(parameter,f.updateParameterDeclaration(parameter,parameter.modifiers,parameter.dotDotDotToken,
                name,parameter.questionToken,parameter.type,undefined));
              entries.push(f.createVariableStatement(undefined,f.createVariableDeclarationList([
                f.createVariableDeclaration(parameter.name,undefined,undefined,name),
              ],ts.NodeFlags.Let)));
            }else parameters.set(parameter,ts.visitNode(parameter,visit)as ts.ParameterDeclaration);
          }
          const temps: string[] = [];
          scope = temps;
          let inputBody=node.body;
          if(entries.length){
            const statements=ts.isBlock(inputBody)?[...inputBody.statements]:[f.createReturnStatement(inputBody)];
            let prologue=0;
            while(statements[prologue]&&ts.isExpressionStatement(statements[prologue]!)
              &&ts.isStringLiteral((statements[prologue]as ts.ExpressionStatement).expression))prologue++;
            statements.splice(prologue,0,...entries);
            inputBody=ts.isBlock(inputBody)?f.updateBlock(inputBody,statements):f.createBlock(statements,true);
          }
          const body = block(
            ts.visitNode(inputBody, visit) as ts.ConciseBody,
            temps,
          );
          scope = outer;
          return ts.visitEachChild(
            node,
            (child) =>
              child === node.body
                ? body
                : (parameters.get(child as ts.ParameterDeclaration) ??
                  visit(child)),
            context,
          );
        }
        if (ts.isPropertyDeclaration(node)) {
          const outer = scope;
          scope = undefined;
          const result = ts.visitEachChild(node, visit, context);
          scope = outer;
          return result;
        }
        if (
          ts.isParameter(node) &&
          ts.isObjectBindingPattern(node.name) &&
          node.name.elements.some((e) => e.dotDotDotToken)
        ) {
          options.report(
            ts.getOriginalNode(node),
            'record-rest-parameter',
            'Object rest parameter entry binding requires one ordinary parameter, without a whole-argument default, async/generator execution, function-scope redeclarations or defaults/computed keys that depend on body-only bindings.',
          );
        }
        if (
          ts.isBinaryExpression(node) &&
          node.operatorToken.kind === ts.SyntaxKind.InKeyword
        ) {
          options.report(
            ts.getOriginalNode(node),
            'record-prototype',
            'The in operator includes inherited properties; this record provider supports own data properties.',
          );
        }
        if (ts.isDeleteExpression(node)) {
          const target = unwrapped(node.expression);
          if (
            (ts.isPropertyAccessExpression(target) ||
              ts.isElementAccessExpression(target)) &&
            !target.questionDotToken
          ) {
            return call('remove', [
              expression(target.expression),
              ts.isPropertyAccessExpression(target)
                ? f.createStringLiteral(target.name.text)
                : expression(target.argumentExpression),
            ]);
          }
          options.report(
            ts.getOriginalNode(node),
            'record-delete',
            'Delete requires a non-optional own-property target.',
          );
        }
        if (
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === 'call'
        ) {
          const method = unwrapped(node.expression.expression);
          if (
            ts.isPropertyAccessExpression(method) &&
            method.name.text === 'hasOwnProperty'
          ) {
            const receiver = unwrapped(method.expression);
            if (
              ts.isObjectLiteralExpression(receiver) &&
              receiver.properties.length === 0 &&
              node.arguments.length === 2
            ) {
              return call('hasOwn', node.arguments.map(expression));
            }
          }
        }
        if (ts.isVariableDeclarationList(node)) {
          const result: ts.VariableDeclaration[] = [];
          for (const declaration of node.declarations) {
            if (
              !ts.isObjectBindingPattern(declaration.name) ||
              !declaration.name.elements.some((e) => e.dotDotDotToken) ||
              !declaration.initializer
            ) {
              result.push(
                ts.visitNode(declaration, visit) as ts.VariableDeclaration,
              );
              continue;
            }
            const capture = f.createIdentifier(options.fresh('__recordSource'));
            result.push(
              f.createVariableDeclaration(
                capture,
                undefined,
                declaration.type,
                expression(declaration.initializer),
              ),
            );
            const excluded: ts.Expression[] = [];
            for (const element of declaration.name.elements) {
              if (element.dotDotDotToken) {
                rests++;
                result.push(
                  f.createVariableDeclaration(
                    element.name,
                    undefined,
                    undefined,
                    call('rest', [
                      capture,
                      f.createArrayLiteralExpression(excluded),
                    ]),
                  ),
                );
              } else {
                const key =
                  element.propertyName ??
                  (ts.isIdentifier(element.name) ? element.name : undefined);
                const value = key && staticKey(key);
                if (!value)
                  options.report(
                    ts.getOriginalNode(element),
                    'record-rest-key',
                    'Computed rest exclusions need a captured property-key binding.',
                  );
                else excluded.push(value);
                result.push(
                  f.createVariableDeclaration(
                    f.createObjectBindingPattern([
                      ts.visitNode(element, visit) as ts.BindingElement,
                    ]),
                    undefined,
                    undefined,
                    capture,
                  ),
                );
              }
            }
          }
          return f.updateVariableDeclarationList(node, result);
        }
        if (!ts.isObjectLiteralExpression(node))
          return ts.visitEachChild(node, visit, context);
        literals++;
        const token = f.createIdentifier(options.fresh('__recordConstruction'));
        if (scope) scope.push(token.text);
        const properties: ts.ObjectLiteralElementLike[] = [];
        let staticNames: ts.Expression[] = [];
        let staticProperties: ts.ObjectLiteralElementLike[] = [];
        const flush = () => {
          if (!staticNames.length) return;
          properties.push(
            f.createSpreadAssignment(call('mark', [token, ...staticNames])),
            ...staticProperties,
          );
          staticNames = [];
          staticProperties = [];
        };
        for (const property of node.properties) {
          if(ts.isMethodDeclaration(property)){
            const inspectSuper=(child:ts.Node)=>{
              if(child.kind===ts.SyntaxKind.SuperKeyword)options.report(ts.getOriginalNode(child),'record-prototype',
                'Source super requires its original home-object prototype.');
              ts.forEachChild(child,inspectSuper);
            };
            inspectSuper(property);
            const thisParameter=property.parameters.find(parameter=>ts.isIdentifier(parameter.name)&&parameter.name.text==='this');
            const receiver=thisParameter?.type?.kind!==ts.SyntaxKind.VoidKeyword;
            let length=0;
            for(const parameter of property.parameters){
              if(ts.isIdentifier(parameter.name)&&parameter.name.text==='this')continue;
              if(parameter.dotDotDotToken||parameter.initializer)break;
              length++;
            }
            const key=staticKey(property.name);
            if(key){
              flush();
              properties.push(f.createSpreadAssignment(call('markMethod',[token,key,f.createNumericLiteral(length),
                receiver?f.createTrue():f.createFalse()])));
              properties.push(ts.visitNode(property,visit)as ts.MethodDeclaration);
            }else if(ts.isComputedPropertyName(property.name)){
              flush();
              const name=f.createComputedPropertyName(call('methodKey',[token,expression(property.name.expression),
                f.createNumericLiteral(length),receiver?f.createTrue():f.createFalse()]));
              properties.push(ts.visitNode(f.updateMethodDeclaration(property,property.modifiers,property.asteriskToken,
                name,property.questionToken,property.typeParameters,property.parameters,property.type,property.body),visit)as ts.MethodDeclaration);
            }else options.report(ts.getOriginalNode(property),'record-method','A source method requires a property key.');
            continue;
          }
          if (ts.isSpreadAssignment(property)) {
            flush();
            properties.push(
              f.createSpreadAssignment(
                call('spread', [token, expression(property.expression)]),
              ),
            );
            continue;
          }
          if (
            ts.isGetAccessorDeclaration(property) ||
            ts.isSetAccessorDeclaration(property)
          ) {
            flush();
            const key = staticKey(property.name) ?? (ts.isComputedPropertyName(property.name)
              ? expression(property.name.expression) : undefined);
            if (!key || !property.body) {
              options.report(ts.getOriginalNode(property), 'record-accessor', 'An accessor needs a source key and implementation.');
              continue;
            }
            const callback = f.createFunctionExpression(undefined, undefined, undefined, undefined,
              [f.createParameterDeclaration(undefined, undefined, 'this', undefined,
                f.createKeywordTypeNode(ts.SyntaxKind.AnyKeyword)),
                ...property.parameters.map(parameter => ts.visitNode(parameter, visit) as ts.ParameterDeclaration)],
              property.type && (ts.visitNode(property.type, visit) as ts.TypeNode),
              ts.visitNode(property.body, visit) as ts.Block);
            properties.push(f.createSpreadAssignment(call('accessor', [token, key,
              ts.isGetAccessorDeclaration(property) ? callback : f.createIdentifier('undefined'),
              ts.isSetAccessorDeclaration(property) ? callback : f.createIdentifier('undefined')])));
            continue;
          }
          const superUse = (child: ts.Node): void => {
            if (child.kind === ts.SyntaxKind.SuperKeyword)
              options.report(
                ts.getOriginalNode(child),
                'record-prototype',
                'Object method super needs a home-object prototype implementation.',
              );
            else if (!ts.isClassLike(child)) ts.forEachChild(child, superUse);
          };
          ts.forEachChild(property, superUse);
          const key = staticKey(property.name);
          if (
            ts.isPropertyAssignment(property) &&
            !ts.isComputedPropertyName(property.name) &&
            key &&
            ts.isStringLiteral(key) &&
            key.text === '__proto__'
          ) {
            options.report(
              ts.getOriginalNode(property),
              'record-prototype',
              'The __proto__ initializer sets a prototype; use a computed data-property name if intended.',
            );
          }
          let visited = ts.visitNode(
            property,
            visit,
          ) as ts.ObjectLiteralElementLike;
          if (key) {
            staticNames.push(key);
            staticProperties.push(visited);
          } else if (ts.isComputedPropertyName(property.name)) {
            flush();
            const name = (visited as ts.PropertyAssignment)
              .name as ts.ComputedPropertyName;
            visited = ts.visitEachChild(
              visited,
              (child) =>
                child === name
                  ? f.createComputedPropertyName(
                      call('key', [token, name.expression]),
                    )
                  : child,
              context,
            );
            properties.push(visited);
          }
        }
        flush();
        const literal = preserveConst(
          f.updateObjectLiteralExpression(node, properties),
          node,
        );
        if (scope)
          return call('finish', [
            f.createBinaryExpression(
              token,
              f.createToken(ts.SyntaxKind.EqualsToken),
              call('begin', []),
            ),
            literal,
          ]);
        // A parameter default/field initializer runs before an enclosing body
        // local exists. Keep its construction state private to this evaluation.
        return f.createCallExpression(
          f.createParenthesizedExpression(
            f.createArrowFunction(
              undefined,
              undefined,
              [],
              undefined,
              f.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
              f.createBlock(
                [
                  f.createVariableStatement(
                    undefined,
                    f.createVariableDeclarationList(
                      [
                        f.createVariableDeclaration(
                          token,
                          undefined,
                          undefined,
                          call('begin', []),
                        ),
                      ],
                      ts.NodeFlags.Const,
                    ),
                  ),
                  f.createReturnStatement(call('finish', [token, literal])),
                ],
                true,
              ),
            ),
          ),
          undefined,
          [],
        );
      };
      return ts.visitNode(root, visit) as ts.SourceFile;
    },
  ]);
  const result = {
    source: transformed.transformed[0]!,
    moduleTemps: [...moduleTemps],
    literals,
    rests,
    moduleDeclarations: (helper: string) =>
      moduleTemps
        .map((name) => `let ${name}: ReturnType<typeof ${helper}.begin>;`)
        .join('\n'),
  };
  transformed.dispose();
  return result;
}
