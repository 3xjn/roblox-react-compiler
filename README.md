# React source compiler

Build selected React function components for the existing CSS renderer, using
TypeScript and roblox-ts. This is a build-time package. The CSS/Tailwind compiler,
Roblox renderer and interaction adapters remain separate packages.

```ts
import { compileComponent } from '@3xjn/roblox-react-compiler';

const result = compileComponent(source, {
  filename: 'separator.tsx',
  exports: ['Separator'],
  bindings: [
    { module: '@base-ui/react/separator', name: 'Separator', kind: 'component' },
    { module: '@coss/ui/lib/utils', name: 'cn', kind: 'className' },
  ],
});
```

Check `diagnostics`, save `source` as TypeScript, then compile it with roblox-ts.
The generated module exports `create(dependencies)`. Supply the application's
element factory and the named import adapters once, outside component renders.
Both Luau and roblox-ts consumers can use the resulting Luau ModuleScript.

## Source and native responsibilities

The intended input is the original component and its dependencies. Component
composition, state and interaction logic should compile from that source.
Roblox bindings supply platform operations such as rendering, text editing,
focus, pointer events, measurement and owned timers. A new component should reuse
those capabilities; a handwritten replacement for its state machine is a porting
gap, rather than a requirement of the architecture.

The single-module build still selects exports and injects dependencies explicitly.
Several behavior adapters, including the demo's Toast adapter, contain logic that
has not yet moved through source compilation. `compileProject` now links supported
source modules automatically; it does not build an arbitrary Coss dependency tree
yet. `npm run build:gallery` builds the
configured example through TypeScript, Tailwind, roblox-ts and Rojo; it does not
establish that arbitrary upstream updates compile or render correctly.

The project compiler takes one entry point, discovers source dependencies and
uses shared platform bindings. The existing gallery's per-component jobs have not
all migrated to it. Wrapping those jobs in a command is not the project compiler.
Python is not part of source-component transpilation; the tracked font-metrics
utility is separate build tooling.

## Source projects

```ts
import { compileProject } from '@3xjn/roblox-react-compiler';

const result = compileProject({
  entryFile: 'src/app.tsx',
  exports: ['App'],
  compilerOptions: tsconfig.options,
  platform: 'roblox',
});
```

Check `diagnostics`, write the returned `files` under your generated source
directory, then use the existing roblox-ts project to compile them. The generated
`index.ts` exports one typed `create(context)`. Its `host` fields hold shared
rendering helpers; `bindings` are grouped by source module/export; `globals` hold
explicit source globals. Only required fields are emitted. This remains a
build-time API, not a browser loader or a replacement compiler/toolchain.

The optional Roblox profile configures the existing array, record, null,
function-value and primitive-type operations once for the source graph. It also
links React imports and the client layout-effect boundary. Source utilities
continue to resolve through TypeScript. They are compiled from source rather
than registered as component adapters. Explicit bindings/types/globals override
the profile; unknown libraries and unavailable browser APIs remain diagnostics.

Supply its shared context with the application's existing React instance:

```lua
local context = require(runtime.CssReact.SourceRuntime).create(React)
local parts = require(generatedProject).create(context)
-- Mount/use parts, then unmount its consumers before releasing owned callbacks.
context.destroy()
```

This removes manual helper configuration for supported source graphs. It does
not yet compile the full Toast Root/Viewport graph or replace the demo's Toast
adapter. Component/data frontends still have different coverage; shared browser
element refs, measurement, events and transition completion remain work.

TypeScript owns module resolution, including caller-supplied path aliases and
package resolution options. JSX, React component factories and declared rendering
capabilities select the component frontend. Ordinary helpers use the data
frontend even when their files end in `.tsx`; their source types and module
state remain intact. The graph links named/default/
namespace imports, named/star/namespace re-exports and source side-effect imports.
It initializes each runtime dependency once in dependency order for each
`create` call. Diamond imports and barrels share that instance; separate calls
create separate source contexts. Host/platform objects retain caller ownership.
Type-only dependencies establish source type proofs without runtime
initialization. TypeScript performs annotation-only/unused import erasure;
`verbatimModuleSyntax` retains runtime imports as configured. Data modules can import emitted source types automatically;
component annotations retain the existing checked projection boundary.

With the Roblox profile, ordinary modules and JSX bodies use the same array,
record, null, function-value and enumerable-key passes. These retain source array
length/holes, explicit undefined properties, rest/spread evaluation, zero-based
indexes and nullable state. Source array `for...of` and `.values()` use a live
length-aware iterator; `for...in` uses the ordered own-key provider. Readonly
array props with portable element types remain readonly in emitted declarations.

Host and fragment child expressions normalize source null to an empty render
value without changing the source data. Nested child collections retain their
slots and keys; unchanged collections retain identity. Prepared CSS style
packets stay separate from ordinary record construction. `compileProject` links
these generated helper dependencies to the shared context automatically.
Single-module users can configure `values`/`nodes`; `sourceValueContext` records
the required context for tooling.

