import path from 'node:path';
import ts from 'typescript';
import type {DataTypeBinding} from './data-module.ts';

/** Copy published type declarations, never package implementations. Relative
 * type imports are linked into the output graph, so signatures remain portable
 * and retain recursive aliases, overloads, namespaces and conditional types. */
export function createDeclarationBundle(options:ts.CompilerOptions,host:ts.ModuleResolutionHost,types:readonly DataTypeBinding[]=[]){
  const files=new Map<string,{filename:string;source:string}>();
  const ids=new Map<string,string>();
  const diagnostics:{filename:string;line:number;column:number;code:string;message:string}[]=[];
  const manifests=new Map<string,string>();
  const canonical=(name:string)=>path.resolve(name).replaceAll('\\','/');
  const resolverHost:ts.ModuleResolutionHost={...host,readFile:name=>{
    const text=host.readFile(name);if(text!==undefined&&path.basename(name)==='package.json')manifests.set(canonical(name),text);return text;
  }};
  const cache=ts.createModuleResolutionCache(host.getCurrentDirectory?.()??process.cwd(),canonical,options);
  function add(filename:string):string{
    const absolute=canonical(filename),previous=ids.get(absolute);
    if(previous)return previous;
    const id=`d${ids.size}`;
    ids.set(absolute,id);
    const text=host.readFile(filename);
    if(text===undefined){diagnostics.push({filename:absolute,line:1,column:1,code:'declaration-source',message:'Published declaration could not be read.'});return id;}
    const source=ts.createSourceFile(filename,text,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
    const f=ts.factory;
    const nativeImports=new Map<string,string>();
    const boundReact=types.some(type=>type.module==='react'&&type.name==='*');
    const reactNames=new Set<string>();
    for(const statement of source.statements)if(ts.isImportDeclaration(statement)&&ts.isStringLiteral(statement.moduleSpecifier)
      &&statement.moduleSpecifier.text==='react'&&statement.importClause){
      const clause=statement.importClause;
      if(clause.name)reactNames.add(clause.name.text);
      if(clause.namedBindings&&ts.isNamespaceImport(clause.namedBindings))reactNames.add(clause.namedBindings.name.text);
    }
    const reference=(module:string,name:string,args?:readonly ts.TypeNode[])=>{
      let alias=nativeImports.get(module);
      if(!alias){alias=`__NativeDeclaration${nativeImports.size}`;nativeImports.set(module,alias);}
      return f.createTypeReferenceNode(f.createQualifiedName(f.createIdentifier(alias),name),args);
    };
    const nativeType=(name:string,args?:readonly ts.TypeNode[])=>{
      const binding=types.find(type=>type.module===undefined&&!type.local&&type.name===name);
      return binding&&reference(binding.target.module,binding.target.name,args);
    };
    function specifier(value:ts.Expression):ts.Expression{
      if(!ts.isStringLiteral(value))return value;
      const platform=types.find(type=>type.module===value.text&&type.name==='*');
      if(platform)return f.createStringLiteral(platform.target.module);
      const resolved=ts.resolveModuleName(value.text,absolute,options,resolverHost,cache).resolvedModule;
      if(resolved&&/\.d\.[cm]?ts$/.test(resolved.resolvedFileName))return f.createStringLiteral(`./${add(resolved.resolvedFileName)}`);
      // An external type-only package remains a real TypeScript dependency.
      // Missing declarations are diagnosed by the native consumer typecheck.
      return value;
    }
    const transformed=ts.transform(source,[context=>{
      const visit:ts.Visitor=node=>{
        if(ts.isImportDeclaration(node))return f.updateImportDeclaration(node,node.modifiers,node.importClause,
          specifier(node.moduleSpecifier),node.attributes);
        if(ts.isExportDeclaration(node)&&node.moduleSpecifier)return f.updateExportDeclaration(node,node.modifiers,node.isTypeOnly,
          node.exportClause,specifier(node.moduleSpecifier),node.attributes);
        if(ts.isImportTypeNode(node)&&ts.isLiteralTypeNode(node.argument)&&ts.isStringLiteral(node.argument.literal)){
          const mapped=specifier(node.argument.literal);
          return f.updateImportTypeNode(node,f.createLiteralTypeNode(mapped as ts.StringLiteral),node.attributes,node.qualifier,
            node.typeArguments?.map(type=>ts.visitNode(type,visit) as ts.TypeNode),node.isTypeOf);
        }
        if(node.kind===ts.SyntaxKind.AnyKeyword)return f.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);
        if(ts.isLiteralTypeNode(node)&&node.literal.kind===ts.SyntaxKind.NullKeyword)
          return reference('@3xjn/roblox-css-react/src/Nulls','Null');
        if(ts.isTypeReferenceNode(node)){
          const args=node.typeArguments?.map(type=>ts.visitNode(type,visit) as ts.TypeNode);
          if(ts.isIdentifier(node.typeName)){
            const mapped=nativeType(node.typeName.text,args);
            if(mapped)return mapped;
          }else if(!boundReact&&ts.isIdentifier(node.typeName.left)&&reactNames.has(node.typeName.left.text)){
            const member=node.typeName.right.text;
            if(member==='ReactNode')return reference('@3xjn/roblox-css-react/src/Html','Node');
            if(member==='ElementType')return f.createUnionTypeNode([
              f.createKeywordTypeNode(ts.SyntaxKind.StringKeyword),reference('@3xjn/roblox-css-react/src/Html','Component'),
            ]);
            if(['ComponentProps','ComponentPropsWithRef','ComponentPropsWithoutRef','HTMLAttributes','HTMLProps',
              'AllHTMLAttributes','ButtonHTMLAttributes','InputHTMLAttributes','AnchorHTMLAttributes','SVGProps','AriaAttributes'].includes(member))
              return reference('@3xjn/roblox-css-react/src/Html','Props');
            if(member==='CSSProperties')return f.createTypeReferenceNode('Record',[
              f.createKeywordTypeNode(ts.SyntaxKind.StringKeyword),f.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
            ]);
            if(/^(?:Synthetic|Pointer|Mouse|Keyboard|Focus|UI|Change|Form|Touch|Wheel|Animation|Transition|Composition|Clipboard|Drag)Event$/.test(member))
              return reference('@3xjn/roblox-css-react/src/BrowserHost','BrowserEvent');
            if(/^(?:Pointer|Mouse|Keyboard|Focus|UI|Change|Form|Touch|Wheel|Animation|Transition|Composition|Clipboard|Drag)EventHandler$/.test(member))
              return f.createFunctionTypeNode(undefined,[f.createParameterDeclaration(undefined,undefined,'event',undefined,
                reference('@3xjn/roblox-css-react/src/BrowserHost','BrowserEvent'))],f.createKeywordTypeNode(ts.SyntaxKind.VoidKeyword));
          }else if(!boundReact&&ts.isQualifiedName(node.typeName.left)&&ts.isIdentifier(node.typeName.left.left)
            &&reactNames.has(node.typeName.left.left.text)&&node.typeName.left.right.text==='JSX'&&node.typeName.right.text==='Element')
              return reference('@3xjn/roblox-css-react/src/Html','Element');
        }
        return ts.visitEachChild(node,visit,context);
      };
      return root=>ts.visitNode(root,visit) as ts.SourceFile;
    }]);
    const result=transformed.transformed[0]!;
    const imports=[...nativeImports].map(([module,alias])=>f.createImportDeclaration(undefined,
      f.createImportClause(true,undefined,f.createNamespaceImport(f.createIdentifier(alias))),f.createStringLiteral(module)));
    const output=ts.createPrinter({newLine:ts.NewLineKind.LineFeed}).printFile(f.updateSourceFile(result,[...imports,...result.statements]));
    transformed.dispose();
    files.set(id,{filename:`declarations/${id}.d.ts`,source:output});
    return id;
  }
  const queries=new Map<string,{module:string;name:string}>();
  /** Expose only a published top-level const's static type. Its declaration and
   * imports stay in their existing bundled module; no runtime value is added. */
  function exposeQuery(filename:string,name:string):{module:string;name:string}|undefined {
    const key=JSON.stringify([canonical(filename),name]),prior=queries.get(key);if(prior)return prior;
    const text=host.readFile(filename);if(text===undefined)return undefined;
    const source=ts.createSourceFile(filename,text,ts.ScriptTarget.Latest,true);
    if(source.statements.some(statement=>ts.isExportAssignment(statement)&&statement.isExportEquals))return undefined;
    const declaration=source.statements.flatMap(statement=>ts.isVariableStatement(statement)&&statement.declarationList.flags&ts.NodeFlags.Const
      ?[...statement.declarationList.declarations]:[]).find(declaration=>ts.isIdentifier(declaration.name)&&declaration.name.text===name&&declaration.type);
    if(!declaration)return undefined;
    const module=add(filename),output=files.get(module);if(!output)return undefined;
    const names=new Set<string>();
    const scan=(node:ts.Node)=>{if(ts.isIdentifier(node))names.add(node.text);ts.forEachChild(node,scan);};
    scan(ts.createSourceFile(output.filename,output.source,ts.ScriptTarget.Latest,true));
    let exported='__CompilerConstQuery';while(names.has(exported))exported+='_';
    output.source+=`\nexport type ${exported} = typeof ${name};\n`;
    const query={module,name:exported};queries.set(key,query);return query;
  }
  return {add,exposeQuery,files,diagnostics,manifests};
}
