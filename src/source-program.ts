import ts from 'typescript';
import crypto from 'node:crypto';
import {statSync} from 'node:fs';
import {javascriptTypes,javascriptPrivateTypes,type JavaScriptContract} from './javascript-types.ts';

const defaultLibraries=new Map<string,{stamp:string;text:string;parsed:Map<string,ts.SourceFile>}>();
function defaultLibrary(name:string,version?:ts.ScriptTarget|ts.CreateSourceFileOptions){
  const key=ts.sys.resolvePath(name).replaceAll('\\','/');
  let stamp:string;
  try{const stat=statSync(name);stamp=`${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;}catch{return undefined;}
  let entry=defaultLibraries.get(key);
  if(!entry||entry.stamp!==stamp){
    const text=ts.sys.readFile(name);if(text===undefined)return undefined;
    entry={stamp,text,parsed:new Map()};defaultLibraries.set(key,entry);
  }
  if(version===undefined)return {text:entry.text};
  const target=JSON.stringify(version);
  let source=entry.parsed.get(target);
  if(!source){source=ts.createSourceFile(name,entry.text,version,true,ts.ScriptKind.TS);entry.parsed.set(target,source);}
  return {text:entry.text,source};
}

export interface TypeSource {
  /** Uses the same working-directory-relative or absolute paths as filename. */
  readonly filename: string;
  readonly source: string;
}
export type SourceResolution = Pick<ts.CompilerOptions, 'baseUrl' | 'paths' | 'module' | 'moduleResolution' | 'jsx'> & {
  /** Executable npm entry -> its published declaration module. */
  readonly declarationFiles?:Readonly<Record<string,string>>;
  /** Explicit package manifests used only by TypeScript's module resolver. */
  readonly packageJsons?:Readonly<Record<string,string>>;
  /** Project linking can introduce type-only imports into published JS. */
  readonly typedJavaScript?:boolean;
  /** Explicit native lookup capability for opaque values in erased JS only. */
  readonly dynamicProperties?:boolean;
  /** Exact private const types exposed from this executable's paired d.ts. */
  readonly localTypeQueries?:Readonly<Record<string,{readonly module:string;readonly name:string}>>;
  /** Strictness proven on the original executable before module normalization. */
  readonly sourceStrict?:boolean;
};

/** TypeScript resolves only explicit inputs and its own standard library.
 * Supplementary files establish types; they are never runtime modules here. */
export function sourceProgram(
  text: string,
  filename: string,
  standardLibrary: boolean,
  inputs: readonly TypeSource[] = [],
  resolution: SourceResolution = {},
  rootKind?: ts.ScriptKind,
) {
  const canonical = (name: string) => {
    const absolute = ts.sys.resolvePath(name).replaceAll('\\', '/');
    return ts.sys.useCaseSensitiveFileNames ? absolute : absolute.toLowerCase();
  };
  const parse = (name: string, content: string, kind?: ts.ScriptKind) =>
    ts.createSourceFile(
      name,
      content,
      ts.ScriptTarget.Latest,
      true,
      kind ?? (name.endsWith('.tsx') ? ts.ScriptKind.TSX : name.endsWith('.jsx') ? ts.ScriptKind.JSX
        : /\.[cm]?js$/.test(name) ? ts.ScriptKind.JS : ts.ScriptKind.TS),
    );
  const javascript=/\.[cm]?jsx?$/.test(filename);
  let source = parse(filename, text, javascript && resolution.typedJavaScript ? ts.ScriptKind.TSX
    : rootKind ?? (javascript?ts.ScriptKind.JS:undefined));
  const originalSource=source;
  const files = new Map([[canonical(filename), source]]);
  const labels = new Map([[canonical(filename),filename]]);
  const duplicates: string[] = [];
  const references = inputs.map((input) => {
    const key = canonical(input.filename);
    if (files.has(key)) duplicates.push(input.filename);
    else {files.set(key, parse(input.filename, input.source,
      resolution.typedJavaScript&&/\.[cm]?jsx?$/.test(input.filename)?ts.ScriptKind.TSX:undefined));labels.set(key,input.filename);}
    return {
      filename: input.filename,
      sha256: crypto.createHash('sha256').update(input.source).digest('hex'),
    };
  });
  const {declarationFiles,packageJsons,typedJavaScript: _typedJavaScript,dynamicProperties: _dynamicProperties,sourceStrict: _sourceStrict,localTypeQueries:_localTypeQueries,...moduleOptions}=resolution;
  const manifests=new Map(Object.entries(packageJsons??{}).map(([name,text])=>[canonical(name),text]));
  const options: ts.CompilerOptions = {
    ...moduleOptions,
    jsx:resolution.jsx??ts.JsxEmit.Preserve,
    allowJs: true,
    checkJs: true,
    maxNodeModuleJsDepth: 10000,
    noResolve: inputs.length === 0,
    moduleResolution: resolution.moduleResolution ?? ts.ModuleResolutionKind.Node10,
    strictNullChecks: true,
    types: [],
    ...(standardLibrary
      ? { target: ts.ScriptTarget.ES2023, lib: ['lib.es2023.d.ts'] }
      : { noLib: true }),
  };
  const host = ts.createCompilerHost(options);
  const exists = host.fileExists.bind(host);
  const directoryExists = host.directoryExists?.bind(host);
  const libRoot = canonical(ts.getDefaultLibFilePath(options)).replace(
    /[^/]+$/,
    '',
  );
  const coreLibraries=new Set<string>();
  const library = (name: string) => {
    const key = canonical(name);
    return (
      (standardLibrary||coreLibraries.has(key.slice(libRoot.length))) &&
      key.startsWith(libRoot) &&
      /^lib(?:\.[^/]+)?\.d\.ts$/.test(key.slice(libRoot.length))
    );
  };
  host.getSourceFile = (name, version, onError, fresh) =>
    files.get(canonical(name)) ??
    (library(name) ? defaultLibrary(name,version)?.source : undefined);
  host.fileExists = (name) =>
    files.has(canonical(name)) || manifests.has(canonical(name)) || (!!library(name) && exists(name));
  host.readFile = (name) =>
    files.get(canonical(name))?.text ?? manifests.get(canonical(name)) ??
    (library(name) ? defaultLibrary(name)?.text : undefined);
  host.directoryExists = (name) => {
    const prefix = canonical(name).replace(/\/?$/, '/');
    return (
      [...files.keys()].some((file) => file.startsWith(prefix)) ||
      ((standardLibrary||coreLibraries.size>0) && prefix === libRoot && !!directoryExists?.(name))
    );
  };
  host.realpath = (name) => name;
  const roots=[...files.values()].map(file=>file.fileName);
  let program = ts.createProgram(roots,options,host);
  if(!standardLibrary){
    const utilities=new Set(['Partial','Required','Readonly','Pick','Omit','Parameters','ReturnType','ConstructorParameters','InstanceType',
      'Exclude','Extract','NonNullable','Record','Array','ReadonlyArray','ThisParameterType','OmitThisParameter']);
    const checker=program.getTypeChecker();let requested=false;
    const inspect=(node:ts.Node)=>{
      if(ts.isTypeReferenceNode(node)&&ts.isIdentifier(node.typeName)&&utilities.has(node.typeName.text)&&!checker.getSymbolAtLocation(node.typeName)?.declarations?.length)requested=true;
      if(ts.isTypeReferenceNode(node)&&ts.isQualifiedName(node.typeName)){
        let root=node.typeName.left;while(ts.isQualifiedName(root))root=root.left;
        if(root.text==='Intl'&&!checker.getSymbolAtLocation(root)?.declarations?.length)requested=true;
      }
      ts.forEachChild(node,inspect);
    };
    for(const source of files.values())inspect(source);
    if(requested){
      // Use actual installed declarations to bind demanded core type names.
      // This grants no runtime capability and never replaces a source symbol.
      for(const name of ['lib.es5.d.ts','lib.decorators.d.ts','lib.decorators.legacy.d.ts'])coreLibraries.add(name);
      roots.push(`${libRoot}lib.es5.d.ts`);program=ts.createProgram(roots,options,host);
    }
  }
  let originalOffset=(offset:number)=>offset;
  const pairingDiagnostics:{code:string;message:string;line:number;column:number}[]=[];
  let trustedJavaScriptContracts:readonly JavaScriptContract[]=[];
  const declarationFile=Object.entries(declarationFiles??{}).find(([name])=>canonical(name)===canonical(filename))?.[1];
  if(javascript&&declarationFile){
    const declaration=program.getSourceFile(declarationFile)??files.get(canonical(declarationFile));
    if(declaration){
      const paired=javascriptTypes(source,declaration,program.getTypeChecker(),{dynamicPropertyReads:!!resolution.dynamicProperties});
      if(resolution.dynamicProperties)trustedJavaScriptContracts=paired.contracts;
      for(const issue of paired.issues){const point=originalSource.getLineAndCharacterOfPosition(issue.start);
        pairingDiagnostics.push({code:'javascript-types',message:issue.message,line:point.line+1,column:point.character+1});}
      if(paired.text!==text){
        source=parse(filename,paired.text,ts.ScriptKind.TSX);
        files.set(canonical(filename),source);
        program=ts.createProgram(roots,options,host,program);
        originalOffset=paired.original;
      }
    }else pairingDiagnostics.push({code:'javascript-types',message:`Published declaration ${declarationFile} was not supplied as an explicit type input.`,line:1,column:1});
  }
  if(javascript&&resolution.typedJavaScript){
    // Each inference step installs only missing signatures. The bound is the
    // finite number of signature slots, rather than an arbitrary retry count.
    let slots=1;
    const count=(node:ts.Node)=>{
      if(ts.isParameter(node)||ts.isFunctionLike(node))slots++;
      ts.forEachChild(node,count);
    };
    count(source);
    const inferenceIssues=new Set<string>();
    for(let step=0;step<slots;step++){
      const inferred=javascriptPrivateTypes(source,program.getTypeChecker());
      for(const issue of inferred.issues){
        const at=originalOffset(issue.start),key=`${at}:${issue.message}`;
        if(inferenceIssues.has(key))continue;
        inferenceIssues.add(key);
        const point=originalSource.getLineAndCharacterOfPosition(at);
        pairingDiagnostics.push({code:'javascript-types',message:issue.message,line:point.line+1,column:point.character+1});
      }
      if(inferred.text===source.text)break;
      const previousOffset=originalOffset;
      originalOffset=offset=>previousOffset(inferred.original(offset));
      source=parse(filename,inferred.text,ts.ScriptKind.TSX);
      files.set(canonical(filename),source);
      program=ts.createProgram(roots,options,host,program);
      if(step===slots-1)throw Error('Private JavaScript signature inference exceeded its finite signature bound.');
    }
  }
  const provided = [...files.values()].map((source) => ({source,filename:labels.get(canonical(source.fileName))??source.fileName}));
  const primaryLibraryFiles=new WeakMap<ts.SourceFile,boolean>();
  function standardLibraryFile(file:ts.SourceFile):boolean {
    const known=primaryLibraryFiles.get(file);if(known!==undefined)return known;
    // An explicitly supplied lib file is a root input, so TypeScript need not
    // mark it as a default library. Verify its installed path and exact bytes.
    const primary=library(file.fileName)&&file.text===defaultLibrary(file.fileName)?.text;
    primaryLibraryFiles.set(file,primary);return primary;
  }
  if (program.getSourceFile(filename) !== source)
    throw Error('TypeScript did not load the data module source.');
  return {
    standardLibraryFile,
    trustedJavaScriptContracts,
    trustedPublicFunction:(node:ts.SignatureDeclaration)=>node.pos>=0&&trustedJavaScriptContracts.some(contract=>contract.functionStart===originalOffset(ts.getOriginalNode(node).getStart(source))),
    source,
    program,
    references,
    duplicates,
    inputs: provided,
    pairingDiagnostics,
    /** Positions stay on the original executable, even after signature typing. */
    originalPosition(offset:number){return originalSource.getLineAndCharacterOfPosition(originalOffset(offset));},
  };
}
