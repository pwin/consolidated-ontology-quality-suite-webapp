# shacl-wasm

WebAssembly bindings for the `shacl` validation engine, for JavaScript hosts:
Node, VS Code extensions, bundlers, and browsers.

Dual-licensed under [MIT](LICENSE-MIT) or [Apache-2.0](LICENSE-APACHE), at your
option. Copyright 2026 Peter Winstanley.

## Why

The JavaScript SHACL landscape thins out sharply once shapes use SHACL-SPARQL
(`sh:sparql` constraints, `sh:target [ a sh:SPARQLTarget ]`). `rdf-validate-shacl`
implements SHACL Core only and reports `conforms: true` against such shapes
rather than failing loudly. `shacl-engine` does implement them, but has two
behaviours that matter in practice:

- some `sh:sparql` shapes make it throw
  `Tried to bind variable ?this in a GROUP BY operator`, taking out every check
  in that shapes file; and
- it silently drops an `sh:severity` declared *inside* an `sh:sparql` block,
  reporting every such result as `sh:Violation` whatever the shape says.

This build has neither. `crates/shacl-wasm/verify.js` checks both against real
shapes, including the ones that defeat `shacl-engine`.

## Install / build

There is no published npm package yet; build it from this repo:

```sh
cd crates/shacl-wasm
node build.mjs            # both targets
node build.mjs nodejs     # just pkg-node/
```

Outputs:

| Directory     | `--target`  | For                                              |
|---------------|-------------|--------------------------------------------------|
| `pkg-node`    | `nodejs`    | `require()` consumers: Node, VS Code extension host |
| `pkg-bundler` | `bundler`   | webpack / vite / rollup (ESM + separate `.wasm`) |

Prerequisites: the `wasm32-unknown-unknown` target
(`rustup target add wasm32-unknown-unknown`) and
[`wasm-pack`](https://drager.github.io/wasm-pack/) (`cargo install wasm-pack`).

`build.mjs` wraps `wasm-pack` to add what it cannot express itself: the two
licence files (wasm-pack copies them into the output, but the `package.json` it
generates has an explicit `files` array and npm's "always include a licence"
rule does not match the suffixed `LICENSE-MIT`/`LICENSE-APACHE` names — verified
with `npm pack --dry-run`), and the `repository` field.

## Use

```js
const { Validator } = require('./pkg-node/shacl_wasm.js');

// Compiling shapes is the expensive half, so compile once and reuse.
const validator = Validator.fromTurtle(shapesTurtle, 'http://example.org/');

const report = validator.validateTurtle(dataTurtle, 'http://example.org/');

report.conforms;   // false when anything has a conformance-blocking severity
report.length;     // number of results
report.results;    // array of plain objects, see below
report.toTurtle(); // the full SHACL report as a Turtle graph
```

Each entry of `report.results`:

```js
{
  focusNode: 'http://example.org/bob',
  path: 'http://example.org/name',        // null for node-level findings
  value: null,                            // null for sh:minCount / sh:closed
  severity: 'http://www.w3.org/ns/shacl#Warning',
  sourceShape: 'http://example.org/PersonShape',
  component: 'http://www.w3.org/ns/shacl#MinCountConstraintComponent',
  message: 'Less than 1 values',
}
```

Terms render the way RDF/JS's `.value` does — an IRI bare, a blank node as
`_:label`, a literal as its lexical form — so this drops into code already
written against an RDF/JS SHACL engine.

Other entry points:

```js
Validator.fromText(text, format, base)                    // turtle|ntriples|nquads|trig|rdfxml|jsonld
validator.validateText(text, format, base, inference)     // inference: "none" (default) | "rdfs"
validator.shapeCount                                      // shapes compiled

const { validateTurtle } = require('./pkg-node/shacl_wasm.js');
validateTurtle(shapesTurtle, dataTurtle, base);           // one-shot, no reuse
```

`inference: "rdfs"` validates against the RDFS closure of the data, so a finding
can depend on an entailed `rdf:type` rather than only an asserted one.

## Notes on the wasm32 build

Three things differ from a native build, each handled in this crate rather than
asked of the caller:

- **No threads.** The engine's Turtle parse splits across cores with rayon,
  which cannot build for `wasm32-unknown-unknown`. This crate depends on
  `shacl` with `default-features = false`, dropping the `parallel` feature; the
  loader then takes the sequential whole-document path it already falls back to
  whenever a document cannot be chunked safely. The two produce an identical
  graph — `parallel_matches_sequential` in the engine pins that.
- **No system clock.** SPARQL's `NOW()` reaches `oxsdatatypes`, whose default
  clock is `std::time::SystemTime` — unimplemented on this target, so evaluating
  any `sh:sparql` constraint panicked with `time not implemented on this
  platform`. `oxsdatatypes` provides for this with a `js` feature that switches
  to `js_sys::Date::now()`; this crate enables it for wasm32 only.
- **No system entropy.** `oxrdf` mints blank node identifiers via `rand`, which
  reaches `getrandom`. getrandom 0.3 has no default source on
  `wasm32-unknown-unknown` and needs both its `wasm_js` feature (set here) and
  the `getrandom_backend="wasm_js"` cfg (set for this target in the workspace
  `.cargo/config.toml`) — its own `compile_error!` is explicit that the feature
  alone is not enough.

Native builds — the CLI, the Python extension module, the test suite — are
unaffected by all three: `parallel` is still a default feature, and the other
two are `cfg(target_arch = "wasm32")`-gated.

## Verifying

```sh
node build.mjs nodejs && node verify.js
```

`verify.js` covers a basic `sh:minCount` violation, compiling all six shapes
files from the Ontology Development Suite's check registry (including the two
that crash `shacl-engine`), an `sh:severity` declared inside an `sh:sparql`
block, and Turtle serialisation of the report.
