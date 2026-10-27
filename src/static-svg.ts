import ts from 'typescript';
import {jsxRuntimeExport} from './source-mode.ts';

export interface StaticSvgInput {
  readonly source: string;
  readonly filename: string;
  readonly line: number;
  readonly column: number;
}
export interface StaticSvgOptions {
  /** Supply an existing SVG compiler. No rasterizer or asset format is owned here. */
  readonly compile: (input: StaticSvgInput) => string;
}
export interface StaticSvgAsset extends StaticSvgInput { readonly asset: string }
export interface StaticSvgElement {
  readonly asset: StaticSvgAsset;
  readonly attributes: readonly ts.JsxAttribute[];
  /** Ordered retained props for a published JSX runtime call. */
  readonly props?: ts.ObjectLiteralExpression;
  readonly rootAttributes?:readonly ts.JsxAttributeLike[];
  readonly spreadProps?:ts.ObjectLiteralExpression;
  readonly geometry?:ts.ObjectLiteralExpression;
}

export const staticSvgAssetAttribute = 'data-css-svg-asset';

// React's SVG presentation aliases. Case-sensitive SVG geometry names, such as
// viewBox and gradientUnits, already have their XML spelling and stay intact.
const aliases: Readonly<Record<string, string>> = {
  strokeWidth: 'stroke-width', strokeLinecap: 'stroke-linecap',
  strokeLinejoin: 'stroke-linejoin', strokeMiterlimit: 'stroke-miterlimit',
  strokeDasharray: 'stroke-dasharray', strokeDashoffset: 'stroke-dashoffset',
  strokeOpacity: 'stroke-opacity', fillOpacity: 'fill-opacity', fillRule: 'fill-rule',
  clipRule: 'clip-rule', clipPath: 'clip-path', vectorEffect: 'vector-effect',
  stopColor: 'stop-color', stopOpacity: 'stop-opacity', paintOrder: 'paint-order',
  colorInterpolation: 'color-interpolation', colorInterpolationFilters: 'color-interpolation-filters',
  floodColor: 'flood-color', floodOpacity: 'flood-opacity', lightingColor: 'lighting-color',
  fontFamily: 'font-family', fontSize: 'font-size', fontWeight: 'font-weight',
  fontStyle: 'font-style', textAnchor: 'text-anchor', dominantBaseline: 'dominant-baseline',
  alignmentBaseline: 'alignment-baseline', baselineShift: 'baseline-shift',
  xlinkHref: 'xlink:href', xmlnsXlink: 'xmlns:xlink', xmlSpace: 'xml:space',
};
const escape = (value: string) => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;')
  .replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const retained = (name: string) => ['className', 'id', 'key', 'role', 'style'].includes(name)
  || name.startsWith('aria-') || name.startsWith('data-');

/**
 * Lower only an explicitly opted-in, static SVG document. Its root remains a
 * logical SVG host for CSS; the descendants become a compiled image asset.
 * Dynamic geometry and descendant CSS need a document renderer, not an asset.
 */
