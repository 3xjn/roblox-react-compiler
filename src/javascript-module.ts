import ts from 'typescript';
import type {Diagnostic,GlobalBinding,ValueTypeBinding} from './index.ts';
import type {DataImportBinding} from './data-module.ts';
import {scalarString} from './string-methods.ts';

export interface JavaScriptModuleOptions {
  readonly filename:string;
  readonly bindings:readonly DataImportBinding[];
  readonly globals:readonly GlobalBinding[];
  readonly operations:Pick<GlobalBinding,'name'|'valueType'>;
  readonly nulls:Pick<GlobalBinding,'name'|'valueType'>;
  readonly declarationModule?:string;
  readonly declarationInterop?:'commonjs-namespace'|'commonjs-export-equals';
  /** Internal graph view only. This never augments the published facade. */
  readonly runtimeExportsType?:string;
  readonly strict:boolean;
  readonly commonJs?:boolean;
  /** JSX syntax and published JSX calls enter the same explicitly owned host. */
  readonly jsx?:{
    readonly factory:Pick<GlobalBinding,'name'|'valueType'>;
    readonly multiple:Pick<GlobalBinding,'name'|'valueType'>;
    readonly fragment:Pick<GlobalBinding,'name'|'valueType'>;
  };
}
export interface JavaScriptModuleResult {
  readonly source?:string;
  readonly diagnostics:readonly Diagnostic[];
  readonly runtimeExports:readonly string[];
  readonly sourceValueContext:{readonly name:string;readonly bindings:readonly Pick<GlobalBinding,'name'|'valueType'>[]};
}
interface FunctionContext {readonly receiver:string;readonly args?:string|undefined;readonly argumentsValue?:string|undefined;readonly constructorFrame?:string|undefined;readonly newTarget?:string|undefined;readonly strict:boolean;readonly asynchronous?:boolean;readonly switchBreak?:string|undefined;readonly switchCompletions?:readonly string[]}
interface Cell {readonly name:string;readonly kind:'var'|'let'|'const'}
const quote=JSON.stringify;

/** JavaScript has no authored TypeScript implementation signature. Lower its
 * actual body through checked language operations, while retaining a separately
 * published declaration as the consumer ABI. This is declaration trust, not a
 * claim that an erased implementation has been statically re-proved. */
