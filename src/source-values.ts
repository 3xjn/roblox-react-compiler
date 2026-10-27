import ts from 'typescript';
import type {GlobalBinding,ValueTypeBinding} from './index.ts';
import {createArrayLowering} from './data-arrays.ts';
import {createFunctionLowering} from './data-functions.ts';
import {createNullLowering} from './data-nulls.ts';
import type {SourceFunction} from './helper-types.ts';
import {stringCall,validStringArguments} from './string-methods.ts';
import {lowerOptionalChain} from './call-proof.ts';

export interface SourceValueOptions {
  /** ECMAScript primitive-number formatting, including explicit radix. */
  readonly numberStrings?:Pick<GlobalBinding,'name'|'valueType'>;
  readonly classChecks?:Pick<GlobalBinding,'name'|'valueType'>;
  readonly strings?:Pick<GlobalBinding,'name'|'valueType'>;
  /** Source length/slot presence and length-aware argument operations. */
  readonly arrays?:Pick<GlobalBinding,'name'|'valueType'>;
  /** Native function metadata and checked callable values. */
  readonly functions?:Pick<GlobalBinding,'name'|'valueType'>;
  /** Distinct source null with source truthiness and native narrowing. */
  readonly nulls?:Pick<GlobalBinding,'name'|'valueType'>;
  /** Ordered ordinary own data properties, including explicit undefined. */
  readonly records?:Pick<GlobalBinding,'name'|'valueType'>;
  readonly forInKeys?:Pick<GlobalBinding,'name'|'valueType'>;
  readonly propertyHas?:Pick<GlobalBinding,'name'|'valueType'>;
  readonly objectMethods?:Pick<GlobalBinding,'name'|'valueType'>;
  readonly dynamicProperties?:Pick<GlobalBinding,'name'|'valueType'>;
}
export function createSourceValues(options:SourceValueOptions,context:{
  readonly checker:ts.TypeChecker;
  readonly program?:ts.Program;
  readonly report:(node:ts.Node,code:string,message:string)=>void;
  readonly global:(symbol:ts.Symbol|undefined)=>boolean;
  readonly provider:(binding:Pick<GlobalBinding,'name'|'valueType'>,base:string)=>ts.Identifier;
  readonly nativeType:(binding:ValueTypeBinding)=>ts.TypeNode;
  readonly projectFunctionType?:(fn:SourceFunction)=>ts.FunctionTypeNode|undefined;
  readonly dynamicSource?:boolean;
  readonly sourceStrict?:boolean;
}) {
  const numeric=(value:ts.Expression,nullable:boolean):boolean=>{
    const seen=new Set<ts.Type>();
    const test=(type:ts.Type):boolean=>{
      if(seen.has(type))return false;seen.add(type);
      if(type.isUnion())return type.types.every(member=>nullable&&!!(member.flags&(ts.TypeFlags.Null|ts.TypeFlags.Undefined))||test(member));
      const constraint=context.checker.getBaseConstraintOfType(type);
      return !!(type.flags&ts.TypeFlags.NumberLike)||!!constraint&&constraint!==type&&test(constraint);
    };
    return test(context.checker.getTypeAtLocation(ts.getOriginalNode(value)));
  };
  const numbers=options.numberStrings&&{
    visit(node:ts.Node,visit:ts.Visitor):ts.VisitResult<ts.Node>|undefined{
      if(!ts.isCallExpression(node))return undefined;
      const member=node.expression;
      if(!(ts.isPropertyAccessExpression(member)&&member.name.text==='toString'
        ||ts.isElementAccessExpression(member)&&ts.isStringLiteral(member.argumentExpression)&&member.argumentExpression.text==='toString'))return undefined;
      const optional=!!member.questionDotToken;
      if(!numeric(member.expression,optional))return undefined;
      if(node.arguments.length>1||node.arguments.some(ts.isSpreadElement)||node.typeArguments?.length){
        context.report(node,'number-string-arguments','Numeric toString accepts zero or one ordinary radix argument.');return node;
      }
      const f=ts.factory,radix=node.arguments[0]?ts.visitNode(node.arguments[0],visit) as ts.Expression:f.createVoidZero();
      return f.createCallExpression(f.createPropertyAccessExpression(context.provider(options.numberStrings!,'__numberStrings'),optional?'optionalToString':'toString'),undefined,
        [ts.visitNode(member.expression,visit) as ts.Expression,optional?
          f.createArrowFunction(undefined,undefined,[],undefined,f.createToken(ts.SyntaxKind.EqualsGreaterThanToken),radix):radix]);
    },
  };
  const classChecks=options.classChecks&&{
    visit(node:ts.Node,visit:ts.Visitor):ts.VisitResult<ts.Node>|undefined{
      if(!ts.isBinaryExpression(node)||node.operatorToken.kind!==ts.SyntaxKind.InstanceOfKeyword)return undefined;
      return ts.factory.createCallExpression(ts.factory.createPropertyAccessExpression(context.provider(options.classChecks!,'__classChecks'),'instanceOf'),undefined,
        [ts.visitNode(node.left,visit) as ts.Expression,ts.visitNode(node.right,visit) as ts.Expression]);
    },
  };
  const strings=options.strings&&{
    visit(node:ts.Node,visit:ts.Visitor):ts.VisitResult<ts.Node>|undefined{
      if(!ts.isCallExpression(node))return undefined;
      const target=stringCall(node,context.checker);if(!target)return undefined;
      if(!validStringArguments(node,target)){
        context.report(node,'string-method-call','Primitive string methods require ordinary arguments and a direct nonoptional string receiver.');return node;
      }
      return ts.factory.createCallExpression(ts.factory.createPropertyAccessExpression(context.provider(options.strings!,'__sourceStrings'),target.method),undefined,
        [ts.visitNode(target.receiver,visit) as ts.Expression,...node.arguments.map(argument=>ts.visitNode(argument,visit) as ts.Expression)]);
    },
  };
  const opaqueReceiver=(value:ts.Expression)=>{
    const original=ts.getOriginalNode(value);
    return context.dynamicSource&&original.pos>=0&&!!original.parent&&!!(context.checker.getTypeAtLocation(original).flags
      &(ts.TypeFlags.Any|ts.TypeFlags.Unknown|ts.TypeFlags.Never));
  };
  const readTarget=(options.objectMethods||options.dynamicProperties)&&((owner:ts.Expression,callee:ts.Expression,expression?:(value:ts.Expression)=>ts.Expression):ts.Expression|undefined=>{
    while(ts.isParenthesizedExpression(callee)||ts.isAsExpression(callee)||ts.isNonNullExpression(callee))callee=callee.expression;
    if(options.dynamicProperties&&(ts.isPropertyAccessExpression(callee)||ts.isElementAccessExpression(callee))&&opaqueReceiver(callee.expression)){
      if(ts.isPropertyAccessExpression(callee)&&ts.isPrivateIdentifier(callee.name))return undefined;
      const key=ts.isPropertyAccessExpression(callee)?ts.factory.createStringLiteral(callee.name.text)
        :expression?expression(callee.argumentExpression):callee.argumentExpression;
      return ts.factory.createCallExpression(context.provider(options.dynamicProperties,'__readProperty'),undefined,[owner,key]);
    }
    if(!options.objectMethods)return undefined;
    if(!ts.isPropertyAccessExpression(callee)||callee.name.text!=='hasOwnProperty')return undefined;
    const symbol=context.checker.getSymbolAtLocation(callee.name);
    if(!symbol?.declarations?.length||!symbol.declarations.every(declaration=>{
      const source=declaration.getSourceFile();
      return source.isDeclarationFile&&source.hasNoDefaultLib&&/(?:^|[/\\])lib\.[^/\\]+\.d\.ts$/.test(source.fileName);
    }))return undefined;
    return ts.factory.createCallExpression(ts.factory.createPropertyAccessExpression(
      context.provider(options.objectMethods!,'__objectMethods'),'hasOwnMethod'),undefined,[owner]);
  });
  const reads=options.dynamicProperties&&context.dynamicSource?{
    visit(node:ts.Node,visit:ts.Visitor):ts.VisitResult<ts.Node>|undefined{
      if(!(ts.isPropertyAccessExpression(node)||ts.isElementAccessExpression(node))||!opaqueReceiver(node.expression))return undefined;
      const expression=(value:ts.Expression)=>ts.visitNode(value,visit) as ts.Expression;
      const parent=node.parent;
      if(parent&&(ts.isBinaryExpression(parent)&&parent.left===node&&parent.operatorToken.kind>=ts.SyntaxKind.FirstAssignment&&parent.operatorToken.kind<=ts.SyntaxKind.LastAssignment
        ||(ts.isPostfixUnaryExpression(parent)||ts.isPrefixUnaryExpression(parent))&&parent.operand===node
        ||ts.isDeleteExpression(parent))){
        // This capability owns reads only. Preserve the original write for
        // native type checking rather than turn its target into a read call.
        return node;
      }
      if(ts.isOptionalChain(node)){
        if(!options.functions){
          context.report(node,'dynamic-property-optional','Optional opaque reads require the function-reference capability.');return node;
        }
        return lowerOptionalChain(node,{checker:context.checker,
          helper:context.provider(options.functions,'__functions'),expression,arrays:!!options.arrays,...(readTarget?{readTarget}:{})});
      }
      return readTarget?.(expression(node.expression),node,expression);
    },
  }:undefined;
  const arrays=options.arrays&&createArrayLowering({checker:context.checker,report:context.report,
    ...(context.program?{program:context.program}:{}),
    ...(context.sourceStrict!==undefined?{sourceStrict:context.sourceStrict}:{}),
    ...(readTarget?{readTarget}:{}),
    uncheckedFunctions:options.functions!==undefined,
    ...(options.functions?{functionHelper:()=>context.provider(options.functions!,'__functions')}:{ }),
    helper:()=>context.provider(options.arrays!,'__arrays').text});
  const functions=options.functions&&createFunctionLowering({checker:context.checker,report:context.report,
    ...(readTarget?{readTarget}:{}),
    arrayCalls:options.arrays!==undefined,
    ...(options.arrays?{arrayHelper:()=>context.provider(options.arrays!,'__arrays')}:{ }),
    ...(context.projectFunctionType?{projectFunctionType:context.projectFunctionType}:{}),
    helper:()=>context.provider(options.functions!,'__functions')});
  const nulls=options.nulls&&createNullLowering({checker:context.checker,report:context.report,global:context.global,
    functionCalls:options.functions!==undefined,
    helper:()=>context.provider(options.nulls!,'__nulls'),type:()=>context.nativeType(options.nulls!.valueType)});
  let traversals=0;
  const keys=options.forInKeys&&{
    stats:()=>traversals,
    visit(node:ts.Node,visit:ts.Visitor):ts.VisitResult<ts.Node>|undefined {
      if(!ts.isForInStatement(node))return undefined;
      traversals++;
      return ts.factory.createForOfStatement(undefined,ts.visitNode(node.initializer,visit) as ts.ForInitializer,
        ts.factory.createCallExpression(context.provider(options.forInKeys!,'__enumerateKeys'),undefined,[ts.visitNode(node.expression,visit) as ts.Expression]),
        ts.visitNode(node.statement,visit) as ts.Statement);
    },
  };
  const properties=options.propertyHas&&{
    visit(node:ts.Node,visit:ts.Visitor):ts.VisitResult<ts.Node>|undefined {
      if(!ts.isBinaryExpression(node)||node.operatorToken.kind!==ts.SyntaxKind.InKeyword)return undefined;
      return ts.factory.createCallExpression(context.provider(options.propertyHas!,'__hasProperty'),undefined,
        [ts.visitNode(node.left,visit) as ts.Expression,ts.visitNode(node.right,visit) as ts.Expression]);
    },
  };
  return {arrays,functions,nulls,keys,properties,numbers,classChecks,strings,reads};
}
