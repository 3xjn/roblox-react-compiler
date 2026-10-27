import type {ImportBinding, GlobalBinding} from './index.ts';
import type {DataModuleOptions, DataTypeBinding} from './data-module.ts';
import type {ProjectOptions} from './project.ts';

const module='@3xjn/roblox-css-react/src/';
const value=(file:string,name:string)=>({module:module+file,name});
const helper=(name:string,file:string,type='Provider',member?:string)=>({name,valueType:{...value(file,type),...(member?{member}:{})}});
const reactNames=['useState','useReducer','useRef','useEffect','useLayoutEffect','useCallback','useMemo',
  'useContext','useImperativeHandle','useDebugValue','useId','useSyncExternalStore','createContext','createRef','forwardRef','memo',
  'createElement','cloneElement','isValidElement','Fragment','Children'] as const;
// Package implementations resolve and compile from source. Only native React
// values are linked through the runtime context.
const bindings:readonly ImportBinding[]=[
  ...['*','default',...reactNames].map(name=>({module:'react',name,kind:'value' as const,
    valueType: name==='*'||name==='default'
      ? value('SourceRuntime','ReactNamespace')
      : name==='createElement' ? value('BrowserReact','CreateElement')
      : name==='useId' ? {module:module+'SourceRuntime',name:'ReactNamespace',member:'useId'}
      : name==='useSyncExternalStore' ? {module:module+'SourceRuntime',name:'ReactNamespace',member:'useSyncExternalStore'}
      : {module:'@rbxts/react',name,typeOf:true}})),
  ...['*','default'].map(name=>({module:'react-dom',name,kind:'value' as const,
    valueType:{module:module+'BrowserHost',name:'ReactDom'}})),
  ...['flushSync','createPortal'].map(name=>({module:'react-dom',name,kind:'value' as const,
    valueType:{module:module+'BrowserHost',name:'ReactDom',member:name}})),
  ...['react/jsx-runtime','react/jsx-dev-runtime'].flatMap(module=>[
    {module,name:'*',kind:'value' as const,valueType:value('SourceRuntime','JsxRuntime')},
    ...(module==='react/jsx-runtime'?['jsx','jsxs','Fragment']:['jsxDEV','Fragment']).map(name=>({module,name,kind:'value' as const,
      valueType:{...value('SourceRuntime','JsxRuntime'),member:name}})),
  ]),
];
const globals:readonly GlobalBinding[]=[
  ...['requestAnimationFrame','cancelAnimationFrame','setTimeout','clearTimeout','setInterval','clearInterval'].map(name=>({name,
    valueType:{...value('SourceRuntime','Browser'),member:name}})),
  {name:'globalThis',valueType:value('SourceRuntime','Browser')},
  {name:'Date',valueType:value('SourceRuntime','Clock')},
  {name:'process',valueType:value('SourceRuntime','Environment')},
  {name:'Object',valueType:value('SourceRuntime','Objects')},
  ...['Array','String','Number','Math','Error','Boolean','ResizeObserver','MutationObserver','AbortController',
    'getComputedStyle','document','window','navigator','CSS','NaN','Infinity','parseFloat','parseInt','console','Map','Set','WeakMap',
    'performance','queueMicrotask','Event','Symbol','JSON','RegExp','Intl','Promise','IntersectionObserver',
    'Node','NodeFilter','Element','HTMLElement','ShadowRoot','Text','HTMLTextAreaElement','HTMLFormElement','HTMLBRElement','cookieStore','DOMRect','DOMRectReadOnly','TypeError','RangeError','URIError','WeakRef','URL','WeakSet',
    'isNaN','isFinite',
    'encodeURIComponent','decodeURIComponent'].map(name=>({name,valueType:{...value('SourceRuntime','ValueGlobals'),member:name}})),
];
const types:readonly DataTypeBinding[]=[
  {module:'react',name:'*',target:{module:module+'BrowserReact',name:'*'}},
  {module:'react',name:'RefObject',target:{module:module+'BrowserReact',name:'RefObject'}},
  {name:'FrameRequestCallback',target:value('Frames','Callback')},
  ...['Error','TypeError','RangeError'].map(name=>({name,target:value('SourceErrors','Value')})),
  {name:'URIError',target:value('SourceErrors','Value')},
  {name:'WeakRef',target:value('SourceWeakRef','Value')},
  {name:'Promise',target:value('SourcePromise','PromiseValue')},
  {name:'URL',target:value('SourceURL','Value')},
  {name:'Date',target:value('SourceDate','Value')},
  ...['DOMRect','DOMRectReadOnly','DOMRectInit'].map(name=>({name,target:value('SourceDOMRect',name)})),
  ...['Node','Element','HTMLElement','ShadowRoot','Text','HTMLTextAreaElement','HTMLFormElement','HTMLBRElement'].map(name=>({name,target:value('DomClasses',`${name}Value`)})),
  ...['HTMLDivElement','HTMLButtonElement','HTMLInputElement','HTMLSpanElement','HTMLAnchorElement','HTMLUListElement','HTMLLIElement','HTMLHeadingElement','HTMLParagraphElement'].map(name=>({name,target:value('DomClasses','HTMLElementValue')})),
  ...['Event','UIEvent','MouseEvent','PointerEvent','TouchEvent','KeyboardEvent','FocusEvent','InputEvent','ClipboardEvent','WheelEvent'].map(name=>({name,target:value('BrowserHost',name==='Event'?'Event':'BrowserEvent')})),
  {name:'EventTarget',target:value('BrowserHost','EventTarget')},
  {name:'AbortSignal',target:value('BrowserHost','AbortSignal')},
  {name:'Window',target:value('BrowserHost','Window')},
  {name:'Document',target:value('BrowserHost','Document')},
  {name:'CSSStyleDeclaration',target:value('BrowserHost','CSSStyleDeclaration')},
  {name:'VisualViewport',target:value('BrowserHost','VisualViewport')},
  {name:'HTMLElementTagNameMap',target:value('BrowserHost','HTMLElementTagNameMap')},
  {name:'SVGElementTagNameMap',target:value('BrowserHost','SVGElementTagNameMap')},
  {name:'SVGElement',target:value('BrowserHost','SVGElement')},
  {name:'SVGSVGElement',target:value('BrowserHost','SVGSVGElement')},
  {name:'AddEventListenerOptions',target:value('BrowserHost','AddEventListenerOptions')},
  {name:'EventListenerOrEventListenerObject',target:value('BrowserHost','EventListenerOrEventListenerObject')},
  ...['Map','ReadonlyMap'].map(name=>({name,target:value('SourceCollections','SourceMap'),iteratorMethod:'iterator'})),
  ...['Set','ReadonlySet'].map(name=>({name,target:value('SourceCollections','SourceSet'),iteratorMethod:'iterator'})),
  {name:'WeakMap',target:value('SourceCollections','SourceWeakMap')},
  {name:'WeakSet',target:value('SourceCollections','SourceWeakSet')},

];
const data:Omit<DataModuleOptions,'filename'|'bindings'>={
  numberStrings:helper('numberStrings','SourceNumbers'),
  classChecks:helper('classChecks','SourceClassChecks'),
  strings:helper('sourceStrings','Strings','Methods'),
  unknownAssertions:true,
  arrays:helper('arrays','Arrays'),records:helper('records','Records'),nulls:helper('nulls','Nulls'),
  functions:helper('functions','FunctionValues'),
  forInKeys:helper('enumerateKeys','Records','Provider','enumerate'),
  propertyHas:helper('hasProperty','SourceProperties','Has'),
  objectMethods:helper('propertyValues','SourceProperties','Provider'),
  dynamicProperties:helper('readProperty','SourceProperties','Get'),
  propertyKeyString:helper('keyString','Records','Provider','keyString'),
  typeIs:helper('typeIs','SourceType','TypeIs'),typeOf:helper('typeOf','SourceType','TypeOf'),
};