export function compileJavaScriptModule(text:string,options:JavaScriptModuleOptions):JavaScriptModuleResult {
  const source=ts.createSourceFile(options.filename,text,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
  const compilerOptions:ts.CompilerOptions={noLib:true,noResolve:true,allowJs:true,checkJs:true,target:ts.ScriptTarget.ESNext,module:ts.ModuleKind.ESNext};
  const host=ts.createCompilerHost(compilerOptions);
  host.getSourceFile=filename=>filename===source.fileName?source:undefined;
  const program=ts.createProgram([source.fileName],compilerOptions,host),checker=program.getTypeChecker();
  const diagnostics:Diagnostic[]=[];
  const report=(node:ts.Node,message:string,code='javascript-operation')=>{
    const point=source.getLineAndCharacterOfPosition(Math.max(0,node.getStart(source)));
    diagnostics.push({code,message,line:point.line+1,column:point.character+1});
  };
  const checkStrings=(node:ts.Node)=>{
    if((ts.isStringLiteralLike(node)||ts.isTemplateHead(node)||ts.isTemplateMiddle(node)||ts.isTemplateTail(node))&&!scalarString(node.text))
      report(node,'A source string containing an unpaired surrogate needs a UTF-16 literal representation.','javascript-string');
    ts.forEachChild(node,checkStrings);
  };checkStrings(source);
  for(const diagnostic of program.getSyntacticDiagnostics(source)){
    const point=source.getLineAndCharacterOfPosition(diagnostic.start??0);
    diagnostics.push({code:'syntax',message:ts.flattenDiagnosticMessageText(diagnostic.messageText,'\n'),line:point.line+1,column:point.character+1});
  }
  const names=new Set<string>();
  const scanNames=(node:ts.Node)=>{if(ts.isIdentifier(node))names.add(node.text);ts.forEachChild(node,scanNames);};scanNames(source);
  let temporaryIndex=0;
  const fresh=(base:string)=>{
    if(base.startsWith('__js') && base!=='__jsDependencies') {
      let name:string;
      do { name=`__t${(temporaryIndex++).toString(36)}`; } while(names.has(name));
      names.add(name);return name;
    }
    let name=base;for(let i=1;names.has(name);i++)name=base+i;names.add(name);return name;
  };
  const operations=fresh('__o'),nulls=fresh('__n'),dependencies=fresh('__jsDependencies'),contextName=fresh('__javascriptValues');
  const imports=new Map<ts.Symbol,string>(),cells=new Map<ts.Symbol,Cell>(),declarations=new Map<ts.Declaration,Cell>();
  const exported=new Map<string,string>(),nativeTypes=new Map<string,{module:string;name:string;alias:string}>();
  const fields=new Map<string,ValueTypeBinding>(),globals=new Map(options.globals.map(binding=>[binding.name,binding]));
  const bindings=new Map(options.bindings.map(binding=>[quote([binding.module,binding.name]),binding]));
  const nativeType=(type:ValueTypeBinding)=>{
    const key=quote([type.module,type.name]);let item=nativeTypes.get(key);
    if(!item){item={module:type.module,name:type.name,alias:fresh('__JsType')};nativeTypes.set(key,item);}
    const base=type.typeOf?`typeof ${item.alias}`:item.alias;
    return type.member===undefined?base:`(${base})[${quote(type.member)}]`;
  };
  const dependency=(name:string,type:ValueTypeBinding)=>{
    const previous=fields.get(name);
    if(previous&&quote(previous)!==quote(type))report(source,`Conflicting JavaScript dependency ${name}.`,'javascript-dependency');
    fields.set(name,type);return `${dependencies}[${quote(name)}]`;
  };
  for(const statement of source.statements)if(ts.isImportDeclaration(statement)&&ts.isStringLiteral(statement.moduleSpecifier)&&statement.importClause&&!statement.importClause.isTypeOnly){
    const clause=statement.importClause,module=statement.moduleSpecifier.text;
    const add=(local:ts.Identifier,name:string)=>{
      const binding=bindings.get(quote([module,name]));
      if(!binding){report(local,`No linked JavaScript value for ${module}#${name}.`,'javascript-import');return;}
      const symbol=checker.getSymbolAtLocation(local);if(symbol)imports.set(symbol,dependency(local.text,binding.valueType));
    };
    if(clause.name)add(clause.name,'default');
    if(clause.namedBindings&&ts.isNamespaceImport(clause.namedBindings))add(clause.namedBindings.name,'*');
    else if(clause.namedBindings)for(const item of clause.namedBindings.elements)if(!item.isTypeOnly)add(item.name,(item.propertyName??item.name).text);
  }
  const op=(name:string,...args:string[])=>`${operations}.${name}(${args.join(', ')})`;
  const symbolAt=(node:ts.Identifier)=>ts.isShorthandPropertyAssignment(node.parent)?checker.getShorthandAssignmentValueSymbol(node.parent):checker.getSymbolAtLocation(node);
  const cellAt=(node:ts.Identifier)=>{
    const symbol=symbolAt(node);return symbol&&(cells.get(symbol)??symbol.declarations?.map(declaration=>declarations.get(declaration)).find(Boolean));
  };
  function allocate(name:ts.BindingName,kind:Cell['kind'],output:string[]):void {
    if(!ts.isIdentifier(name)){for(const item of name.elements)if(ts.isBindingElement(item))allocate(item.name,kind,output);return;}
    const symbol=checker.getSymbolAtLocation(name);if(!symbol){report(name,'A JavaScript binding has no lexical declaration owner.');return;}
    if(cells.has(symbol))return;
    const cell:Cell={name:fresh('__js_'+name.text.replace(/[^A-Za-z0-9_]/g,'_')),kind};cells.set(symbol,cell);
    for(const declaration of symbol.declarations??[])declarations.set(declaration,cell);
    output.push(`const ${cell.name} = ${op('binding',quote(kind),quote(name.text))};`);
  }
  function id(node:ts.Identifier,context:FunctionContext):string {
    const symbol=symbolAt(node),imported=symbol&&imports.get(symbol);if(imported)return imported;
    const cell=cellAt(node);if(cell)return op('read',cell.name);
    if(node.text==='undefined')return 'undefined';
    if(node.text==='arguments'&&context.argumentsValue)return context.argumentsValue;
    const global=globals.get(node.text);if(global)return dependency(global.name,global.valueType);
    report(node,`No shared native owner for JavaScript global ${node.text}.`,'javascript-global');return 'undefined';
  }
  function iife(lines:readonly string[],value:string):string{return `(() => { ${lines.join('\n')} return ${value}; })()`;}
  function iteratorScope(iterator:string,lines:readonly string[]):string[] {
    const abrupt=fresh('__jsIteratorAbrupt'),error=fresh('__jsIteratorError');
    return [`let ${abrupt} = false;`,'try {',...lines,
      `} catch (${error}) { ${abrupt} = true; throw ${error}; } finally { ${op('close',iterator,abrupt)}; }`];
  }
  function propertyKey(node:ts.PropertyName,context:FunctionContext):string {
    if(ts.isIdentifier(node)||ts.isPrivateIdentifier(node)||ts.isStringLiteralLike(node))return quote(node.text);
    if(ts.isNumericLiteral(node))return node.text;
    if(ts.isComputedPropertyName(node))return op('key',expression(node.expression,context));
    report(node,'This JavaScript property key is unsupported.');return 'undefined';
  }
  function packet(items:readonly ts.Expression[],context:FunctionContext):string {
    if(!items.some(ts.isSpreadElement))return op('array',`[${items.map(item=>expression(item,context)).join(', ')}]`,String(items.length));
    const array=fresh('__jsArguments'),lines=[`const ${array} = ${op('array','[]','0')};`];
    for(const item of items)lines.push(`${op(ts.isSpreadElement(item)?'arraySpread':'arrayPush',array,expression(ts.isSpreadElement(item)?item.expression:item,context))};`);
    return iife(lines,array);
  }
  function reference(node:ts.Expression,context:FunctionContext,body:(get:string,set:(value:string)=>string)=>string):string {
    if(ts.isParenthesizedExpression(node))return reference(node.expression,context,body);
    if(ts.isIdentifier(node)){
      const cell=cellAt(node);
      if(!cell){report(node,'Assignment requires a source-owned mutable binding.');return 'undefined';}
      return body(op('read',cell.name),value=>op('write',cell.name,value));
    }
    if(ts.isPropertyAccessExpression(node)||ts.isElementAccessExpression(node)){
      const owner=fresh('__jsOwner'),key=fresh('__jsKey');
      const prefix=[`const ${owner}: unknown = ${expression(node.expression,context)};`];
      // A property reference retains its raw computed key. GetValue and
      // PutValue each perform coercion, after their own nullish receiver check.
      // In particular plain assignment evaluates its RHS before PutValue fails.
      prefix.push(`const ${key}: unknown = ${ts.isElementAccessExpression(node)?expression(node.argumentExpression,context):quote(node.name.text)};`);
      return iife(prefix,body(op('get',owner,key),value=>op('set',owner,key,value)));
    }
    report(node,'Assignment requires a source binding or property reference.');return 'undefined';
  }
  function pattern(node:ts.Expression):ts.ObjectLiteralExpression|ts.ArrayLiteralExpression|undefined {
    if(ts.isParenthesizedExpression(node))return pattern(node.expression);
    return ts.isObjectLiteralExpression(node)||ts.isArrayLiteralExpression(node)?node:undefined;
  }
  function assign(target:ts.Expression,value:()=>string,output:string[],context:FunctionContext):void {
    if(ts.isParenthesizedExpression(target)){assign(target.expression,value,output,context);return;}
    if(ts.isBinaryExpression(target)&&target.operatorToken.kind===ts.SyntaxKind.EqualsToken){
      assign(target.left,()=>{
        const input=fresh('__jsAssignmentDefault');
        return iife([`const ${input}: unknown = ${value()};`],`${input} === undefined ? ${expression(target.right,context)} : ${input}`);
      },output,context);return;
    }
    if(ts.isObjectLiteralExpression(target)){
      const from=fresh('__jsAssignmentObject'),excluded:string[]=[];
      output.push(`const ${from}: unknown = ${value()};`,`${op('requireObject',from)};`);
      target.properties.forEach((property,index)=>{
        if(ts.isSpreadAssignment(property)){
          if(index!==target.properties.length-1||target.properties.hasTrailingComma)report(property,'Object assignment rest must be the final property without a trailing comma.');
          if(pattern(property.expression)||ts.isBinaryExpression(property.expression))report(property,'Object assignment rest requires a binding or property reference.');
          else assign(property.expression,()=>op('objectRest',from,`[${excluded.join(', ')}]`),output,context);
          return;
        }
        if(ts.isPropertyAssignment(property)){
          const key=fresh('__jsAssignmentKey');
          output.push(`const ${key}: unknown = ${propertyKey(property.name,context)};`);excluded.push(key);
          assign(property.initializer,()=>op('get',from,key),output,context);return;
        }
        if(ts.isShorthandPropertyAssignment(property)){
          const key=quote(property.name.text);excluded.push(key);
          assign(property.name,()=>{
            const get=op('get',from,key);
            if(!property.objectAssignmentInitializer)return get;
            const input=fresh('__jsAssignmentDefault');
            return iife([`const ${input}: unknown = ${get};`],`${input} === undefined ? ${expression(property.objectAssignmentInitializer,context)} : ${input}`);
          },output,context);return;
        }
        report(property,'An object assignment pattern only supports properties and a final rest reference.');
      });return;
    }
    if(ts.isArrayLiteralExpression(target)){
      const iterator=fresh('__jsAssignmentIterator'),steps:string[]=[];
      output.push(`const ${iterator} = ${op('iterator',value())};`);
      target.elements.forEach((element,index)=>{
        if(ts.isOmittedExpression(element)){steps.push(`${op('next',iterator)};`);return;}
        if(ts.isSpreadElement(element)){
          if(index!==target.elements.length-1||target.elements.hasTrailingComma)report(element,'Array assignment rest must be the final element without a trailing comma.');
          if(ts.isBinaryExpression(element.expression))report(element,'Array assignment rest cannot have a default initializer.');
          else assign(element.expression,()=>op('iteratorRest',iterator),steps,context);
        }else assign(element,()=>op('next',iterator),steps,context);
      });
      output.push(...iteratorScope(iterator,steps));return;
    }
    // Capture each non-pattern LHS reference before reading its property or
    // iterator value. Defaults run after that read and before PutValue.
    output.push(`${reference(target,context,(_get,set)=>set(value()))};`);
  }
  function logical(operator:string,left:string,right:()=>string):string {
    const value=fresh('__jsLeft');
    return iife([`const ${value}: unknown = ${left};`],operator==='&&'?`${op('truthy',value)} ? ${right()} : ${value}`
      :operator==='||'?`${op('truthy',value)} ? ${value} : ${right()}`:`${value} === undefined || ${value} === ${nulls}.value ? ${right()} : ${value}`);
  }
  function chain(node:ts.Expression,context:FunctionContext):string {
    type Step={node:ts.PropertyAccessExpression|ts.ElementAccessExpression|ts.CallExpression};
    const steps:Step[]=[];
    const flatten=(current:ts.Expression):ts.Expression=>{
      if(ts.isPropertyAccessExpression(current)||ts.isElementAccessExpression(current)||ts.isCallExpression(current)){
        const base=flatten(current.expression);steps.push({node:current});return base;
      }
      return current;
    };
    const base=flatten(node),current=fresh('__jsChain'),receiver=fresh('__jsReceiver');
    const lines=[`let ${current}: unknown = ${expression(base,context)};`,`let ${receiver}: unknown = undefined;`];
    for(const step of steps){
      const item=step.node;
      if(item.questionDotToken)lines.push(`if (${current} === undefined || ${current} === ${nulls}.value) return undefined;`);
      if(ts.isCallExpression(item)){
        lines.push(`${current} = ${op('call',current,receiver,packet(item.arguments,context))};`,`${receiver} = undefined;`);
      }else{
        const key=ts.isPropertyAccessExpression(item)?quote(item.name.text):expression(item.argumentExpression,context);
        lines.push(`${receiver} = ${current};`,`${current} = ${op('get',current,key)};`);
      }
    }
    return iife(lines,current);
  }
  function functionValue(node:ts.FunctionDeclaration|ts.FunctionExpression|ts.ArrowFunction|ts.MethodDeclaration|ts.ConstructorDeclaration|ts.GetAccessorDeclaration|ts.SetAccessorDeclaration,outer:FunctionContext,inferredName='',constructor=false):string {
    if('asteriskToken'in node&&node.asteriskToken){
      report(node,'Generator JavaScript functions need their own completion/iterator owner.');return 'undefined';
    }
    const asynchronous=!!node.modifiers?.some(modifier=>modifier.kind===ts.SyntaxKind.AsyncKeyword);
    const receiver=fresh('__jsThis'),args=fresh('__jsArgs'),newTarget=fresh('__jsNewTarget'),prologue:string[]=[];
    const arrow=ts.isArrowFunction(node),strict=outer.strict||!!node.body&&ts.isBlock(node.body)
      &&node.body.statements.some((statement,index)=>index===0&&ts.isExpressionStatement(statement)&&ts.isStringLiteral(statement.expression)&&statement.expression.text==='use strict');
    const argumentsPrologue:string[]=[];
    let argumentsValue=arrow?outer.argumentsValue:undefined,readsArguments=false;
    if(!arrow){
      const scan=(child:ts.Node):void=>{
        if(child!==node&&ts.isFunctionLike(child)&&!ts.isArrowFunction(child))return;
        if(ts.isIdentifier(child)&&child.text==='arguments'&&!symbolAt(child)?.declarations?.length
          &&!(ts.isPropertyAccessExpression(child.parent)&&child.parent.name===child)
          &&!(ts.isPropertyAssignment(child.parent)&&child.parent.name===child))readsArguments=true;
        ts.forEachChild(child,scan);
      };scan(node);
      if(readsArguments){
        const cached=fresh('__jsArgumentsObject'),ready=fresh('__jsArgumentsReady'),read=fresh('__jsReadArguments');
        argumentsPrologue.push(`let ${cached}: unknown;`,`let ${ready} = false;`,
          `const ${read} = (): unknown => { if (!${ready}) { ${cached} = ${op('argumentsObject',args,'true')}; ${ready} = true; } return ${cached}; };`);
        argumentsValue=`${read}()`;
      }
    }
    const context:FunctionContext={receiver:constructor?op('classThis',receiver):arrow?outer.receiver:receiver,args:arrow?outer.args:args,
      argumentsValue,
      constructorFrame:constructor?receiver:arrow?outer.constructorFrame:undefined,
      newTarget:constructor?op('classNewTarget',receiver):arrow?outer.newTarget:newTarget,strict:constructor||strict,asynchronous};
    for(const parameter of node.parameters){
      const scan=(child:ts.Node):void=>{
        if(ts.isFunctionLike(child)||ts.isTypeNode(child))return;
        if(ts.isAwaitExpression(child))report(child,'Await is invalid in a function parameter initializer.','javascript-await');
        ts.forEachChild(child,scan);
      };scan(parameter);
    }
    if(!arrow&&!strict){
      let readsThis=false;
      const scan=(child:ts.Node)=>{if(child!==node&&ts.isFunctionLike(child)&&!ts.isArrowFunction(child))return;if(child.kind===ts.SyntaxKind.ThisKeyword)readsThis=true;ts.forEachChild(child,scan);};scan(node);
      if(readsThis)report(node,'Sloppy functions that observe this require source global/boxing semantics.','javascript-this');
      if(readsArguments)report(node,'Sloppy arguments/parameter aliasing requires an arguments-object owner.','javascript-arguments');
    }
    let privateCell:Cell|undefined;
    if(ts.isFunctionExpression(node)&&node.name){allocate(node.name,'const',prologue);privateCell=cellAt(node.name);}
    const parameterCells:string[]=[];
    for(const parameter of node.parameters)allocate(parameter.name,'let',parameterCells);
    const parameterInit:string[]=[];
    node.parameters.forEach((parameter,index)=>{
      const value=parameter.dotDotDotToken
        ?op('call',op('get',args,quote('slice')),args,op('array',`[${index}]`,'1')):op('get',args,String(index));
      bind(parameter.name,value,parameterInit,context,true,parameter.initializer);
    });
    let body:string;
    if(ts.isBlock(node.body!)){
      const statements=node.body!.statements;
      const terminal=(node:ts.Statement|undefined):boolean=>!!node&&(ts.isReturnStatement(node)||ts.isThrowStatement(node)
        ||ts.isBlock(node)&&terminal(node.statements.at(-1))
        ||ts.isIfStatement(node)&&!!node.elseStatement&&terminal(node.thenStatement)&&terminal(node.elseStatement));
      body=block(statements,context,true,[...argumentsPrologue,...parameterCells,...parameterInit]);
      if(!terminal(statements.at(-1)))body+='\nreturn undefined;';
    }
    else body=[...argumentsPrologue,...parameterCells,...parameterInit,`return ${expression(node.body as ts.Expression,context)};`].join('\n');
    let length=0;for(const parameter of node.parameters){if(parameter.dotDotDotToken||parameter.initializer)break;length++;}
    const name=ts.isFunctionExpression(node)&&node.name?node.name.text:ts.isFunctionDeclaration(node)&&node.name?node.name.text:inferredName;
    const callback=`(${receiver}: unknown, ${args}: readonly unknown[]${constructor?'':`, ${newTarget}: unknown`}): unknown => {\n${body}\n}`;
    if(constructor)return callback;
    const value=op(asynchronous?'asyncFunctionValue':'functionValue',callback,quote(name),String(length),quote(arrow?'arrow':ts.isMethodDeclaration(node)||ts.isGetAccessor(node)||ts.isSetAccessor(node)?'method':'ordinary'));
    if(privateCell)return iife([...prologue,`${op('initialize',privateCell.name,value)};`],op('read',privateCell.name));
    return value;
  }
  function namedExpression(node:ts.Expression,context:FunctionContext,key?:string):string {
    let value=node;while(ts.isParenthesizedExpression(value))value=value.expression;
    if(ts.isClassExpression(value)&&!value.name)return classValue(value,context,'',key);
    if(key===undefined&&(ts.isArrowFunction(value)||ts.isFunctionExpression(value)&&!value.name))return functionValue(value,context);
    const emitted=expression(node,context);
    return key!==undefined&&(ts.isArrowFunction(value)||ts.isFunctionExpression(value)&&!value.name)?op('namedValue',emitted,key):emitted;
  }
  function classValue(node:ts.ClassDeclaration|ts.ClassExpression,outer:FunctionContext,inferredName='',namedKey?:string):string {
    const lines:string[]=[],value=fresh('__jsClass'),prototype=fresh('__jsClassPrototype'),fieldReceiver=fresh('__jsFieldThis');
    const name=node.name?.text??inferredName,heritage=node.heritageClauses?.find(clause=>clause.token===ts.SyntaxKind.ExtendsKeyword);
    if(node.modifiers?.some(ts.isDecorator))report(node,'Class decorators require their own evaluation and initializer protocol.','javascript-class');
    const symbol=node.name&&checker.getSymbolAtLocation(node.name),previous=symbol&&cells.get(symbol);
    const previousDeclarations=new Map<ts.Declaration,Cell|undefined>();
    let inner:Cell|undefined;
    if(symbol){
      inner={name:fresh('__jsClassName'),kind:'const'};cells.set(symbol,inner);
      for(const declaration of symbol.declarations??[]){previousDeclarations.set(declaration,declarations.get(declaration));declarations.set(declaration,inner);}
      lines.push(`const ${inner.name} = ${op('binding',quote('const'),quote(name))};`);
    }
    const strict={...outer,strict:true},base=fresh('__jsClassBase');
    lines.push(`const ${base}: unknown = ${heritage?expression(heritage.types[0]!.expression,strict):'undefined'};`);
    const instanceFields:string[]=[],staticFields:string[]=[],definitions:string[]=[];
    let constructor:ts.ConstructorDeclaration|undefined;
    for(const item of node.members){
      if(ts.isConstructorDeclaration(item)){
        if(constructor)report(item,'A class cannot contain multiple constructors.','javascript-class');
        constructor=item;continue;
      }
      if(ts.isClassStaticBlockDeclaration(item)){report(item,'Class static blocks require a static initialization completion owner.','javascript-class');continue;}
      if(!item.name){report(item,'This class element requires a source name.','javascript-class');continue;}
      if(ts.isPrivateIdentifier(item.name)){report(item,'Private class elements require branded private storage.','javascript-class');continue;}
      if(ts.canHaveDecorators(item)&&ts.getDecorators(item)?.length){report(item,'Class decorators require their own evaluation and initializer protocol.','javascript-class');continue;}
      const key=fresh('__jsClassKey'),isStatic=ts.canHaveModifiers(item)&&!!ts.getModifiers(item)?.some(modifier=>modifier.kind===ts.SyntaxKind.StaticKeyword);
      if(ts.canHaveModifiers(item)&&ts.getModifiers(item)?.some(modifier=>modifier.kind===ts.SyntaxKind.AccessorKeyword)){
        report(item,'Auto-accessors require their own backing storage and initializer protocol.','javascript-class');continue;
      }
      definitions.push(`const ${key}: unknown = ${propertyKey(item.name,strict)};`);
      const target=isStatic?value:prototype,memberName=ts.isComputedPropertyName(item.name)?'':item.name.text;
      if(ts.isMethodDeclaration(item))definitions.push(`${op('defineMethod',target,key,functionValue(item,strict,memberName))};`);
      else if(ts.isGetAccessor(item)||ts.isSetAccessor(item))definitions.push(`${op('defineAccessor',target,key,
        ts.isGetAccessor(item)?functionValue(item,strict,'get '+memberName):'undefined',
        ts.isSetAccessor(item)?functionValue(item,strict,'set '+memberName):'undefined','false')};`);
      else if(ts.isPropertyDeclaration(item)){
        const fieldContext:FunctionContext={receiver:isStatic?value:fieldReceiver,newTarget:'undefined',strict:true};
        const fieldValue=item.initializer?namedExpression(item.initializer,fieldContext,key):'undefined';
        (isStatic?staticFields:instanceFields).push(`${op('defineField',isStatic?value:fieldReceiver,key,fieldValue)};`);
      }else report(item,'This class element has no executable source lowering.','javascript-class');
    }
    const callback=constructor?functionValue(constructor,strict,'',true):'undefined';
    let length=0;if(constructor)for(const parameter of constructor.parameters){if(parameter.dotDotDotToken||parameter.initializer)break;length++;}
    lines.push(`const ${value}: unknown = ${op('classValue',quote(name),base,String(!!heritage),callback,`(${fieldReceiver}: unknown): void => { ${instanceFields.join('\n')} }`,String(length))};`);
    if(namedKey)lines.push(`${op('namedValue',value,namedKey)};`);
    lines.push(`const ${prototype}: unknown = ${op('get',value,quote('prototype'))};`,...definitions);
    if(inner)lines.push(`${op('initialize',inner.name,value)};`);
    lines.push(...staticFields);
    if(symbol){if(previous)cells.set(symbol,previous);else cells.delete(symbol);for(const [declaration,cell]of previousDeclarations){if(cell)declarations.set(declaration,cell);else declarations.delete(declaration);}}
    return iife(lines,value);
  }
  function bind(name:ts.BindingName,value:string,output:string[],context:FunctionContext,initialize:boolean,defaultValue?:ts.Expression):void {
    if(defaultValue){const temp=fresh('__jsDefault');output.push(`const ${temp}: unknown = ${value};`);value=`${temp} === undefined ? ${expression(defaultValue,context)} : ${temp}`;}
    if(ts.isIdentifier(name)){
      const cell=cellAt(name);if(!cell){report(name,'A binding pattern has no lexical cell.');return;}
      output.push(`${op(initialize?'initialize':'write',cell.name,value)};`);return;
    }
    const capture=fresh('__jsDestructure');output.push(`const ${capture}: unknown = ${value};`);
    if(ts.isObjectBindingPattern(name)){
      const excluded:string[]=[];
      // Object destructuring performs RequireObjectCoercible even for {}.
      output.push(`${op('requireObject',capture)};`);
      for(const item of name.elements){
        if(item.dotDotDotToken){bind(item.name,op('objectRest',capture,`[${excluded.join(', ')}]`),output,context,initialize,item.initializer);continue;}
        const key=fresh('__jsDestructureKey');output.push(`const ${key}: unknown = ${item.propertyName?propertyKey(item.propertyName,context):ts.isIdentifier(item.name)?quote(item.name.text):'undefined'};`);excluded.push(key);
        bind(item.name,op('get',capture,key),output,context,initialize,item.initializer);
      }
      return;
    }
    const iterator=fresh('__jsIterator'),steps:string[]=[];output.push(`const ${iterator} = ${op('iterator',capture)};`);
    name.elements.forEach(item=>{
      if(ts.isOmittedExpression(item)){steps.push(`${op('next',iterator)};`);return;}
      bind(item.name,op(item.dotDotDotToken?'iteratorRest':'next',iterator),steps,context,initialize,item.initializer);
    });
    output.push(...iteratorScope(iterator,steps));
  }
  const jsxLiterals=new Map<string,string|undefined>();
  function jsxLiteral(node:ts.JsxText|ts.StringLiteral,attribute=false):string|undefined {
    const raw=ts.isJsxText(node)?node.text:node.getText(source),cacheKey=(attribute?'attribute:':'text:')+raw;
    if(jsxLiterals.has(cacheKey))return jsxLiterals.get(cacheKey);
    // Use TypeScript's JSX lexical conversion for entities and whitespace,
    // without transforming or executing any source expression.
    const literal=attribute?`<literal value=${raw}/>`:`<literal>${raw}</literal>`;
    const emitted=ts.transpileModule(`const value=${literal};`,{fileName:'jsx-literal.jsx',compilerOptions:{
      target:ts.ScriptTarget.ESNext,module:ts.ModuleKind.ESNext,jsx:ts.JsxEmit.ReactJSX}}).outputText;
    const parsed=ts.createSourceFile('jsx-literal.ts',emitted,ts.ScriptTarget.Latest,true);
    let result:string|undefined;
    const statement=parsed.statements.find(ts.isVariableStatement),initializer=statement?.declarationList.declarations[0]?.initializer;
    if(initializer&&ts.isCallExpression(initializer)&&initializer.arguments[1]&&ts.isObjectLiteralExpression(initializer.arguments[1])){
      const property=initializer.arguments[1].properties.find(item=>ts.isPropertyAssignment(item)
        &&(ts.isIdentifier(item.name)||ts.isStringLiteral(item.name))&&item.name.text===(attribute?'value':'children'));
      if(property&&ts.isPropertyAssignment(property)&&ts.isStringLiteral(property.initializer))result=property.initializer.text;
    }
    if(result!==undefined&&!scalarString(result))report(node,'Decoded JSX text requires a UTF-16 literal representation.','javascript-string');
    jsxLiterals.set(cacheKey,result);return result;
  }
  function jsxElement(node:ts.JsxElement|ts.JsxSelfClosingElement|ts.JsxFragment,context:FunctionContext):string {
    const binding=options.jsx;
    if(!binding){report(node,'JSX syntax requires explicitly linked JSX factory and Fragment values.','javascript-jsx');return 'undefined';}
    const fragment=ts.isJsxFragment(node),opening=ts.isJsxElement(node)?node.openingElement:!fragment?node:undefined;
    const props=fresh('__jsJsxProps'),tag=fresh('__jsJsxTag');
    let tagValue:string;
    if(fragment)tagValue=dependency(binding.fragment.name,binding.fragment.valueType);
    else if(opening&&ts.isIdentifier(opening.tagName)&&(/^[a-z]/.test(opening.tagName.text)||opening.tagName.text.includes('-')))tagValue=quote(opening.tagName.text);
    else if(opening&&ts.isJsxNamespacedName(opening.tagName)){report(opening.tagName,'Namespaced JSX tags require a qualified host tag contract.','javascript-jsx');tagValue='undefined';}
    else tagValue=expression(opening!.tagName as ts.Expression,context);
    const lines=[`const ${tag}: unknown = ${tagValue};`,`const ${props}: unknown = ${op('object')};`];
    for(const attribute of opening?.attributes.properties??[]){
      if(ts.isJsxSpreadAttribute(attribute)){lines.push(`${op('spreadObject',props,expression(attribute.expression,context))};`);continue;}
      const name=ts.isJsxNamespacedName(attribute.name)?`${attribute.name.namespace.text}:${attribute.name.name.text}`:attribute.name.text;
      const initializer=attribute.initializer;
      let value:string;
      if(!initializer)value='true';
      else if(ts.isStringLiteral(initializer))value=quote(jsxLiteral(initializer,true)??'');
      else if(ts.isJsxExpression(initializer)){
        if(!initializer.expression){report(initializer,'An explicit JSX attribute expression must contain a value.','javascript-jsx');value='undefined';}
        else value=expression(initializer.expression,context);
      }else value=expression(initializer,context);
      lines.push(`${op('define',props,quote(name),value)};`);
    }
    const children:string[]=[];
    if(ts.isJsxElement(node)||ts.isJsxFragment(node))for(const child of node.children){
      if(ts.isJsxText(child)){const value=jsxLiteral(child);if(value!==undefined)children.push(quote(value));}
      else if(ts.isJsxExpression(child)){
        if(child.dotDotDotToken)report(child,'Spread JSX children require a qualified child collection contract.','javascript-jsx');
        else if(child.expression)children.push(expression(child.expression,context));
      }else children.push(expression(child,context));
    }
    if(children.length)lines.push(`${op('define',props,quote('children'),children.length===1?children[0]!:op('array',`[${children.join(', ')}]`,String(children.length)))};`);
    const factory=children.length>1?binding.multiple:binding.factory;
    return iife(lines,op('call',dependency(factory.name,factory.valueType),'undefined',op('array',`[${tag}, ${props}]`,'2')));
  }
  function expression(node:ts.Expression,context:FunctionContext):string {
    if(ts.isParenthesizedExpression(node)||ts.isAsExpression(node)||ts.isTypeAssertionExpression(node)||ts.isNonNullExpression(node)||ts.isSatisfiesExpression(node))return `(${expression(node.expression,context)})`;
    if(ts.isIdentifier(node))return id(node,context);
    if(ts.isJsxElement(node)||ts.isJsxSelfClosingElement(node)||ts.isJsxFragment(node))return jsxElement(node,context);
    if(node.kind===ts.SyntaxKind.SuperKeyword){report(node,'Super property access requires a home-object reference and original receiver.','javascript-class');return 'undefined';}
    if(ts.isMetaProperty(node)&&node.keywordToken===ts.SyntaxKind.NewKeyword){
      if(context.newTarget===undefined){report(node,'new.target requires its lexical source function owner.','javascript-class');return 'undefined';}
      return context.newTarget;
    }
    if(ts.isAwaitExpression(node)){
      if(!context.asynchronous){report(node,'Await requires an asynchronous function owner; module and synchronous-function awaits remain unsupported.','javascript-await');return 'undefined';}
      return op('awaitValue',expression(node.expression,context));
    }
    if(ts.isStringLiteralLike(node))return quote(node.text);
    if(ts.isNumericLiteral(node))return node.text;
    if(ts.isRegularExpressionLiteral(node)){
      const end=node.text.lastIndexOf('/');
      return op('regexp',quote(node.text.slice(1,end)),quote(node.text.slice(end+1)));
    }
    if(node.kind===ts.SyntaxKind.TrueKeyword)return 'true';if(node.kind===ts.SyntaxKind.FalseKeyword)return 'false';
    if(node.kind===ts.SyntaxKind.NullKeyword)return `${nulls}.value`;
    if(node.kind===ts.SyntaxKind.ThisKeyword){
      if(options.commonJs&&!context.args)report(node,'CommonJS module this requires its original module-record receiver.','javascript-this');
      return context.receiver;
    }
    if(ts.isFunctionExpression(node)||ts.isArrowFunction(node)||ts.isClassExpression(node)){
      const parent=node.parent;
      const name=parent&&ts.isVariableDeclaration(parent)&&ts.isIdentifier(parent.name)?parent.name.text
        :parent&&(ts.isPropertyAssignment(parent)||ts.isPropertyDeclaration(parent))&&(ts.isIdentifier(parent.name)||ts.isStringLiteral(parent.name)||ts.isNumericLiteral(parent.name))?parent.name.text
          :parent&&ts.isShorthandPropertyAssignment(parent)&&parent.objectAssignmentInitializer===node?parent.name.text
          :parent&&ts.isBindingElement(parent)&&parent.initializer===node&&ts.isIdentifier(parent.name)?parent.name.text
          :parent&&ts.isBinaryExpression(parent)&&parent.operatorToken.kind===ts.SyntaxKind.EqualsToken&&ts.isIdentifier(parent.left)?parent.left.text:'';
      return ts.isClassExpression(node)?classValue(node,context,name):functionValue(node,context,name);
    }
    if(ts.isPropertyAccessExpression(node)||ts.isElementAccessExpression(node)||ts.isCallExpression(node)){
      if(ts.isCallExpression(node)&&node.expression.kind===ts.SyntaxKind.SuperKeyword){
        if(!context.constructorFrame){report(node,'Super construction requires its lexical derived constructor owner.','javascript-class');return 'undefined';}
        return op('superConstruct',context.constructorFrame,packet(node.arguments,context));
      }
      if(ts.isCallExpression(node)&&node.expression.kind===ts.SyntaxKind.ImportKeyword){report(node,'Dynamic imports require an asynchronous module owner.');return 'undefined';}
      if(ts.isCallExpression(node)&&ts.isParenthesizedExpression(node.expression)){
        let callee:ts.Expression=node.expression.expression;while(ts.isParenthesizedExpression(callee))callee=callee.expression;
        if(ts.isPropertyAccessExpression(callee)||ts.isElementAccessExpression(callee)){
          report(node,'Parenthesized member calls require a reference-preserving chain boundary.','javascript-reference');return 'undefined';
        }
      }
      return chain(node,context);
    }
    if(ts.isConditionalExpression(node))return `(${op('truthy',expression(node.condition,context))} ? ${expression(node.whenTrue,context)} : ${expression(node.whenFalse,context)})`;
    if(ts.isBinaryExpression(node)){
      const operator=ts.tokenToString(node.operatorToken.kind)!;
      if(node.operatorToken.kind===ts.SyntaxKind.CommaToken)return iife([`${expression(node.left,context)};`],expression(node.right,context));
      if(['&&','||','??'].includes(operator))return logical(operator,expression(node.left,context),()=>expression(node.right,context));
      if(node.operatorToken.kind===ts.SyntaxKind.EqualsToken&&pattern(node.left)){
        const input=fresh('__jsAssignmentValue'),lines=[`const ${input}: unknown = ${expression(node.right,context)};`];
        assign(node.left,()=>input,lines,context);return iife(lines,input);
      }
      if(node.operatorToken.kind>=ts.SyntaxKind.FirstAssignment&&node.operatorToken.kind<=ts.SyntaxKind.LastAssignment)
        return reference(node.left,context,(get,set)=>operator==='='?set(expression(node.right,context))
          :['&&=','||=','??='].includes(operator)?logical(operator.slice(0,-1),get,()=>set(expression(node.right,context)))
            :set(op('binary',quote(operator.slice(0,-1)),get,expression(node.right,context))));
      return op('binary',quote(operator),expression(node.left,context),expression(node.right,context));
    }
    if(ts.isPrefixUnaryExpression(node)||ts.isPostfixUnaryExpression(node)){
      const operator=ts.tokenToString(node.operator)!;
      if(operator==='++'||operator==='--')return reference(node.operand,context,(get,set)=>{
        const before=fresh('__jsBefore'),after=fresh('__jsAfter');
        return iife([`const ${before}: unknown = ${op('unary',quote('numeric'),get)};`,`const ${after}: unknown = ${op('unary',quote(operator),before)};`,`${set(after)};`],ts.isPostfixUnaryExpression(node)?before:after);
      });
      return op('unary',quote(operator),expression(node.operand,context));
    }
    if(ts.isTypeOfExpression(node)){
      if(ts.isIdentifier(node.expression)&&!symbolAt(node.expression)&&!globals.has(node.expression.text))return quote('undefined');
      return op('unary',quote('typeof'),expression(node.expression,context));
    }
    if(ts.isVoidExpression(node))return iife([`${expression(node.expression,context)};`],'undefined');
    if(ts.isDeleteExpression(node)){
      const target=node.expression;
      if(ts.isOptionalChain(target)){report(node,'Optional deletion requires an optional reference completion plan.');return 'undefined';}
      if(ts.isPropertyAccessExpression(target)||ts.isElementAccessExpression(target))return op('remove',expression(target.expression,context),ts.isPropertyAccessExpression(target)?quote(target.name.text):expression(target.argumentExpression,context));
      report(node,'Deleting a lexical binding is invalid in strict JavaScript.');return 'undefined';
    }
    if(ts.isArrayLiteralExpression(node)){
      if(!node.elements.some(ts.isSpreadElement))return op('array',`[${node.elements.map(item=>ts.isOmittedExpression(item)?'undefined':expression(item,context)).join(', ')}]`,String(node.elements.length),`[${node.elements.flatMap((item,index)=>ts.isOmittedExpression(item)?[index]:[]).join(', ')}]`);
      const array=fresh('__jsArray'),lines=[`const ${array} = ${op('array','[]','0')};`];
      for(const item of node.elements)lines.push(`${ts.isOmittedExpression(item)?op('arrayHole',array):op(ts.isSpreadElement(item)?'arraySpread':'arrayPush',array,expression(ts.isSpreadElement(item)?item.expression:item,context))};`);
      return iife(lines,array);
    }
    if(ts.isObjectLiteralExpression(node)){
      const object=fresh('__jsObject'),lines=[`const ${object}: unknown = ${op('object')};`];
      for(const item of node.properties){
        if(ts.isSpreadAssignment(item)){lines.push(`${op('spreadObject',object,expression(item.expression,context))};`);continue;}
        if(ts.isPropertyAssignment(item)){
          const key=fresh('__jsObjectKey');lines.push(`const ${key}: unknown = ${propertyKey(item.name,context)};`);
          const proto=!ts.isComputedPropertyName(item.name)&&(ts.isIdentifier(item.name)||ts.isStringLiteral(item.name))&&item.name.text==='__proto__';
          const value=namedExpression(item.initializer,context,proto?undefined:key);
          if(proto){
            const prototype=fresh('__jsPrototype');lines.push(`const ${prototype}: unknown = ${value};`);
            const type=op('unary',quote('typeof'),prototype);
            lines.push(`if (${op('truthy',op('binary',quote('==='),type,quote('object')))} || ${op('truthy',op('binary',quote('==='),type,quote('function')))}) ${op('setPrototype',object,prototype)};`);
          }
          else lines.push(`${op('define',object,key,value)};`);
        }else if(ts.isShorthandPropertyAssignment(item))lines.push(`${op('define',object,quote(item.name.text),id(item.name,context))};`);
        else if(ts.isMethodDeclaration(item)){
          const key=fresh('__jsMethodKey');lines.push(`const ${key}: unknown = ${propertyKey(item.name,context)};`,
            `${op('define',object,key,op('namedValue',functionValue(item,context),key))};`);
        }
        else if(ts.isGetAccessor(item)||ts.isSetAccessor(item))lines.push(`${op('defineAccessor',object,propertyKey(item.name,context),
          ts.isGetAccessor(item)?functionValue(item,context,'get '+(ts.isComputedPropertyName(item.name)?'':item.name.text)):'undefined',
          ts.isSetAccessor(item)?functionValue(item,context,'set '+(ts.isComputedPropertyName(item.name)?'':item.name.text)):'undefined','true')};`);
        else report(item,'Object accessor definitions need a checked source descriptor operation.');
      }
      return iife(lines,object);
    }
    if(ts.isTemplateExpression(node)){
      let value=quote(node.head.text);
      for(const span of node.templateSpans)value=op('binary',quote('+'),op('binary',quote('+'),value,expression(span.expression,context)),quote(span.literal.text));
      return value;
    }
    if(ts.isNewExpression(node))return op('construct',expression(node.expression,context),packet(node.arguments??[],context));
    report(node,`Unsupported JavaScript expression ${ts.SyntaxKind[node.kind]}.`);return 'undefined';
  }
  function declarationKind(list:ts.VariableDeclarationList):Cell['kind'] {return list.flags&ts.NodeFlags.Const?'const':list.flags&ts.NodeFlags.Let?'let':'var';}
  function variable(list:ts.VariableDeclarationList,context:FunctionContext):string {
    const output:string[]=[],kind=declarationKind(list);
    for(const item of list.declarations){
      if(kind==='var'&&!item.initializer)continue;
      bind(item.name,item.initializer?expression(item.initializer,context):'undefined',output,context,kind!=='var');
    }
    return output.join('\n');
  }
  function statement(node:ts.Statement,context:FunctionContext):string {
    if(ts.isBlock(node))return `{\n${block(node.statements,context)}\n}`;
    if(ts.isEmptyStatement(node)||ts.isImportDeclaration(node)||ts.isExportDeclaration(node)||ts.isInterfaceDeclaration(node)||ts.isTypeAliasDeclaration(node)||ts.isFunctionDeclaration(node))return '';
    if(ts.isVariableStatement(node))return variable(node.declarationList,context);
    if(ts.isClassDeclaration(node)){
      if(!node.name){report(node,'Anonymous default class declarations require export normalization.','javascript-class');return '';}
      const cell=cellAt(node.name);
      if(!cell){report(node,'A class declaration requires its lexical binding owner.','javascript-class');return '';}
      return `${op('initialize',cell.name,classValue(node,context))};`;
    }
    if(ts.isExpressionStatement(node))return ts.isStringLiteral(node.expression)?'':`${expression(node.expression,context)};`;
    if(ts.isReturnStatement(node))return `return ${node.expression?expression(node.expression,context):'undefined'};`;
    if(ts.isIfStatement(node))return `if (${op('truthy',expression(node.expression,context))}) ${body(node.thenStatement,context)}${node.elseStatement?` else ${body(node.elseStatement,context)}`:''}`;
    if(ts.isWhileStatement(node))return `while (${op('truthy',expression(node.expression,context))}) ${body(node.statement,{...context,switchBreak:undefined})}`;
    if(ts.isDoStatement(node))return `do ${body(node.statement,{...context,switchBreak:undefined})} while (${op('truthy',expression(node.expression,context))});`;
    if(ts.isForStatement(node)){
      const loopContext={...context,switchBreak:undefined};
      if(node.initializer&&ts.isVariableDeclarationList(node.initializer)&&declarationKind(node.initializer)!=='var'){
        const list=node.initializer,kind=declarationKind(list),prologue:string[]=[],bound:ts.Identifier[]=[];
        const names=(name:ts.BindingName):void=>{if(ts.isIdentifier(name))bound.push(name);else for(const item of name.elements)if(ts.isBindingElement(item))names(item.name);};
        for(const declaration of list.declarations){allocate(declaration.name,kind,prologue);names(declaration.name);}
        prologue.push(variable(list,context));
        if(kind==='const')return `{ ${prologue.join('\n')} for (; ${node.condition?op('truthy',expression(node.condition,context)):'true'}; ${node.incrementor?expression(node.incrementor,context):''}) ${body(node.statement,loopContext)} }`;
        // Each let iteration gets a fresh environment, including the first
        // condition and the next iteration's update. Initializer closures keep
        // their original environment. finally carries values across continue,
        // while native completion preserves break/return/throw overrides.
        const first=fresh('__jsFirstIteration'),iteration:string[]=[],save:string[]=[];
        for(const name of bound){
          const previous=cellAt(name)!;const state=fresh('__jsIterationState');
          prologue.push(`let ${state}: unknown = ${op('read',previous.name)};`);
          const cell:Cell={name:fresh('__js_'+name.text),kind:'let'},symbol=checker.getSymbolAtLocation(name)!;
          cells.set(symbol,cell);for(const declaration of symbol.declarations??[])declarations.set(declaration,cell);
          iteration.push(`const ${cell.name} = ${op('binding',quote('let'),quote(name.text))};`,`${op('initialize',cell.name,state)};`);
          save.push(`${state} = ${op('read',cell.name)};`);
        }
        prologue.push(`let ${first} = true;`);
        if(node.incrementor)iteration.push(`if (!${first}) { ${expression(node.incrementor,context)}; }`);
        if(node.condition)iteration.push(`if (!${op('truthy',expression(node.condition,context))}) break;`);
        iteration.push(`try ${body(node.statement,loopContext)} finally { ${save.join('\n')} ${first} = false; }`);
        return `{ ${prologue.join('\n')} while (true) { ${iteration.join('\n')} } }`;
      }
      const init=node.initializer?ts.isVariableDeclarationList(node.initializer)?variable(node.initializer,context):`${expression(node.initializer,context)};`:'';
      return `{ ${init} for (; ${node.condition?op('truthy',expression(node.condition,context)):'true'}; ${node.incrementor?expression(node.incrementor,context):''}) ${body(node.statement,loopContext)} }`;
    }
    if(ts.isForInStatement(node)||ts.isForOfStatement(node)){
      if(ts.isForOfStatement(node)&&node.awaitModifier){report(node,'Asynchronous iteration requires an asynchronous iterator owner.');return '';}
      const value=fresh('__jsIteration'),prologue:string[]=[];
      if(ts.isVariableDeclarationList(node.initializer)){
        const declaration=node.initializer.declarations[0]!,kind=declarationKind(node.initializer);
        if(kind!=='var')allocate(declaration.name,kind,prologue);
        bind(declaration.name,value,prologue,context,kind!=='var',declaration.initializer);
      }else assign(node.initializer,()=>value,prologue,context);
      const iterable=op(ts.isForInStatement(node)?'keys':'iterable',expression(node.expression,context));
      return `for (const ${value} of ${iterable}) { ${prologue.join('\n')} ${statement(node.statement,{...context,switchBreak:undefined})} }`;
    }
    if(ts.isSwitchStatement(node)){
      const discriminant=fresh('__jsDiscriminant'),selected=fresh('__jsCase'),completion=fresh('__jsSwitchBreak'),caught=fresh('__jsSwitchCaught');
      const clauses=node.caseBlock.clauses,defaultIndex=clauses.findIndex(ts.isDefaultClause);
      const prefix=[`const ${discriminant}: unknown = ${expression(node.expression,context)};`];
      const switchContext={...context,switchBreak:completion,switchCompletions:[...(context.switchCompletions??[]),completion]};
      // CaseBlock is one lexical scope. Initialize its functions and TDZ cells
      // before evaluating case expressions, after the discriminant.
      const statements=clauses.flatMap(clause=>[...clause.statements]);
      prefix.push(...scope(statements,switchContext));
      prefix.push(`let ${selected} = -1;`,`const ${completion} = {};`);
      clauses.forEach((clause,index)=>{if(ts.isCaseClause(clause))prefix.push(`if (${selected} === -1 && ${op('truthy',op('binary',quote('==='),discriminant,expression(clause.expression,switchContext)))}) ${selected} = ${index};`);});
      prefix.push(`if (${selected} === -1) ${selected} = ${defaultIndex<0?clauses.length:defaultIndex};`);
      const bodies=clauses.map((clause,index)=>`if (${selected} <= ${index}) { ${clause.statements.map(item=>statement(item,switchContext)).join('\n')} }`).join('\n');
      prefix.push(`try { ${bodies} } catch (${caught}) { if (${caught} !== ${completion}) throw ${caught}; }`);
      return `{ ${prefix.join('\n')} }`;
    }
    if(ts.isBreakStatement(node)||ts.isContinueStatement(node)){
      if(node.label){report(node,'Labeled JavaScript completion needs a label owner.');return '';}
      return ts.isBreakStatement(node)?context.switchBreak?`throw ${context.switchBreak};`:'break;':'continue;';
    }
    if(ts.isThrowStatement(node)){
      return `throw ${op('wrapThrown',expression(node.expression,context))};`;
    }
    if(ts.isTryStatement(node)){
      let handler='';
      if(node.catchClause){
        const error=fresh('__jsCaught'),prefix:string[]=[];
        for(const completion of context.switchCompletions??[])prefix.push(`if (${error} === ${completion}) throw ${error};`);
        if(node.catchClause.variableDeclaration){allocate(node.catchClause.variableDeclaration.name,'let',prefix);bind(node.catchClause.variableDeclaration.name,op('caught',error),prefix,context,true);}
        handler=` catch (${error}) { ${prefix.join('\n')} ${block(node.catchClause.block.statements,context)} }`;
      }
      return `try ${statement(node.tryBlock,context)}${handler}${node.finallyBlock?` finally ${statement(node.finallyBlock,context)}`:''}`;
    }
    if(ts.isExportAssignment(node)){report(node,'Export assignment must be normalized by the source module linker.');return '';}
    report(node,`Unsupported JavaScript statement ${ts.SyntaxKind[node.kind]}.`);return '';
  }
  function body(node:ts.Statement,context:FunctionContext):string{return ts.isBlock(node)?statement(node,context):`{ ${statement(node,context)} }`;}
  function scope(statements:readonly ts.Statement[],context:FunctionContext,functionScope=false,initial:readonly string[]=[]):string[] {
    const prologue:string[]=[...initial];
    if(functionScope){
      const vars=(node:ts.Node)=>{
        if(ts.isFunctionLike(node))return;
        if(ts.isVariableDeclarationList(node)&&declarationKind(node)==='var')for(const item of node.declarations)allocate(item.name,'var',prologue);
        ts.forEachChild(node,vars);
      };
      for(const item of statements)vars(item);
    }
    for(const item of statements){
      if(ts.isVariableStatement(item)&&declarationKind(item.declarationList)!=='var')for(const declaration of item.declarationList.declarations)allocate(declaration.name,declarationKind(item.declarationList),prologue);
      if(ts.isFunctionDeclaration(item)&&item.name)allocate(item.name,'let',prologue);
      if(ts.isClassDeclaration(item)&&item.name)allocate(item.name,'let',prologue);
    }
    for(const item of statements)if(ts.isFunctionDeclaration(item)&&item.name&&item.body){
      const cell=cellAt(item.name);if(cell)prologue.push(`${op('initialize',cell.name,functionValue(item,context))};`);
    }
    return prologue;
  }
  function block(statements:readonly ts.Statement[],context:FunctionContext,functionScope=false,initial:readonly string[]=[]):string {
    return [...scope(statements,context,functionScope,initial),...statements.map(item=>statement(item,context))].filter(Boolean).join('\n');
  }
  const context:FunctionContext={receiver:'undefined',strict:options.strict};
  const bodyText=block(source.statements,context,true);
  const moduleSymbol=checker.getSymbolAtLocation(source);
  const publicBindings=new Set<ts.Symbol>();
  for(const item of moduleSymbol?checker.getExportsOfModule(moduleSymbol):[]){
    if(item.declarations?.some(declaration=>ts.isExportSpecifier(declaration)&&(declaration.isTypeOnly||declaration.parent.parent.isTypeOnly)))continue;
    const target=item.flags&ts.SymbolFlags.Alias?checker.getAliasedSymbol(item):item;
    if(target.declarations?.some(declaration=>declaration.getSourceFile()===source))publicBindings.add(target);
  }
  const written=(node:ts.Node):void=>{
    if(ts.isIdentifier(node)){
      const symbol=symbolAt(node);
      const classDeclaration=symbol?.declarations?.find(ts.isClassDeclaration);
      let innerClassName=false;
      if(classDeclaration)for(let owner:ts.Node|undefined=node.parent;owner;owner=owner.parent)if(owner===classDeclaration){innerClassName=true;break;}
      if(symbol&&publicBindings.has(symbol)&&!innerClassName)report(node,'A mutated exported binding requires a live module namespace; this factory exposes a snapshot.','javascript-live-binding');
    }else if(ts.isParenthesizedExpression(node)||ts.isAsExpression(node)||ts.isNonNullExpression(node)||ts.isSpreadElement(node))written(node.expression);
    else if(ts.isArrayLiteralExpression(node))node.elements.forEach(written);
    else if(ts.isObjectLiteralExpression(node))for(const item of node.properties){
      if(ts.isPropertyAssignment(item))written(item.initializer);
      else if(ts.isShorthandPropertyAssignment(item))written(item.name);
      else if(ts.isSpreadAssignment(item))written(item.expression);
    }
  };
  const writes=(node:ts.Node):void=>{
    if(ts.isBinaryExpression(node)&&node.operatorToken.kind>=ts.SyntaxKind.FirstAssignment&&node.operatorToken.kind<=ts.SyntaxKind.LastAssignment)written(node.left);
    else if((ts.isPrefixUnaryExpression(node)||ts.isPostfixUnaryExpression(node))&&(node.operator===ts.SyntaxKind.PlusPlusToken||node.operator===ts.SyntaxKind.MinusMinusToken))written(node.operand);
    else if((ts.isForInStatement(node)||ts.isForOfStatement(node))&&!ts.isVariableDeclarationList(node.initializer))written(node.initializer);
    ts.forEachChild(node,writes);
  };writes(source);
  for(const item of moduleSymbol?checker.getExportsOfModule(moduleSymbol):[]){
    if(item.declarations?.some(declaration=>ts.isExportSpecifier(declaration)
      &&(declaration.isTypeOnly||declaration.parent.parent.isTypeOnly)))continue;
    const alias=item.flags&ts.SymbolFlags.Alias?checker.getAliasedSymbol(item):item;
    if(!(alias.flags&ts.SymbolFlags.Value))continue;
    const declaration=item.declarations?.find(ts.isExportSpecifier);
    const local=declaration&&(declaration.propertyName??declaration.name);
    const owned=declaration?checker.getExportSpecifierLocalTargetSymbol(declaration):alias;
    const cell=owned&&(cells.get(owned)??owned.declarations?.map(declaration=>declarations.get(declaration)).find(Boolean));
    const imported=owned&&imports.get(owned);
    if(cell)exported.set(item.name,op('read',cell.name));else if(imported)exported.set(item.name,imported);
    else report(item.declarations?.[0]??source,`No executable value for JavaScript export ${item.name}.`,'javascript-export');
  }
  const exportsValue=fresh('__jsExports'),footer=[`const ${exportsValue}: unknown = ${op('object')};`,
    ...[...exported].map(([name,value])=>`${op('define',exportsValue,quote(name),value)};`),`return ${exportsValue};`].join('\n');
  const providers=[options.operations,options.nulls];
  const providerShape=providers.map(binding=>`readonly ${quote(binding.name)}: ${nativeType(binding.valueType)};`).join('\n');
  const fieldsText=[...fields].map(([name,type])=>`readonly ${quote(name)}: ${nativeType(type)};`).join('\n');
  const publishedType=options.declarationInterop==='commonjs-namespace'
    ?'typeof __JsPublished & { readonly default: typeof __JsPublished }'
    :options.declarationInterop==='commonjs-export-equals'
      ?'{ readonly [K in keyof typeof __JsPublished]: (typeof __JsPublished)[K] } & { readonly default: typeof __JsPublished }'
      :'typeof __JsPublished';
  const publicType=options.declarationModule?publishedType:`{ ${[...exported.keys()].map(name=>`readonly ${quote(name)}: unknown;`).join(' ')} }`;
  const publicImport=options.declarationModule?`import type ${options.declarationInterop==='commonjs-export-equals'?'__JsPublished':'* as __JsPublished'} from ${quote(options.declarationModule)};\n`:'';
  const runtimeType=options.runtimeExportsType;
  const runtimeShape=runtimeType?`export type ${runtimeType} = (${publicType}) & { readonly [K in ${[...exported.keys()].map(name=>quote(name)).join(' | ')||'never'}]: K extends keyof (${publicType}) ? (${publicType})[K] : unknown };\n`:'';
  const factory=runtimeType?'createRuntime':'create';
  const publicFactory=runtimeType?`\nexport function create(${dependencies}: Dependencies): ${publicType};\nexport function create(${dependencies}: Dependencies): unknown { return createRuntime(${dependencies}); }\n`:'';
  const output=`// Compiled from actual JavaScript ${quote(options.filename)}. Public declarations are a trusted ABI, not an implementation type proof.\n${publicImport}${[...nativeTypes.values()].map(type=>type.name==='*'?`import type * as ${type.alias} from ${quote(type.module)};`:`import type { ${type.name} as ${type.alias} } from ${quote(type.module)};`).join('\n')}
export interface Dependencies { readonly ${quote(contextName)}: { ${providerShape} }; ${fieldsText} }
${runtimeShape}export function ${factory}(${dependencies}: Dependencies): ${runtimeType??publicType};
export function ${factory}(${dependencies}: Dependencies): unknown {
const ${operations} = ${dependencies}[${quote(contextName)}][${quote(options.operations.name)}];
const ${nulls} = ${dependencies}[${quote(contextName)}][${quote(options.nulls.name)}];
${bodyText}\n${footer}\n}${publicFactory}
`;
  return {diagnostics,...(diagnostics.length?{}:{source:output}),runtimeExports:Object.freeze([...exported.keys()]),sourceValueContext:{name:contextName,bindings:providers}};
}