export function compileStaticSvg(node: ts.JsxElement | ts.JsxSelfClosingElement | ts.CallExpression,
  source: ts.SourceFile, options: StaticSvgOptions, checker?:ts.TypeChecker): StaticSvgElement {
  const attributes: ts.JsxAttribute[] = [];
  const props: ts.ObjectLiteralElementLike[] = [];
  const effects: ts.Expression[] = [];
  const geometry:ts.ObjectLiteralElementLike[]=[];
  const fullProps:ts.ObjectLiteralElementLike[]=[];
  let rootAttributes:readonly ts.JsxAttributeLike[]|undefined;
  let rootSpread=false;
  function decodedXml(value:string):string{
    const entities:Record<string,string>={amp:'&',quot:'"',apos:"'",lt:'<',gt:'>'};
    return value.slice(1,-1).replace(/&(amp|quot|apos|lt|gt|#x[\da-f]+|#\d+);/gi,(_entity,name:string)=>{
      if(name[0]!=='#')return entities[name]!;
      const code=name[1]?.toLowerCase()==='x'?parseInt(name.slice(2),16):parseInt(name.slice(1),10);
      return String.fromCodePoint(code);
    });
  }
  function attributeValue(value: ts.JsxAttributeValue | undefined): string {
    if (!value) throw new Error('SVG attributes require explicit static values.');
    // JSX quoted attributes already contain XML entities. Preserve their source
    // spelling rather than decoding and re-encoding them inconsistently.
    if (ts.isStringLiteral(value)) return value.getText(source);
    if (!ts.isJsxExpression(value) || !value.expression) throw new Error('SVG attributes require static strings or numbers.');
    function literal(expression: ts.Expression): string | number {
      if (ts.isStringLiteralLike(expression)) return expression.text;
      if (ts.isNumericLiteral(expression)) return Number(expression.text);
      if (ts.isParenthesizedExpression(expression)) return literal(expression.expression);
      if (ts.isPrefixUnaryExpression(expression) && [ts.SyntaxKind.MinusToken, ts.SyntaxKind.PlusToken].includes(expression.operator)) {
        const child = literal(expression.operand);
        if (typeof child === 'number') return expression.operator === ts.SyntaxKind.MinusToken ? -child : child;
      }
      throw new Error('Dynamic SVG geometry needs a document renderer; static assets accept literal strings and numbers.');
    }
    const result = literal(value.expression);
    if (typeof result === 'number' && !Number.isFinite(result)) throw new Error('SVG numeric attributes must be finite.');
    return `"${escape(String(result))}"`;
  }
  function tagName(tag:string) {
    if (!/^[a-z][A-Za-z0-9]*$/.test(tag)) throw new Error('Static SVG descendants require literal SVG element names.');
    if (['script', 'foreignObject'].includes(tag)) throw new Error(`${tag} needs its own platform adapter.`);
    return tag;
  }
  function attributeEntry(name:string,root:boolean,names:Set<string>,values:string[],retain:()=>void,value:()=>string) {
    if(name==='__proto__')throw new Error('Static SVG props cannot set a JavaScript object prototype.');
    if (name === staticSvgAssetAttribute) throw new Error(`${name} is owned by the static SVG adapter.`);
    if (name === 'ref' || /^on[A-Z]/.test(name)) throw new Error('SVG refs and events need their own platform adapter.');
    if (retained(name) && (root || name !== 'id')) {
      if (!root) throw new Error('SVG descendant props and CSS need a document renderer, not a static image asset.');
      retain();return;
    }
    const xmlName = aliases[name] ?? name;
    if (!/^[A-Za-z_][\w.:-]*$/.test(xmlName)) throw new Error(`Invalid SVG attribute: ${name}`);
    if (names.has(xmlName)) throw new Error(`Duplicate SVG attribute: ${xmlName}`);
    const encoded=value();
    names.add(xmlName);values.push(`${xmlName}=${encoded}`);
    if(root)geometry.push(ts.factory.createPropertyAssignment(ts.factory.createStringLiteral(name),ts.factory.createStringLiteral(decodedXml(encoded))));
  }
  function runtimeDocument(element:ts.CallExpression,root:boolean):string {
    const runtime=checker&&jsxRuntimeExport(element.expression,checker);
    if (!runtime || runtime==='Fragment' || element.questionDotToken || element.arguments.length<2
      ||element.arguments.length>(runtime==='jsxDEV'?6:3)||element.arguments.some(ts.isSpreadElement))
      throw new Error('Static SVG descendants require ordinary published JSX element calls.');
    const tag=element.arguments[0]!;
    if (!ts.isStringLiteralLike(tag)) throw new Error('Static SVG descendants require literal SVG element names.');
    tagName(tag.text);
    let config=element.arguments[1]!;
    while(ts.isParenthesizedExpression(config))config=config.expression;
    if(!ts.isObjectLiteralExpression(config))throw new Error('Static SVG props require an ordinary object literal; spreads need a document renderer.');
    const names=new Set<string>(),values:string[]=[],children:string[]=[];
    let hasChildren=false;
    for(const property of config.properties){
      if(ts.isSpreadAssignment(property)&&root){
        if(hasChildren)throw new Error('Static SVG root spreads after children may replace geometry and need a document renderer.');
        rootSpread=true;fullProps.push(property);continue;
      }
      if(!(ts.isPropertyAssignment(property)||ts.isShorthandPropertyAssignment(property))||ts.isComputedPropertyName(property.name))
        throw new Error('SVG spreads, computed props and accessors need a document renderer.');
      const name=property.name.text;
      const value=ts.isPropertyAssignment(property)?property.initializer:property.name;
      if(name==='children'){
        if(hasChildren)throw new Error('Duplicate SVG children need a document renderer.');hasChildren=true;
        const start=effects.length;
        const child=(expression:ts.Expression):void=>{
          while(ts.isParenthesizedExpression(expression))expression=expression.expression;
          if(ts.isArrayLiteralExpression(expression)){
            for(const entry of expression.elements){
              if(ts.isSpreadElement(entry)||ts.isOmittedExpression(entry))throw new Error('Dynamic SVG children need a document renderer; select between complete static SVG documents instead.');
              child(entry);
            }
          }else if(ts.isCallExpression(expression)||ts.isJsxElement(expression)||ts.isJsxSelfClosingElement(expression))children.push(document(expression,false));
          else if(!ts.isStringLiteralLike(expression)||expression.text.trim())throw new Error('Dynamic SVG children need a document renderer; select between complete static SVG documents instead.');
        };
        child(value);
        if(root&&effects.length>start){
          const childrenEffects=effects.splice(start);
          const entry=ts.factory.createPropertyAssignment(property.name,ts.factory.createCommaListExpression([...childrenEffects,ts.factory.createVoidZero()]));
          props.push(entry);fullProps.push(entry);
        }else if(root){
          fullProps.push(ts.factory.createPropertyAssignment(property.name,ts.factory.createVoidZero()));
        }
      }else {
        if(root)fullProps.push(property);
        attributeEntry(name,root,names,values,()=>props.push(property),()=>attributeValue(ts.factory.createJsxExpression(undefined,value)));
      }
    }
    if(root&&!names.has('xmlns'))values.push('xmlns="http://www.w3.org/2000/svg"');
    // The runtime's key/debug arguments are evaluated after its props. Geometry
    // becomes an asset, but these observable source evaluations still run.
    if(!root)effects.push(...element.arguments.slice(2));
    return `<${tag.text}${values.length?` ${values.join(' ')}`:''}>${children.join('')}</${tag.text}>`;
  }
  function document(element: ts.JsxElement | ts.JsxSelfClosingElement | ts.CallExpression, root: boolean): string {
    if(ts.isCallExpression(element))return runtimeDocument(element,root);
    const opening = ts.isJsxElement(element) ? element.openingElement : element;
    if (!ts.isIdentifier(opening.tagName) || !/^[a-z][A-Za-z0-9]*$/.test(opening.tagName.text)) {
      throw new Error('Static SVG descendants require literal SVG element names.');
    }
    const tag = tagName(opening.tagName.text);
    const names = new Set<string>();
    const values: string[] = [];
    for (const attribute of opening.attributes.properties) {
      if (!ts.isJsxAttribute(attribute)) {
        if(!root)throw new Error('SVG spreads may change geometry and need a document renderer.');
        rootSpread=true;continue;
      }
      const name = attribute.name.getText(source);
      if(name==='children')throw new Error('Static SVG children require nested literal geometry.');
      const entry=attribute;
      attributeEntry(name,root,names,values,()=>attributes.push(entry),()=>attributeValue(entry.initializer));
    }
    if(root&&rootSpread){
      rootAttributes=opening.attributes.properties;
      if(ts.isJsxElement(element)&&element.children.some(child=>ts.isJsxElement(child)||ts.isJsxSelfClosingElement(child)))
        rootAttributes=[...rootAttributes,ts.factory.createJsxAttribute(ts.factory.createIdentifier('children'),
          ts.factory.createJsxExpression(undefined,ts.factory.createVoidZero()))];
    }
    if (root && !names.has('xmlns')) values.push('xmlns="http://www.w3.org/2000/svg"');
    const children: string[] = [];
    if (ts.isJsxElement(element)) for (const child of element.children) {
      if (ts.isJsxElement(child) || ts.isJsxSelfClosingElement(child)) children.push(document(child, false));
      else if (ts.isJsxText(child)) {
        if (child.text.trim()) throw new Error('SVG text needs an explicit text-to-path or document renderer.');
      } else if (!(ts.isJsxExpression(child) && child.expression === undefined)) {
        throw new Error('Dynamic SVG children need a document renderer; select between complete static SVG documents instead.');
      }
    }
    return `<${tag}${values.length ? ` ${values.join(' ')}` : ''}>${children.join('')}</${tag}>`;
  }
  const position = source.getLineAndCharacterOfPosition(node.getStart(source));
  const input: StaticSvgInput = { source: document(node, true), filename: source.fileName,
    line: position.line + 1, column: position.character + 1 };
  const asset = options.compile(input);
  if (typeof asset !== 'string' || !asset.trim()) throw new Error('The SVG compiler must return a nonempty asset key.');
  return { asset: { ...input, asset }, attributes,
    ...(ts.isCallExpression(node)?{props:ts.factory.createObjectLiteralExpression(props,true)}:{}),
    ...(rootSpread?{geometry:ts.factory.createObjectLiteralExpression(geometry,true),
      ...(rootAttributes?{rootAttributes}:{spreadProps:ts.factory.createObjectLiteralExpression(fullProps,true)})}:{}) };
}