/** Select platform semantics once per project. Upstream utilities still resolve
 * through TypeScript; this registry contains no component implementations. */
export function projectOptions(input:ProjectOptions) {
  if(input.platform!=='roblox')return {...input,bindings:input.bindings??[]};
  const merge=<T>(defaults:readonly T[],provided:readonly T[]|undefined,key:(item:T)=>string)=>{
    const replaced=new Set((provided??[]).map(key));
    return [...defaults.filter(item=>!replaced.has(key(item))),...provided??[]];
  };
  const importKey=(item:{module:string;name:string})=>JSON.stringify([item.module,item.name]);
  const globalKey=(item:{name:string})=>item.name;
  return {...input,
    javascript:input.javascript??{operations:helper('sourceOperations','SourceOperations'),nulls:helper('nulls','Nulls')},
    bindings:merge(bindings,input.bindings,importKey),
    component:{factoryModuleState:true,runtimeStyleRecords:true,reactInference:true,nodes:helper('renderNodes','RenderNodes','Normalize'),...input.component,types:merge(types,input.component?.types,item=>JSON.stringify([item.module,item.name,item.local])),values:{dynamicProperties:data.dynamicProperties!,classChecks:data.classChecks!,numberStrings:data.numberStrings!,arrays:data.arrays!,functions:data.functions!,nulls:data.nulls!,records:data.records!,forInKeys:data.forInKeys!,propertyHas:data.propertyHas!,objectMethods:data.objectMethods!,...input.component?.values},globals:merge(globals,input.component?.globals,globalKey)},
    data:{...data,...input.data,globals:merge(globals,input.data?.globals,globalKey),
      types:merge(types,input.data?.types,item=>JSON.stringify([item.module,item.name,item.local]))},
  };
}