This shares value lowering, rather than establishing complete frontend parity.
Rich browser/component types, generic helpers mixed with JSX, component-return
normalization outside the host boundary, prototypes/descriptors, DOM refs and
events still need further work. The native shared-value fixture covers the
documented combinations; it does not qualify the whole Toast graph or FPS.

Module metadata includes original source hashes, initialization order, all
TypeScript source/type input hashes, and component variant/SVG/feature metadata
for the existing style compiler. Module output uses checked export types and
readonly namespace views. Diagnostics from linked imports/re-exports map back to
the original source. A failed graph returns metadata and diagnostics without
partial executable files. Native roblox-ts type checking is still required.

Runtime cycles, reassigned public bindings and mutable data exports need live
module bindings and fail explicitly. Dynamic imports, top-level await and
CommonJS module forms need additional lifecycle support. Browser-only libraries,
runtime imports resolved only to declarations, unavailable native types, component
types needed as native data-module exports and unsupported language/host behavior
remain gaps. Shared platform capabilities still need an implementation; the
graph does not create one from an import name. It deliberately does not infer
tree-shaking purity or discard module effects.

The [project contract](../../tests/component-helpers/README.md) links the unchanged
Coss Button and Spinner source through a local barrel and state module, then
builds and runs both language consumers. It adds no component state machine.
The Toast Root remains unbuilt, so its pending dismissal-order regression is
still open. A complete one-command Coss build and gallery migration remain work
to do.

An optional [static SVG asset compiler](../../docs/static-svg-assets.md)
delegates literal SVG documents to a supplied existing tool. Root CSS props
remain on the logical SVG host, and `svgAssets` records the source/key/location.
Dynamic geometry and descendant CSS need a document renderer and fail explicitly
on this path. Default source compilation still requires explicit tag adapters.

## Current input

Synchronous function declarations, const arrows and const function expressions
with object/identifier props or no parameters,
referenced component functions and constants, named/default import bindings,
JSX composition, scalar HTML attributes, text children and object props spreads.
Local named export aliases select the original function declaration and preserve
its factory identity, including default aliases. Type-only exports and external
re-exports do not select component implementations. Coss's `CardContent` alias
therefore uses the same generated function as `CardPanel`.
Const function initializers retain their source position and alias identity;
selection does not hoist them. Named expressions use a private lexical
initializer scope shared with the data compiler, because roblox-ts rejects
expression names. Recursive private bindings stay private. Destructuring
defaults/rest, concise bodies, and parenthesized/asserted function initializers
use the ordinary component path. Referenced const data functions retain their
helper signatures instead of becoming components.

Type-only namespaces do not create runtime modules. A source `React.FC<Props>`
or `React.FunctionComponent<Props>` annotation can supply scalar props when
`React` resolves to a default or namespace import from `react`; lookalike local
names do not acquire that contract. Runtime namespaces, mutable module functions,
async/generator functions and function-expression contexts that observe `this`,
`arguments`, `super` or `new.target` remain diagnosed or require downstream
checking. This is syntax/type coverage, not browser API support.

Source `React.forwardRef` and `React.memo` declarations use the same selection
and emission path. Named/default/namespace imports from `react`, const factory
aliases, nested wrappers, inline callbacks and referenced local render functions
retain factory calls, initialization order, comparator dependencies and export
identity. The caller supplies the actual React Luau functions as checked value
bindings. A similarly named local function or another package's factory does not
acquire React's callback contract.

Forward-ref callbacks receive a native `GuiObject` reference through the
`Html.ForwardedRef` alias; this is not an HTMLElement facade.
Scalar props come from explicit callback annotations or the source factory's
props type argument. Their finite base keys preserve required source fields
through React's `PropsWithoutRef`. Wrapped callbacks currently require the
native React types' element return contract; downstream type checking remains
mandatory. Host refs/events still require an explicit supported host. Factory
syntax support does not implement DOM measurements, pointer capture, browser
globals, data null, dependency discovery or upstream component state machines.

The helper contract executes these factory declarations with React Luau and
native instances from both languages. A pinned, unchanged upstream Toast root
also tests that selection reaches its missing platform dependencies rather than
rejecting its `forwardRef` declaration. That root still does not build; the
existing handwritten Toast adapter has not been replaced.

Selected const aliases can expose bound components, declared namespace members
or local component functions. Local exports can expose an explicitly bound
import namespace. Factory exports preserve the supplied identities. Unknown
members, unbound factory calls, mutable state and alias cycles fail explicitly. This supports
Field's `FieldControl`, `FieldValidity` and `FieldPrimitive` exports through the
same binding mechanism.

Referenced ordinary functions retain their own data signatures rather than
being rewritten as component props. Identifier/object parameters, defaults,
primitive/literal unions, arrays, tuples, typed object properties, callbacks and
bounded local aliases/generics have a path. Component exports and JSX references
keep their component contract; local render callbacks returning JSX or a bound
`render` helper retain it too. `sourceFeatures.helperFunctions` records the
selected data helpers. Imported/browser types, recursive or constrained aliases,
unresolved inference and other unsupported types fail with `helper-type` instead
of being erased to `any`. Downstream roblox-ts checking remains required.

Local hook calls keep portable type arguments through TypeScript's normal JSX
lowering. For example, `useState<'idle' | 'ready' | undefined>()` retains that
union for native checking instead of narrowing the setter to `undefined`.
The same shared data-type projection covers local variable annotations, nested
function/callback signatures, assertions, `satisfies`, constructor and optional
call arguments. TypeScript still handles JSX entities, whitespace and spreads;
the compiler restores projected types using its original-node metadata.

Source-owned aliases and single interfaces can supply data types, including
generic arguments/defaults and inherited typed properties. Imported source types
resolve through the supplied TypeScript inputs. Ambient declarations do not
become trusted platform types. Missing, recursive, merged or unsupported explicit
call type arguments fail with `type-argument`; checked UI bindings and React
factory declarations keep their existing replacement type contracts.

`typeProofs` counts retained arguments/annotations and records local annotations
left to native inference, with their original position and reason. This is a
bounded projection, not preservation of every source TypeScript contract. Local
annotations that cannot be projected retain the existing native-inference path;
selected helper signatures still require portable types. Class/method type
surfaces, generic JSX contracts, recursive types and browser/native type
references need further support. Inspect the proof metadata and run roblox-ts.
Source-project component metadata includes the same proof records.

Component output also reuses the data compiler's symbol-aware identifier
hygiene. Roblox-reserved locals such as `next` receive private names while
property/destructuring keys and public exports retain their source names.
Neither type projection nor identifier hygiene adds runtime wrappers or a new
component implementation. The typed-state native contract runs real React state,
effects and teardown through both language entry points; it does not qualify
Toast motion or FPS.

A selected public const can call an explicitly bound `kind: 'value'` factory,
including a declared literal namespace member. Initialization runs once per
`create(dependencies)` call; repeated component calls keep the same value.
Aliases preserve that value's identity. Unselected effectful initialization
still fails unless its existing `pureCalls` contract allows discarding it.
The consumer must create one dependency context for a desired singleton lifetime.
This is not automatic porting of the injected factory's browser implementation.

The [helper integration contract](../../tests/component-helpers/README.md)
compiles an unchanged Coss Toast helper through both languages. Full Toast
rendering, provider integration, portals and motion remain unfinished. The data
compiler separately supports [bounded data null](#source-null) and runs the
original Toast store's timeout-free state transitions.
Shorthand fragments use an explicit `fragment` dependency: supply your
application's `React.Fragment`. `sourceFeatures` reports fragment use and the
number of lowered direct `Boolean()` calls. The unshadowed global call accepts
zero or one argument and keeps JavaScript truthiness through roblox-ts; local or
imported functions named `Boolean` retain their ordinary bindings.
Source `typeof` expressions use an explicit `typeOf` dependency, supplied by
`Html.typeOf`. It distinguishes JavaScript primitive categories and maps native
platform objects to `object`. Data `null` remains rejected, and Luau threads
have no representation. `sourceFeatures.typeofExpressions` records this use.
TypeScript handles JSX whitespace, entities and ordering. Props rest uses a small
plain-table helper because roblox-ts does not support parameter rest destructuring.

Render-only `null` results lower to React's empty `false`, keeping nested child
arrays dense in Luau. The pass checks component returns, JSX child expressions,
conditional result branches and non-escaping const aliases using source symbols.
A nullable component selector may be used as a truthiness guard and a JSX tag
inside that guard. `sourceFeatures.renderNulls` records the selected literals.
Data comparisons, `typeof`, nullish left operands, props, mutable aliases and
unproven callback returns keep their `null-value` diagnostic. In particular,
spelling a method `map` does not establish native array semantics. These rules
add no runtime adapter or listeners. The public host `Node` type accepts nested
readonly child arrays already handled by `Html.create` and React Luau.

Primitive-string `startsWith`, `includes` and `endsWith` calls lower to a checked
`strings: Html.StringMethods` dependency. In Luau, require the `Strings` child of
the package ModuleScript: `require(runtime.CssReact.Strings)` in the examples'
Rojo tree. A roblox-ts caller receives the same typed table. The provider uses native plain search
and UTF-8 traversal to retain zero-based UTF-16 positions, including boundaries
inside astral characters, empty searches, fractional positions and NaN/infinity.
It creates no native objects, listeners or recurring work. Source checking keeps
null and undefined in unions; nullable receivers need narrowing. Custom object
methods keep their original meaning. `sourceFeatures.stringMethods` counts
lowered calls. [Source contracts](../../tests/source-strings/README.md) build the
unchanged Coss direction helper and compare the provider with JavaScript.
Boxed strings, arbitrary coercion, lone surrogates, optional method calls and
other JavaScript string operations remain outside this boundary. This is not a
complete JavaScript string runtime. Selected runtime literals and strings
produced by JSX lowering reject lone surrogates before UTF-8 output can silently
replace them.

`kind: 'variants'` binds a CVA import. Static definitions lower to metadata;
`CssReact.Variants.create` supplies selection in Roblox. Literal const aliases,
spreads, default variants, boolean/numeric choices and compound rules are covered.
The compiler normalizes static class values with official `clsx`; metadata version
1 follows CVA 0.7.1. Choices and compound conditions remain ordered lists, without
expanding every combination. Runtime `class`/`className` additions currently accept
strings and empty/falsy values; dynamic class arrays/objects need normalization.

Imported behavior is explicit. Unselected module initializers that could have
effects fail compilation. `pureCalls` can declare an imported factory safe to
discard when its declaration is unused; the Coss example declares CVA pure.
That declaration is a caller-supplied contract, not inferred purity.

Imported component namespaces can declare `members` on a `kind: 'component'`
binding, for example `['Root', 'Label', 'Track', 'Indicator', 'Value']` for Base
UI Progress. The generated dependency is an object with those component
fields. Direct member JSX and declared literal member lookups are supported;
unknown/computed members and using the namespace itself as a JSX component
report diagnostics. The adapter owns each member's actual prop contract.
Bindings can also name an existing platform type to preserve its props and
render-function children:

```ts
{
  module: '@base-ui/react/progress',
  name: 'Progress',
  kind: 'component',
  members: ['Root', 'Label', 'Track', 'Indicator', 'Value'],
  componentType: { module: '@3xjn/roblox-css-react/src/Progress', name: 'Parts' },
}
```

For a single function from a parts object, set `componentType.member`, for
example `'Value'`. The emitted TypeScript uses a type-only import; a namespace
retains only its declared `members`. Supply the same runtime adapter through
the normal factory dependencies. No runtime import, slot wrapper or special
Coss compiler branch is added.

The HTML factory checks required props and the declared child type. Required
children can be supplied in props or the child slot. A typed function child
remains one callback slot with contextual parameter types;
ordinary `Node` children remain variadic. Intrinsic children remain content.
Untyped component bindings keep the existing opaque boundary. Type module
exports/members are checked by downstream TypeScript/roblox-ts, not resolved
by this source-selection pass. This does not make arbitrary namespaces,
browser render-prop APIs or runtime behavior portable. Source emission alone
is not a successful roblox-ts build or native rendering test.

### Style objects

Static JSX `style` literals and const aliases lower through `compileStyleObject`
into the existing CSS declaration IR. Conditional literal branches are supported.
Numeric props and expressions lower to private declaration templates; supply
`numberStyle: NumericStyles.create` from the React runtime when requested by the
generated dependencies. Builders are hoisted; object evaluation order and numeric
alias initializer timing are retained. CSS-tree supplies numeric grammar ranges.
Single numeric template tokens such as `` `${height}px` `` and
`` `${value}%` `` also use this path. Conditional clear branches retain their
original evaluation, so `` height ? `${height}px` : undefined `` omits zero instead
of publishing `0px`. Explicit units are retained even when their numeric value
is zero. Computed names need a single proved string-literal key; their reads and
calls still run in source order and the native builder checks the result.
Mixed-unit branches, arbitrary string construction, runtime CSS parsing and
nonfinite template values remain unsupported.
Mutations or escapes that invalidate static style data are rejected; numeric
aliases may only be forwarded as styles. The build reuses the CSS compiler and
pinned React 19.2.0 unitless-number data (MIT, `LICENSE.react`). Forwarded styles
must already be packets. Runtime strings, uncertain computed keys, opaque value types,
arbitrary props spreads containing styles and client CSS parsing remain
unfinished. See the
[normalization, composition and native scope](../../docs/inline-styles.md#react-style-objects).

## Runtime boundary

`CssReact.Html.create(React, components?)` converts supported intrinsic props for the existing
renderer. It forwards component props to their bound adapters. It creates no
layout wrappers, native instances, listeners or recurring work. Applications
supply fonts, metrics, the stylesheet and native behavior as before.
Intrinsic tags preserve selector identity; a browser default stylesheet is not
supplied by this adapter.

The optional host map binds a source tag to a native behavior component, for
example `{ button = controls.Button }`. A bound host receives its raw source
props; an unbound unsupported tag still fails. `Controls.Button` uses the existing
button primitive and the native `onActivated(input, count)` contract. Its classes
come from the source component.

Declare directly authored native tags through `compileComponent`'s `nativeTags`
option, for example `nativeTags: ['input']`, and supply the corresponding HTML
map at runtime. This is an explicit ownership contract: props such as `style`
and event handlers are left to that adapter's validation. It does not enable
those props on unbound tags or make the browser API available.

`Controls.Input` supplies the existing native text-input hook without Coss
classes or layout wrappers. Pass its renderer's `flushSync` through the third
`Controls.create` argument for controlled editing. The source class helper
`Html.createClassName(merge)` normalizes string classes and scalar conditions
before calling the independent compiled conflict merger. Dynamic class arrays,
objects and nonzero numbers still require explicit normalization.

Raw DOM events, refs, runtime CSS style objects, unsupported intrinsic tags and unknown
spread props need adapters. Source `null`, nested props destructuring,
browser APIs, unbound hook implementations, dynamic CVA definitions, polymorphic rendering and complete
browser component types remain unfinished. Resolvable scalar prop types are
retained; opaque browser/object types keep the generic platform boundary.
Downstream roblox-ts type checking and runtime validation are required.

The renderer can preserve text followed by element children using its existing
leading-text field. Trailing or interleaved text is rejected until the ordered
inline formatter supports it. Compiling JSX does not establish that its layout,
icons, CSS animations or browser behavior are available.
The shared HTML adapter protects nested collections at intrinsic/fragment
boundaries using virtual React fragments; component props remain unchanged.

See the [Coss source example](../../examples/compiled-coss/README.md) for the
current end-to-end path and its verification scope. Its source build uses the
official Tailwind scanner plus normalized CVA class lists to generate a matching
stylesheet and class merger, independently of the legacy demo's variant tables.

`kind: 'mergeProps'` and `kind: 'render'` bind shared prop composition and element
rendering helpers. Their types live at the same checked platform boundary as
component props; the compiler keeps the source calls and generic JSX lowering.
These bindings do not import Base UI's browser runtime. Browser events, refs and
unsupported host behavior still require explicit adapters.

## Hooks and platform values

Use `kind: 'value'` to bind an imported function or value to its native type:

```ts
{
  module: 'react',
  name: 'useState',
  kind: 'value',
  valueType: { module: '@rbxts/react', name: 'useState', typeOf: true },
}
```

Supply the same React instance's `useState` to the generated factory. The type-only
query preserves the native hook's generic signature and `LuaTuple` return; the
compiler does not bundle browser React or implement the hook. `useEffect` uses
the same binding form.

Explicit `globals` bind names such as `setInterval` or a restricted `Math` object
through that factory too. Only referenced names are emitted and reported in
`result.globals`; local declarations keep their scope. Providers own timing,
numeric semantics and cleanup. This does not enable the browser globals.
See [platform value providers](../../docs/platform-values.md) for types,
member restrictions and the source-built Progress particle's native evidence.

## Data modules

`compileDataModule(source, options)` keeps non-UI logic as typed TypeScript for
the ordinary roblox-ts compiler. Unlike component selection, it retains the
whole module's initialization and its exported functions, constants and data
types. Each call to the generated `create(dependencies)` creates one private
module context. Reuse that result wherever the application needs a shared
instance.

```ts
const result = compileDataModule(source, {
  filename: 'createToastManager.ts',
  bindings: [{
    module: '@base-ui/utils/generateId',
    name: 'generateId',
    valueType: { module: './PlatformTypes', name: 'GenerateId' },
  }],
  types: [{
    module: './useToastManager',
    name: 'ToastObject',
    target: { module: './ToastTypes', name: 'ToastObject' },
  }],
  globals: [{
    name: 'Set',
    valueType: { module: './PlatformTypes', name: 'SetConstructor' },
  }],
});
```

Bind every source runtime import/global to a checked native type. Map imported
types separately; their generic arguments remain intact. A target type name
`'*'` imports a native namespace. The generated source still needs a successful
roblox-ts build and native tests. Runtime dependencies are stable values supplied
by the caller; the compiler does not execute or bundle an ESM module graph.

An individual named type binding also applies to the corresponding member of a
namespace import. It overrides that member while retaining the namespace mapping
for other types. A source React 19 `React.RefObject<T>` can therefore map to native
`MutableRefObject<T>` when its nonnullable `current` contract is required. This is
an explicit shared type binding, not a change to every native React ref.

Use `typeSources: [{ filename, source }]` when a source operation depends on an
imported signature, such as `React.useRef<T[]>().current`. These explicit
declaration or implementation inputs establish source types, including relative
imports, reexports and ambient declarations. They are never emitted or executed.
Paths use the same working-directory-relative or absolute convention as
`filename`. The host reads only these inputs and TypeScript's ES standard library;
it does not discover installed packages automatically. Duplicate paths and syntax
errors block emission. Supplementary diagnostics include their filename, and
`result.typeSources` records each input's exact-byte SHA-256. Missing type
information does not justify guessing that a custom hook returns an array.
Checked native value/type bindings remain required separately.

Generic functions, private mutable state, named function expressions and local
export aliases are retained. Object methods that do not observe their own
`this` get a type-only `this: void` parameter so they remain callable after
extraction in Luau. Methods that observe `this` retain their method contract;
named function expressions with dynamic `this` are diagnosed.

Named classes retain their source constructors, fields, inheritance and method
bodies inside the factory context. Exported constructor aliases also expose
generic instance type aliases. A type-only `ReturnType` witness ties those
aliases and public `typeof` queries to the actual returned constructor/value;
it adds no native runtime work. Imported base classes use the same checked
value and type bindings as other dependencies. Each context owns its class
identity and static initialization. Source compilation and native tests cover
this path; standalone declaration emission for returned classes with private
or protected members still fails with TypeScript TS4094. No private members
are erased to work around that limitation.

Named nongeneric classes with colliding static/instance method names use separate
native slots. A shared function backs each moved instance method, so instances
retain method identity and the static side keeps its source name. Method slots
initialize before source fields can call them. This is a bounded native class
ABI: inheritance involving a separated class, nested/anonymous classes, computed
members, colliding accessors/overloads/generators/async methods, prototype access
and deletion need further contracts and are diagnosed. Own-property reflection
on separated method slots is unsupported; this is not a JavaScript prototype
implementation. `classCollisions` records the affected classes/methods, including
in source-project data metadata. Native type checking remains mandatory.

Mutable public bindings, external re-exports, side-effect imports,
top-level await/this, merged class/interface declarations, and module-level
types querying private runtime values need further ownership support.
Private classes may remain inside a context, but lifting their instance types
outside requires a public constructor export. Data `null` requires the explicit
`nulls` binding below; it is rejected without that opt-in. JSX belongs to the component compiler. This
does not supply DOM APIs, React state, timers, portals or a Toast renderer.
The [source data contract](../../tests/data-modules/README.md) builds the
unchanged Base UI manager and generic Store, plus class/import/type contracts,
through Luau and roblox-ts. The Store's imperative API is qualified for the
plain-record inputs described there; its React hook is not supplied.

### Native value boundaries

`typeIs` and `typeOf` accept checked function bindings. Bind them to the functions
from `@3xjn/roblox-css-react/src/SourceType`. The first lowers comparisons such as
`typeof value === 'function'` to a native type predicate, preserving control-flow
narrowing. The second handles standalone classification. These functions are
also shared by the HTML bridge. They classify supported platform objects and the
canonical data-null value as `object`. Symbols and bigint have no runtime
representation. The predicate preserves known callable signatures, including
their specific return types, when narrowing an object/callback union.

Backend-reserved and non-ASCII source locals receive fresh native-safe names
using roblox-ts's identifier policy. Renaming follows source symbols and keeps
public export names, shorthand property keys, shadowing and class instance type
aliases. Ambient declarations supplied through `typeSources` can establish
global types/values; declarations local to the source remain local.

A type binding may declare `getters: { size: 'size' }` to map an ordinary source
property read to a native zero-argument method. Imported types, aliases and
generic constraints retain receiver identity; unrelated objects with a `size`
field are unchanged. Optional reads, writes, deletion, updates and invoking the
source property are diagnosed. Destructuring and general getters/descriptors
remain outside this contract. Method cost belongs to the native implementation:
roblox-ts's current Map `size()` macro counts entries.

`propertyKeyString` binds a formatter for standard, zero-argument `.toString()`
calls on proven primitive property keys. `Records.keyString` handles strings,
safe integers, NaN and infinities, including negative zero. Fractional/unsafe
numbers and symbols fail explicitly with this provider. Custom object methods,
boxed values and unknown receivers remain untouched; optional calls and radix
arguments require another contract. Providers are captured once, used only when
needed, and keep native type checking. Prototype overrides are outside this path.

A literal property initialized by `(target as any).slot ??= new Constructor<T>()`
can retain that constructor's native instance type. This is a type-only change:
the original lazy initialization, receiver evaluation and existing value remain
unchanged. Imported constructors still require their type mapping. It does not
infer arbitrary dynamic properties or validate incompatible external writes.

`unknownReturns: true` changes explicit `any` function results to `unknown`.
It leaves parameter types and generic overloads intact. Further operations must
then satisfy the native checker rather than propagate unchecked result values.
Other unsafe `any` uses still require a typed boundary. The result reports
`typeQueries`, `propertyKeyStrings`, `initializedProperties` and `unknownReturns`.

The original Base UI ReactStore now compiles and has native React tests for its
sync effects, cleanup, controlled values, setters and imperative observers.
The original `useStore`, fast-hook registry and ref initializer also compile and
run with the existing native external-store shim. The original stable callback
also runs with React 17's fallback; rendered Toast remains unfinished. See the [native contracts](../../tests/data-modules/README.md#original-subscription-hooks)
for the tested lifecycle and version boundaries.

### Source null

Opt into data-null semantics with a shared provider:

```ts
nulls: {
  name: 'nulls',
  valueType: { module: '@3xjn/roblox-css-react/src/Nulls', name: 'Provider' },
}
```

Supply `require(CssReactModule.Nulls)` as that dependency in Luau. Each source
`null` becomes its frozen canonical value; `undefined` remains nil. Native
callers use the opaque `Null` type and `Nulls.value`, and must share the same
provider instance across module contexts. Do not construct or clone the marker.

The compiler retains strict null comparisons, loose literal null/undefined
checks, truthiness in conditions and negation, nullable `typeof` guards,
`NonNullable`, lazy `??`, nullable receiver property/index chains, and optional
identifier callbacks. Receivers and operands evaluate once; absent optional
receivers skip indexes/arguments. Literal fallbacks avoid an unnecessary lazy
closure. Nullable object spreads contribute no keys. Shared Records and Arrays
retain null values and distinguish own undefined properties/slots; array
predicates and `join` use the same null semantics. Provider helpers create no
services, instances, listeners or recurring tasks.

Typed nullable callback fields/array slots can be invoked optionally when the
shared call proof establishes a free-function ABI. The callee/index runs once;
arguments remain lazy when it is null. Receiver methods, unknown member callees,
overloads and optional receiver chains still need another invocation contract.
Precise null-valued expressions, including constant aliases and getter/call
results, use the same narrowing predicates as null literals. Both operands still
evaluate in source order, including errors. Reversed comparisons use `nullIs`/
`nullishIs`; right-hand null expressions use the optional observed-null argument
of `isNull`/`isNullish`.

Nullable value-producing `&&`/`||`, nullable `??=` and dynamic loose equality are
diagnosed. Broader coercion, unconstrained
generic truthiness, JSON serialization and data-null interop with JSX/React
remain unqualified. This opt-in does not change the component compiler's
separate render-only null rules; never pass the marker as a rendered child.

With `functions`, an explicit `(value as any).callback` can retain the declared
callable field's type when the source type declares exactly one signature with
`this: void`. Native checking still validates arguments/results. This does not
infer a signature from a property name, make a real method free-standing, or
make an absent asserted callback callable.

### Functions and source-owned types

Data factories initialize source function declarations before executable
statements in their module/block scope. This preserves forward function aliases
that roblox-ts's forward declarations otherwise capture as nil. Implemented
top-level overloads retain their public signatures and one runtime export;
unimplemented ambient functions remain rejected. Injected globals use private
locals, preserving their public dependency keys and source shorthand keys.
Leading `//!` native pragmas stay at the generated header for roblox-ts to handle.

An explicit type binding can use `local: true` to replace a root source-owned
alias/interface with a checked native type. Generic parameters and exports remain
intact. It cannot also name an imported module; missing or duplicate declarations
fail. This boundary is useful for upstream structures containing browser-specific
or unchecked fields. It supplies types, not a runtime implementation or proof of
arbitrary external values. `unknownAssertions: true` makes explicit `as any`
assertions opaque until narrowed; it does not rewrite parameters or infer fields.

Opt into the native function-value contract with:

```ts
functions: {
  name: 'functions',
  valueType: { module: '@3xjn/roblox-css-react/src/FunctionValues', name: 'Provider' },
},
```

Proven callable `.name`/`.displayName`
reads and display-name assignment use weak string metadata. Variable-bound
function literals retain their source name and the same native function identity.
Other native functions fall back to `debug.info` names; exact JavaScript inferred
names for every expression/declaration are not established.

An explicitly unchecked bare-function call such as `(fn as any)(props, ref)`
uses typed native invocation, retaining extra arguments and trailing nils without
packing an array. Optional unchecked calls without source-array spreads, explicit
non-void receivers, function-name writes and compound/deleted metadata need further
contracts. Source-array invocation is covered below. Custom object fields and ordinary calls are left alone. Callable
tables, prototypes and arbitrary function properties are outside this provider.
The result reports `functionValues`, `hoistedFunctions`, `unknownAssertions` and
`nativePragmas`. These mechanisms support the original Base UI fast wrapper;
they are not a complete JavaScript function/object runtime.

With `functions` enabled, an explicit `any` parameter used only as a bare callee
acquires a checked free-function type returning `unknown`. Parameters stored as
data, assigned, read through properties, or escaping via shorthand records keep
their existing boundary. This handles callback-only source fallbacks without
weakening other values. `functionValues.callableParameters` reports this refinement.

### Collection and key traversal

A type binding can declare `iteratorMethod: 'values'`. For example:

```ts
types: [{
  name: 'Set',
  target: { module: '@3xjn/roblox-css-react/src/OrderedSet', name: 'Collection' },
  iteratorMethod: 'values',
}],
forInKeys: {
  name: 'enumerateKeys',
  valueType: { module: './PlatformTypes', name: 'Keys' },
},
```

For a proven collection receiver, `for…of collection` becomes traversal of
`collection.values()`. The native method must return roblox-ts's Generator
ABI (`next()` returning `done`/`value`). Source type/import aliases, declared
fields/parameters, constrained generics, inferred constructors and typed call
results retain their binding identity. Local names do not inherit a global
contract. Other arrays/iterators stay with roblox-ts. The native checker still
owns generic constraints and nullable narrowing. Async consumption is rejected
for this contract. This does not implement JavaScript Symbols or prototype/
iterator overrides.

`forInKeys` explicitly supplies key enumeration. The generated loop captures
that dependency once and evaluates its receiver once; source names cannot
shadow the private helper. Providers own ordering, inherited/deleted keys,
property presence and their accepted object representation. There is no
implicit conversion to `Object.keys`, which would change JavaScript `for…in`
semantics. Unused bindings add no runtime dependency. `result.iterations` and
`result.keyTraversals` report the lowered loops.

### Own record properties

Use the optional `records` binding when a data module needs JavaScript own-property
presence, insertion order, or spreads that overwrite a value with `undefined`:

```ts
records: {
  name: 'records',
  valueType: { module: '@3xjn/roblox-css-react/src/Records', name: 'Provider' },
},
```

Supply `require(CssReactModule.Records)` as that dependency. The compiler keeps one
typed literal, including its methods and contextual `this`, and records its keys
as it evaluates. Spreads capture values immediately. Ordinary property access
still uses the resulting Lua table; weak metadata preserves keys whose value is
nil. Function-local construction variables avoid a closure per ordinary literal.
Defaults and class field initializers use a private lexical construction scope.
The binding is captured once and cannot collide with source identifiers.

Object rest declarations capture the source once and exclude the bound keys.
Deletion removes own presence; assignment to `undefined` retains it. Bind global
`Object.keys`/`Object.hasOwn` explicitly to the same provider. The common
`{}.hasOwnProperty.call(value, key)` idiom is lowered to that own-property check.
Use `Records.enumerate` for an explicitly own-data-only `forInKeys` binding.
`result.recordLiterals` and `result.recordRests` report the affected constructions.

Native callers must use `Records.adopt(table, orderedKeys)` for external records.
The order must cover all physical keys and can include keys with nil values.
Adoption preserves table identity. Raw mutation, cloning a metatable without its
metadata, and foreign object/prototype semantics are outside this boundary.

This is unfinished JavaScript object/array compatibility. Accessors, prototype
initializers, inherited `in` checks, object method `super`, parameter rest, and
dynamic computed rest exclusions are diagnosed. Symbols, object-key coercion,
primitive string spreads and non-safe-integer numeric keys need further providers.
`Object.values` returns source arrays preserving undefined slots and length.
This binding alone does not qualify ReactStore hooks or the Toast renderer.

### Source arrays

Add an `arrays` dependency alongside `records` for modules that use JavaScript
array behavior:

```ts
arrays: {
  name: 'arrays',
  valueType: { module: '@3xjn/roblox-css-react/src/Arrays', name: 'Provider' },
},
```

Supply `require(CssReactModule.Arrays)`. This opt-in uses TypeScript's standard
array types for source proofs, including aliases, tuples, readonly arrays,
generic constraints and standard `Object.keys`/`Object.values` results. Custom
objects with methods named `map` are not changed. Imports still need their
checked native bindings; this does not load an ESM graph or import browser APIs.

Literals, spreads, length reads/assignment and indexed deletion retain logical
length, holes and explicit undefined. Numeric reads still use native table slots.
The provider supplies `map`, `filter`, `forEach`, `some`, `every`, `find`,
`findIndex`, `slice`, `push`, `pop`, `shift`, `unshift`, `splice`, `includes`,
`indexOf`, `join` and `at`. Callback indexes are zero-based; length is captured
for callback traversal and later mutations are observed at each visited slot.
Ordinary array iteration uses the live length. Record keys/values and own-property
checks recognize these arrays too.

`push`, `unshift` and `splice` argument spreads use typed array arguments and
explicit-count native unpacking. Ordinary roblox-ts argument spreading otherwise
drops trailing nils. The adapters keep receiver element types; they do not erase
generic functions or turn methods into untyped callbacks. Supported function
entry/invocation is described below. Rest declarations/bindings, callback `thisArg`,
compound length changes and other array methods remain diagnosed or unfinished. Named
array properties, prototypes/species, custom iterators and object coercion need
further support. Numeric `join` is qualified for safe integers, NaN and infinities;
other number formatting requires a JavaScript conversion provider.

Native arrays must enter through `Arrays.adopt(table, length, presentIndices?)`.
Omit `presentIndices` when every slot is present, including nil-valued slots;
otherwise supply zero-based present indexes. Raw native mutation/cloning does
not maintain this contract. All modules exchanging arrays must share the same
provider. `result.arrayLiterals` and `result.arrayOperations` report lowering.

### Function arguments

The `arrays` binding also supports free-function argument spreads and one-rest-parameter
arrow/anonymous function expressions. Rest collection uses `select('#', ...)`;
call packets expand with their recorded length. Mixed and multiple spreads retain
evaluation order. Optional calls skip argument effects when absent. A single
parameter packet needs no copy or lazy closure; other optional packets are lazy.
Native type checking retains callback parameters/results and rejects incompatible
packets. Explicit source `any` callees additionally require `functions`; that
opt-in does not validate arbitrary external values.

A synchronous rest expression that only returns a free call of its full argument
list can use native forwarding. The resolver runs on every call, so mutable
callbacks stay current. It creates no per-call argument array. The compiler
disables this optimization if the callee observes the rest binding, including via
shorthand, or if the expression has an explicit return annotation. Observed rest
arrays keep their fresh identity, length and own presence. Allocation/work is
proportional to collected/packed arguments; no FPS guarantee is established.

Fixed parameters before rest, generic/named/generator rest expressions, rest
declarations/bindings, dynamic receivers, optional receiver chains and overloaded
callees need further contracts. Source null, custom iterators and function
prototype semantics remain outside this boundary. These cases must not silently
drop a receiver or choose the last overload's result. The result reports
`restFunctions`, `forwardFunctions` and `callSpreads`.

## Repository setup

This repository contains the `@3xjn/roblox-react-compiler` package. It is in active development and has not been published to npm.

Related packages:

- [@3xjn/roblox-css-compiler](https://github.com/3xjn/roblox-css-compiler)

Run `npm install` to install development dependencies from the related GitHub repositories.

Run `npm install` and `npm run build` to compile the TypeScript package. Git installations build its compiled JavaScript through the `prepare` script.

The development gallery and cross-package tests remain in the private [roblox-styling workspace](https://github.com/3xjn/roblox-styling).
