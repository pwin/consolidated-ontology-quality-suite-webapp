# Changelog

## 0.10.1

The build actually published. It carries everything since the last published
release (0.9.2): the three check-query fixes in 0.9.3 and the SHACL engine
replacement in 0.10.0, neither of which was ever packaged as a release.

**The SHACL engine is now the `shacl-wasm-node` npm package (0.1.7)** rather
than a copy vendored into `resources/shacl-wasm/`, since it has been
published. Same engine, resolved from `node_modules` like every other WASM
dependency here — so `shaclRunner.ts` no longer threads an extension path
through to `createRequire` an absolute path, and 3.1 MB of binary leaves the
repo. `runShaclChecks(quads, registry)` is back to two arguments.

**Marketplace readiness**: removed `private: true` (which `vsce` refuses to
publish past), resized the icon from 1024×1024/2.5 MB to the 128×128 the
Marketplace actually displays, and added keywords, `homepage`/`bugs` and a
gallery banner. See the README's new "Publishing to the Marketplace" section.

**Dependency licences now ship.** `.vscodeignore` had been stripping
`node_modules/**/LICENSE*` from the vsix. MIT and Apache-2.0 — which is what
nearly every dependency here is — both require the licence and copyright
notice to travel with a redistribution, and a vsix redistributes them. The
245 licence files cost ~1.3 MB against a ~19 MB package.

Net effect on the package: 36.2 MB / 10,646 files at 0.9.3 → **18.8 MB / 567
files**.

## 0.10.0

### SHACL validation moves to a Rust→WASM engine: ~220x faster, and two defects gone

SHACL-SPARQL validation now runs on **`shacl-wasm`**, a WebAssembly build of
the native Rust engine at https://github.com/pwin/SHACL_Engine (v0.1.6),
vendored into `resources/shacl-wasm/`. It replaces `shacl-engine`, the
pure-JS engine used through 0.9.3.

Measured on the extension's own workload — all six registry shapes files
against `examples/ontology/domain.ttl`:

| | `shacl-engine` | `shacl-wasm` 0.1.6 |
|---|---|---|
| time | 71,237 ms | **324 ms** |
| findings | 11 | 11 (identical) |
| severities | `{Violation:2, Warning:1, Info:8}` | identical |
| shapes files that crashed | 2 | **0** |

Two long-standing defects go with it, both previously documented in
`shaclRunner.ts` as engine limitations rather than things we could fix:

- **`shapes/data.ttl` and `shapes/efficiency.ttl` crashed** with `Tried to
  bind variable ?this in a GROUP BY operator`, losing every check in both
  files — so `DAT-001` and `EFF-002` could never fire through the SHACL path
  at all, however the shapes were written. (0.9.3 fixed the *SPARQL*
  formulations of those two checks; this fixes the SHACL half.) All six
  files now compile and run.
- **`sh:severity` declared inside an `sh:sparql` block was dropped**,
  collapsing everything to `sh:Violation`. 0.9.2 worked around that by
  re-reading the declared severity out of the shapes graph in
  `shaclRunner.ts`; that workaround (`extractDeclaredSeverities`) is
  **deleted** — the engine reports the declared severity itself. The
  regression test that pinned the workaround now tests the engine.

`enableShaclChecks` stays, but its rationale is inverted: it existed
because SHACL was the slow tier worth turning off during a tight edit/check
loop, and at ~0.3s it no longer is.

### Dependencies removed

`shacl-engine`, `@zazuko/env-node`, `@rdfjs/data-model`, `patch-package`,
the `patches/shacl-engine+1.1.2.patch` QueryEngine-reuse patch (0.9.x), the
`postinstall` hook that applied it, and the `@comunica/query-sparql-rdfjs-lite`
version override are all gone — that whole Comunica-lite dependency tree
came in solely for SHACL. The three RDF/JS shims in `vendor-shims.d.ts` go
with them.

### Notes

`runShaclChecks` is now **synchronous** and takes the extension path (to
locate the vendored module), and hands the data graph to the engine as
N-Triples so nothing depends on what prefixes a merged graph happens to
carry. Its `ResultRow` output shape is unchanged, so the merge, diagnostics
and Quick Fix paths are untouched.

Side effect worth noting: `shaclRunner.test.ts` used to be the suite's
flaky test, timing out at 30s under parallel load. It now runs in ~2s.

## 0.9.3

### Fixed: three check queries -- two never fired at all, one raised false positives

Ported from `consolidated_ontology_suite_python`, which fixed all three
against rdflib/pyshacl. **Each was independently confirmed to reproduce
under this project's own engine (Oxigraph) before porting** -- different
engine, so the upstream report alone wasn't evidence -- and each is pinned
with a regression test verified to fail against the old query and pass
against the new one.

- **`DAT-001`** (literal lexical form contradicts its declared datatype)
  **never fired at all.** Against a fixture with `"not-a-date"^^xsd:date`,
  `"twelve"^^xsd:integer` and `"maybe"^^xsd:boolean`, it returned zero
  findings. Cause: a `UNION` whose branches contain only `FILTER`s and no
  triple pattern of their own silently matches nothing. This is the *same*
  failure mode this project already hit and documented while writing
  `CNF-003`/`CNF-004` -- it was latent in `DAT-001` the whole time. Fixed by
  collapsing the three branches into one `FILTER` with explicit `&&`/`||`.
- **`EFF-002`** (excessive blank-node ratio) **never fired at all**, for the
  same reason -- its `{ BIND(?s AS ?node) } UNION { BIND(?o AS ?node) ... }`
  has no triple pattern in either branch. Confirmed against a graph that is
  50% blank nodes (threshold is 20%): zero findings before, correct finding
  after. Fixed by giving each branch a real triple pattern.
- **`STY-004`** (`skos:prefLabel` disagrees with the URI local name) raised
  **false positives on any hyphenated URI**. It stripped only underscores
  from the URI side (`REPLACE(..., "_", "")`) while stripping *all*
  non-alphanumerics from the label side, so `ex:has-name` +
  `skos:prefLabel "has name"` compared `"has-name"` against `"hasname"` and
  reported a mismatch that isn't one. Both sides now strip
  `[^A-Za-z0-9]`.

The two SHACL shapes carrying the same `DAT-001`/`EFF-002` logic
(`shapes/data.ttl`, `shapes/efficiency.ttl`) were ported in step, keeping
`resources/checks-registry/` byte-identical to upstream. Note this does not
make those two checks reachable via the SHACL path here: both files still
crash `shacl-engine`'s SPARQL plugin with `Tried to bind variable ?this in a
GROUP BY operator`, a pre-existing limitation already documented in
`shaclRunner.ts` and unchanged by this port (verified explicitly: 2 crashing
shapes files before, 2 after). The SPARQL path now covers both checks
correctly, which is what actually reaches the Problems panel.

Upstream also documents a blank-node focus-node cross-join bug in its *own*
native Rust SHACL engine (N focus nodes yielding N² findings). That engine
isn't used here and the bug does not apply to `shacl-engine`.

## 0.9.2

### Fixed: SHACL findings all reported as `Violation`, ignoring the severity the shape declares

Found by diffing this project against `consolidated_ontology_suite_python`
(the further-developed successor of the `consolidated_ontology_suite` this
extension's checks registry was copied from), whose own 0.3.3 external
review flagged the identical problem in pyshacl. **The same bug was present
here**, independently confirmed against real fixtures rather than assumed
from the upstream report:

`shacl-engine` silently drops `sh:severity` when it's declared *inside* a
shape's `sh:sparql [ a sh:SPARQLConstraint ; ... ]` block -- which is where
17 of the 19 severity declarations in `resources/checks-registry/shapes/`
sit. Against `examples/ontology/domain.ttl`, all 11 SHACL findings came back
`Violation`, even though `STR-003` declares `sh:Warning` and `STY-003`
declares `sh:Info`. The *same* checks' SPARQL-CONSTRUCT counterparts
(`sparqlRunner.ts`, same registry) correctly reported 9 Info / 3 Warning /
2 Violation -- so the two engines contradicted each other on identical
findings, and **8 rows survived the merge into the Problems panel as red
errors that the registry says are Info/Warning**.

Fixed in `checks/shaclRunner.ts` by reading each shape's declared
`sh:severity` out of the shapes graph (`extractDeclaredSeverities`) and
applying it to that shape's results. A severity declared directly on the
shape -- the spec-proper location, which the engine already honors -- still
wins, so this can only correct a dropped value, never override one the
engine got right. Deliberately *not* fixed by rewriting the shapes, so
`resources/checks-registry/` stays byte-identical to the copied-in upstream
registry (verified during the same comparison: all 6 shapes files, all 39
shared SPARQL checks, and every repair template match upstream exactly).

Upstream resolved this by switching to a native SHACL engine; that isn't an
option here, since `shacl-engine` remains the only pure-JS engine
implementing SHACL-SPARQL at all. Pinned with a regression test asserting
the actual per-check severities rather than just "some severity".

### Fixed: raw NUL bytes in `checks/merge.ts` made it invisible to `grep`/ripgrep

Incidental find while running the comparison above (not an upstream issue --
`merge.py` uses a native tuple key and needs no separator). `mergeResultRows`
correctly uses `U+0000` to join its dedup key's fields, since a JS `Map`
needs a string key and NUL is the one separator that can't occur inside an
IRI or literal value. But it was written as *raw NUL bytes* in the source,
which made the whole file register as binary (silently skipped by ripgrep,
so it never appeared in content searches) and render as plain spaces in most
editors -- one "tidy up those odd spaces" edit away from silently
reintroducing key collisions. Now written as `\u0000` escapes: byte-identical
at runtime, file is text again, with a comment explaining why the separator
is what it is.

## 0.9.0

### Generate Documentation, wired to the Python CLI's `docgen`

New command, **Ontology Suite: Generate Documentation (Python CLI)** --
closes out the "docgen/version-diff command wiring" item that had sat on
the Roadmap since the original plan (version-diff is still unwired).
Shells out to `ontology-suite docgen --ontology ... --out-dir ...`
(confirmed against the actual CLI source in `consolidated_ontology_suite`,
not assumed: exact flag names `--instances`/`--ref`/`--prefix`/`--template`,
and the hard-coded output filename `ontology-documentation.html` traced
through `pipeline.py::run_docgen_stage`), producing a real HTML reference
page (classes, properties, per-class diagrams).

No prompts for the common case -- `--ref` (which resolves external terms'
labels/comments in the output, e.g. for an imported gist class) is
auto-populated from `resolveImports.ts`'s own local-first import
resolution, the exact same mechanism every other command here already
uses; `--instances` is picked up automatically if a conventionally-named
`instances.ttl` sits alongside the ontology (matching the same
same-directory convention `webviews/queryWorkbench.ts`'s ontology lookup
already uses). Output goes to `<ontology-dir>/out/docgen/`, with an "Open
in Browser" action once it's done.

`ontology/resolveImports.ts` now also returns `resolvedFilePaths` (the
on-disk paths of every import it actually resolved) alongside its existing
`mergedQuads`/`report` -- purely additive, no existing caller's destructured
shape changes -- specifically so this command (and any future one) can
reuse real import resolution instead of re-deriving file paths from
scratch.

## 0.8.0

### Sort Document / Clean Document

New commands: **Sort Document (Alphabetically)**, **Sort Document (By
Type)**, and **Clean Document** (removes unused `@prefix` declarations,
then sorts by type). Motivated by a competitor-research pass (Mentor for
VS Code, github.com/faubulous/mentor-vscode) which offers comparable
commands built on its own published Chevrotain-based CST parser/serializer
packages (`@faubulous/mentor-rdf-parsers`/`-serializers`). Those packages
were evaluated directly (not just read about) and rejected for this
project: real testing found `chevrotain@>=12` (used by every still-relevant
release of `mentor-rdf-parsers`, back through 1.7.2) throws
`TypeError: Object.groupBy is not a function` on import -- an ES2024 API
Node only shipped starting in v21, incompatible with this project's
current v20 toolchain. Pinning back further to the `chevrotain@11`-based
1.0.0-1.7.1 line would mean depending on an old, independently-unverified
release just to dodge a runtime wall.

Built instead as a dependency-free, text-block-based heuristic consistent
with this project's existing style (`language/termIndex.ts`'s statement-
span scan, `language/completionContext.ts`'s position heuristic):
`ontology/documentSort.ts` splits a document into `@prefix`/`@base`
declarations, a floating preamble (any comment separated from the next
statement by a blank line -- e.g. a file header), and one block per
top-level statement (each keeping its own directly-attached leading
comment). Reordering only ever moves whole blocks; no block's own text is
ever reparsed or reformatted, so nothing is reformatted and no comment is
lost. Confirmed lossless at the RDF level and idempotent by a real-fixture
test against `examples/tutorial/clinic.ttl` (parses to the identical quad
set before/after, and organizing an already-organized document produces
byte-identical output).

**Real bug found and fixed while building this** (not hypothetical): the
statement-span scanner this reuses (`language/termIndex.ts`'s
`findStatementRange`, added for the Outline click-to-reveal feature)
didn't account for a literal `.` appearing *inside* an IRIREF -- e.g.
`<http://example.org/clinic>` contains a `.` in "example.org" that was
being mistaken for the statement's terminator, silently truncating the
ontology header mid-declaration. It had gone unnoticed because a
slightly-short text *selection* still looks mostly right; splitting a
document into blocks made the resulting duplicate/orphaned block
impossible to miss. Fixed by extracting the statement-range logic into a
new pure module (`language/statementRange.ts`, no `vscode` import, so it's
directly unit-testable and reusable by `documentSort.ts`) and having it
strip IRIREF contents the same way it already stripped quoted-string
contents before scanning for the terminator. `termIndex.ts` now wraps this
shared logic rather than duplicating it.

## 0.7.0

### New check: closed-world vocabulary check (`VOC-001`)

SHACL's open-world semantics never flag "used `ex:Dgo`, meant `ex:Dog`" --
nothing *contradicts* an undeclared class/property existing, it's simply
never asserted to. `VOC-001` (`src/checks/vocabularyChecks.ts`) closes that
gap: it walks every triple's predicate (always a property reference) and,
for a fixed set of term-referencing predicates (`rdf:type`,
`rdfs:subClassOf`/`subPropertyOf`/`domain`/`range`,
`owl:equivalentClass`/`disjointWith`/`inverseOf`/`onProperty`/`onClass`/
`someValuesFrom`/`allValuesFrom`, `sh:targetClass`/`class`/`path`), its
object too, flagging any IRI that isn't declared as a class/property/
individual/annotation-property anywhere in the document or its resolved
imports.

Deliberately scoped to namespaces the graph has *some* closed-world
knowledge of -- at least one declared term already exists there --
otherwise every ordinary reference to an unimported external vocabulary
(`dcterms:`, `foaf:`) would misfire as a false positive. `rdf:`/`rdfs:`/
`owl:`/`sh:`/`skos:`/`xsd:` are excluded the same way, automatically: no
ontology declares e.g. `owl:Class a owl:Class` itself, so those namespaces
never accumulate any declared terms to become "known" in the first place --
no hardcoded exemption list needed. Verified against every real fixture in
`examples/` (clinic+core, the gist v11/v14 migration set, the Manchester
restrictions demo) with zero false positives before wiring it into `Run
Local Checks`; a deliberately-injected typo in each of predicate and object
position was confirmed caught. New `ontologySuite.enableVocabularyChecks`
setting (default on), following the same on/off pattern as the SPARQL/SHACL
toggles.

### Ontology Outline: click a term to see it, everywhere

Left-clicking any class/property/individual in the Ontology Outline now
does two things at once, instead of just placing the cursor:

- **Jumps to its full definition**, not just the CURIE token -- the whole
  Turtle statement (every triple about that subject, found via a bracket/
  string-literal-aware statement-span scan since N3 doesn't report source
  positions) is selected and centered in the editor.
- **Refocuses the graph view** on that term's neighborhood. A single
  extension-managed panel is reused across clicks (opened automatically on
  the first one) rather than piling up a new webview tab per term, and it
  never steals focus back from the editor -- browsing the Outline reads
  like Protégé's synchronized class/annotation panes, not like triggering
  a separate command per click. The manual "Visualize Subject Graph"
  command now targets this same shared panel.

### Real fix: SHACL validation was re-bootstrapping a Comunica query engine per constraint

`ontologySuite.enableShaclChecks`'s Validator-caching (added earlier)
claimed to make repeated SHACL runs in one session cheap, but timing real
runs against `examples/tutorial/clinic.ttl` showed three consecutive "warm"
runs all costing ~6.7s each -- the cache wasn't buying anything close to
what its own comment claimed. Root cause, found by reading `shacl-engine`'s
own source: its SPARQL plugin (`lib/sparql.js`) constructs a **brand new**
Comunica `QueryEngine` on every single `sh:sparql` constraint/target
evaluation -- once per focus node, not once per `validate()` call -- even
though Comunica's own docs recommend building one `QueryEngine` and reusing
it across queries. Fixed via `patches/shacl-engine+1.1.2.patch`
(`patch-package`, reapplied automatically on `npm install` via
`postinstall`): a module-scope singleton `QueryEngine` in `sparql.js`, no
change to which sources/bindings each query runs against. Same 18 findings
against the same fixture before and after -- confirmed correctness held,
not just speed: warm runs dropped from ~6.7s to ~1.1s (roughly 6x).

## 0.6.0

### Protégé-style Ontology Outline actions

Right-click (or hover for an inline `+` icon on) any class or property node
in the Ontology Outline -- not just the file root -- for **Add Subclass**,
**Add Sibling Class** (inherits the sibling's own parent(s), not just a
copy of the sibling), or **Add Sub-property** (object/datatype, matching
the clicked property's own kind). **Add Subclass** optionally accepts a
real Manchester class-expression restriction (e.g. `hasChild some Person`),
parsed and rendered by the same `classExpression.ts` engine `.omn` files
already use, retrying in place on a parse error rather than discarding what
was typed. The Outline is also now a real drag-and-drop target: dragging a
class/property onto another of the same kind adds it as an *additional*
parent, deliberately additive-only -- the dragged term keeps whatever
parent(s) it already had, and the confirmation message says so explicitly,
consistent with this project's append-only editing philosophy everywhere
else (scaffolding, Quick Fix, script output).

### Scripting: build an ontology as TypeScript code

New **"Ontology Suite: Run Ontology Script"** command, and a small DSL
(`ontology-suite/dsl`: `defclass`/`defobjectproperty`/`defdatatypeproperty`
with `subClassOf`/`equivalentClass`/`disjointWith`, and restriction-builders
`some`/`only`/`hasValue`/cardinality/`and`/`or`/`not`) importable from a
plain `.ts` file -- full VS Code IntelliSense/type-checking, not a custom
language. Inspired by [Tawny-OWL](https://github.com/phillord/tawny-owl)'s
approach of using a real language's loops/functions for ontology patterns
that don't fit a one-term-at-a-time GUI. Scripts run in a forked child
process (a real process boundary, not the extension host) via an esbuild
in-memory transpile; output is applied append-only by default, with an
explicit-confirmation whole-file-replace option, matching every other
scaffold/repair flow in this project. No new testing story was built --
**Run Local Checks** and `.cq.rq` competency questions already validate
any graph, script-generated or hand-authored. See TUTORIAL.md Part 11 for
a full worked example (a loop-generated breed-class family, `disjointWith`,
and a `some()` restriction, verified against Local Checks and the
reasoner).

### Graph View: visualize the reasoner's inferred closure

New **"Show inferred (reasoner closure)"** toolbar checkbox. When enabled,
runs the same EYE reasoner as *Run Local Checks* against the current
neighborhood and overlays whatever additional triples it derives (e.g. a
subclass-chain-entailed `rdf:type`) as dashed purple edges alongside the
asserted graph's normal solid edges -- the same "asserted vs. inferred"
distinction `REA-DISJOINT`/`REA-SAMEDIFF` findings already report as text,
now visible directly on the graph. Computed once per panel and cached, so
toggling other decluttering controls afterward doesn't re-run the reasoner.

**Bug, found and fixed before it reached users**: the first end-to-end test
of this feature showed five inferred edges where only one was expected --
four of them turned out to be the reasoning engine's own internal
bookkeeping triples (the blank-node scaffolding `runReasoningChecks` uses
internally to explain a `REA-DISJOINT` finding), not genuine domain-level
inferences. Fixed by exporting the reasoner's internal namespace constant
and filtering any quad that touches it out of the "inferred" set before
diffing against the asserted graph.

## 0.5.0

### Graph View: more decluttering controls, PNG export

Four new controls in the graph webview's toolbar, on top of 0.4.0's
pan/zoom and Download SVG:

- **Hide `rdfs:isDefinedBy` edges** -- a dedicated checkbox, separate from
  "Hide annotation edges": `isDefinedBy` is "which ontology defines this
  term" bookkeeping that tends to point at a handful of hub nodes (the
  ontologies themselves), cluttering the layout more than
  label/comment/definition edges do.
- **Layout direction dropdown** (`LR`/`RL`/`TB`/`BT`) -- previously
  hardcoded to `LR`.
- **Hide imported terms' downstream** -- stops traversal at the boundary
  of the main document's own subjects. An imported class/property
  referenced by the document still appears as a leaf node (so you can see
  *that* it's used), but none of *its own* further connections from the
  imported ontology are pulled in -- decluttering a large imported
  upper/foundational ontology's internal structure out of the picture
  without losing the fact that the main document references it. Still
  expands normally if you explicitly pick an imported term as one of the
  selected root subjects.
- **Download PNG**, alongside the existing Download SVG. Graphviz's own
  WASM build (`@viz-js/viz`) has no PNG output at all -- confirmed
  directly: `renderString`'s `format` option only accepts vector/text
  formats (svg, dot, json, ps, eps, ...), no rasterization plugin is
  compiled in. PNG rasterization runs via `@resvg/resvg-wasm` (the WASM
  sibling of the native `@resvg/resvg-js` this project tried once before
  for the README's graph image and didn't keep as a dependency -- WASM
  avoids the same cross-platform native-binary distribution problem here
  too). Saving a PNG also opens it in a new editor tab via VS Code's
  built-in image preview, so download and view are the same action rather
  than two separate UIs.

**Bug, found and fixed before it reached users**: the first PNG export
attempt produced valid PNGs with correct shapes/colors/borders but
completely blank text -- every node box empty. Root-caused via a real
pixel-content check (not just PNG-signature validity, which is all the
original test asserted): `resvg-wasm`'s `font.loadSystemFonts: true`
default silently finds zero fonts in this Node/WASM context (WASM has no
OS font-enumeration API the way native resvg-js's `fontdb` does), and
resvg renders missing glyphs as nothing, with no error. Fixed by bundling
an explicit font (`resources/fonts/roboto-latin-400-normal.woff2`, Roboto,
SIL OFL 1.1 -- license text alongside it) and supplying it via
`font.fontBuffers`; confirmed resvg's font parser accepts WOFF2 directly,
no raw TTF/OTF needed. The regression test added alongside the fix
inspects actual rendered pixel darkness in the text region, specifically
because a PNG-signature-only check is exactly what let this ship in the
first place.

## 0.4.0

### New checks: `CNF-003`/`CNF-004`, real implementations for the first time

The registry has always listed `CNF-003` ("rdfs:domain violation") and
`CNF-004` ("rdfs:range violation"), but neither had a local implementation
before now -- like `CNF-001`/`CNF-002`, they were Python-CLI-only. Both are
now real SPARQL CONSTRUCT checks (`resources/checks-registry/sparql/
conformance/`), and both recognize gist's `domainIncludes`/`rangeIncludes`
annotation properties as equally valid declared domain/range, matched by
local name (the same technique `STR-003.rq` already established), not just
`rdfs:domain`/`rdfs:range` -- otherwise neither check would ever fire on
gist-based data at all, since gist deliberately favors the soft annotation
properties for most shared properties.

- Domain/range matching walks `rdfs:subClassOf*` so a subject/value typed
  as a *subclass* of the declared domain/range correctly doesn't count as
  a violation, not just an exact type match.
- A subject/resource-object with no asserted type at all is never flagged
  here -- that's `STR-009`/`STR-006`'s job ("untyped subject/object of a
  triple"), so the two check families don't double-report the same gap.
- `CNF-004` covers both range shapes a declared range can take: literal
  values by exact datatype IRI, resource values by asserted type (or
  ancestor).
- Found and routed around a real Oxigraph quirk while building this: a
  `UNION` branch that is *only* a `FILTER` (no triple pattern of its own)
  produces silently wrong (empty) results when combined with
  `FILTER NOT EXISTS`, or even at the top level of a `WHERE` clause paired
  with a sibling branch that has no matching data -- confirmed via an
  isolated repro, not assumed. `CNF-004.rq` is written to avoid the shape
  entirely (one `FILTER` combining cases with `&&`/`||`/`EXISTS` instead of
  a `UNION` of two filter-only groups), and the query's own comments
  document why.

### Autocomplete/scaffolding: always the current (w3id.org) gist namespace

- `rdf/vocab.ts`'s `WELL_KNOWN_PREFIXES` now includes `gist` (bound to the
  w3id.org 14.1.0 namespace), so `gist:` term completion, project-rules
  CURIE resolution, and prefix-name completion all work even before a
  document declares `@prefix gist:` itself -- previously gist was only
  ever offered if the current file had already declared *some* namespace
  for it, correct or not.
- The New Ontology wizard's `owl:imports` picker (gist, schema.org, SKOS,
  Dublin Core Terms, PROV-O) now also inserts the matching `@prefix`
  binding for each pick, deduplicated against the base prefixes already in
  every new file (SKOS is both) -- previously picking any of the five only
  added `owl:imports`, leaving the file unable to actually use `gist:`/
  `schema:`/etc. as a CURIE without the user adding the declaration by
  hand first.
- The gist namespace constant is now defined once (`rdf/vocab.ts`'s
  `GIST`) and referenced everywhere it was previously a separate hardcoded
  string literal (`projectStandardsCore.ts`'s default standards,
  `extension.ts`'s "add gist: prefix" quick-fix), so it can't drift out of
  sync with itself again.
- Default example base IRIs (New Ontology wizard, Infer-from-CSV draft,
  default project standards) changed from `http://example.org/x#` to
  `https://example.org/x/` -- `https://` and slash-terminated, matching
  `QUA-008`'s own check ("Ontology or version IRI does not use the
  https:// scheme") instead of failing it by default out of the box.

### Graph View: pan/zoom, download, and turtle-editor-viewer-matched styling

- Scroll/pinch to zoom, drag to pan -- a small hand-rolled CSS-transform
  viewport, not a bundled pan/zoom library (the webview's CSP only allows
  this page's own nonce'd inline script, no CDN/bundled dependency to
  load).
- **Download SVG** button, round-tripped through the extension host
  (`vscode.window.showSaveDialog` + `vscode.workspace.fs.writeFile`) since
  a webview can't write arbitrary files to disk directly.
- Node shapes/colors now match `turtle-editor-viewer`'s own
  `graph-generator.ts` (which `graph/dotGenerator.ts` was originally
  ported from): rounded boxes throughout, literal nodes in blue, blank
  nodes in orange -- previously literals used a distinct filled "note"
  shape and blank nodes had no color treatment at all, a visual style that
  had drifted from the source project during the original port.

### Settings: toggle SPARQL/SHACL checks independently

`ontologySuite.enableSparqlChecks` / `ontologySuite.enableShaclChecks`
(both default `true`). Measured directly against this project's own test
fixtures: the SPARQL CONSTRUCT check suite runs in ~0.2s via Oxigraph, the
SHACL-SPARQL shapes suite takes ~10s via `shacl-engine`'s Comunica-based
SPARQL layer -- roughly 50x slower for a same-sized check suite, because
Comunica is a much heavier, general-purpose federated query engine
compared to Oxigraph's purpose-built native/WASM store, and `shacl-engine`
instantiates it fresh per shapes file. Turning off SHACL checks gives a
noticeably tighter edit/check loop on a large ontology, at the cost of
missing SHACL-only findings.

### Documentation

README's Settings section rewritten as **Configuration**, distinguishing
VS Code settings (behavioral toggles, User vs Workspace scope) from the
`.ontology-suite/*.json` project config files (committed alongside the
ontology, not a VS Code setting at all) -- with explicit guidance on which
belongs where when personalizing the extension to yourself vs. to your
project/team.

## 0.3.0

### Quick Fix: SPARQL-based repair, in the same spirit as Schematron Quick Fix

Findings from the local checks engine can now offer a real, one-click
lightbulb fix, not just a diagnosis.

- **`checks/repairEngine.ts`**: each fixable check has a real SPARQL 1.1
  Update template (`resources/checks-registry/repairs/*.ru`). The
  finding's own `ResultRow` (`focusNode`/`path`/`value` -- the same
  normalized shape every engine already produces) is bound into the
  template via an injected `VALUES` clause, alongside a project's
  resolved standards and a `?derivedLabel` humanized from the focus
  node's local name, then executed as a real SPARQL Update against an
  isolated in-memory Oxigraph store built from *only the open document's
  own quads* -- a fix never reaches across file boundaries into an
  imported ontology, and safely no-ops (no edit at all) if the triple it
  targets isn't actually present locally.
- **15 checks covered**: `STR-001/002/005/007/008` (declare an
  undeclared class/property), `QUA-001/002/004/005/007` (missing
  label/prefLabel/versionInfo/versionIRI/ontology declaration),
  `LOG-003`/`MDL-002` (policy-driven: which of a redundant pair of axioms
  to keep, and whether `equivalentClass` becomes `subClassOf` or
  `skos:closeMatch`), `MDL-001` (remove a named inverse property),
  `MDL-003` (retype to the project's category class), `STY-003` (tag an
  untagged label with the project's default language). `DAT-003` and
  `CNF-001`/`CNF-002` were scoped out: the first is a genuine judgment
  call (RDF is set-based, so "duplicate" literals differing only in type
  aren't safely mergeable by a machine), the other two don't exist as
  SPARQL/SHACL files in this engine at all (Python-native only upstream).
- **`checks/projectStandards.ts`**: a workspace-local
  `.ontology-suite/standards.json` (path configurable via
  `ontologySuite.projectStandardsPath`) supplies the project-specific
  values that complete a repair -- default language tag, category class,
  `equivalentClass`/redundant-axiom policy, default ontology base
  IRI/version. This is the flagship scenario the feature was built for:
  the *same* `MDL-003` finding retypes a class to `gist:Category` on one
  project and to a project-local `ex:Classification` on another, purely
  from configuration.
- **`checks/classRules.ts`** + **`checks/classRulesLoader.ts`**: a second,
  simpler project-configuration surface -- `.ontology-suite/class-rules.json`
  declares "minimum required content" rules (e.g. every `owl:Class` needs
  `rdfs:label`; every `owl:ObjectProperty` needs `rdfs:domain`+`rdfs:range`)
  as plain JSON rather than hand-written SHACL, so VS Code's built-in JSON
  language support gives autocomplete/validation for free (schema at
  `resources/checks-registry/class-rules.schema.json`, wired through
  `contributes.jsonValidation`). Findings (`PRJ-REQUIRED`) flow through the
  same diagnostics/repair pipeline as every other check -- a missing
  `rdfs:label`/`skos:prefLabel` is auto-fixable the same way `QUA-001`/
  `QUA-004` are; structural predicates like `rdfs:domain`/`rdfs:range` have
  no safe auto-generated value and are correctly left as a flagged finding
  with no Quick Fix offered.
- **Every repair is preview-then-apply, with no auto-apply path anywhere**:
  selecting a Quick Fix opens a modal listing the exact triples (`+`/`-`,
  CURIE-shrunk) it would add/remove, names the specific check, and warns
  explicitly when a fix reformats the whole file (the `replace`-kind
  fixes -- anything that deletes an existing triple -- can't in general be
  spliced into arbitrary hand-authored Turtle without a real
  parser-preserving editor, so those reserialize the whole document
  instead of appending). Nothing is written until "Apply Fix" is clicked;
  dismissing the modal in any way makes no change. `insert`-kind fixes
  (the majority) append a new Turtle block instead, preserving the rest of
  the file's formatting/comments exactly, the same approach `ontology/
  scaffold.ts`'s Add Class/Add Property commands already use.
- **New settings**: `ontologySuite.projectStandardsPath` (default
  `.ontology-suite/standards.json`), `ontologySuite.projectRulesPath`
  (default `.ontology-suite/class-rules.json`).
- **`examples/tutorial/`**: `.ontology-suite/standards.json` and
  `.ontology-suite/class-rules.json` fixtures, plus a small addition to
  `core.ttl`/`clinic.ttl` (`ex:Classification`, `ex:Vaccination`) so the
  tutorial's existing `MDL-001`/`002`/`003` smells have real, working
  Quick Fixes to demonstrate, and the new `PRJ-REQUIRED` check has a
  genuine missing-label finding to fix.
- 23 new unit tests (`repairEngine.test.ts`, `classRules.test.ts`,
  `projectStandardsCore.test.ts`) covering every template, both policy
  branches of `LOG-003`/`MDL-002`, the label-only auto-fix boundary on
  `PRJ-REQUIRED`, and the cross-file safe-no-op case.
- Marketplace packaging metadata added: `license` (MIT, matching the
  existing `LICENSE` file), `icon`, `repository`.

## 0.2.0

### Test suite and tutorial

- **`TUTORIAL.md`**: a full step-by-step walkthrough of every feature,
  built around two real fixture sets: `examples/tutorial/` (a coherent
  "veterinary clinic" ontology -- `core.ttl` imported by `clinic.ttl`,
  instance data, a CSV-to-RDF triplification example with a deliberately
  undeclared property, and two competency questions, one red and one
  green on purpose) and `examples/gist/` (two real, unmodified `gist`
  releases -- v11.0.0 and v14.1.0, copied from
  `consolidated_ontology_suite` -- used for a genuine "ontology written
  against an older upstream version, checked against a newer one"
  scenario: gist moved its entire namespace between these versions while
  keeping local names identical, so a workspace upgraded to gist14.1.0
  without updating the `gist:` prefix binding gets real unresolved-import
  and dangling-superclass findings, and the fix is exactly two lines).
- **`npm test`** (Vitest, new dev dependency): 98 tests across 22 files,
  covering every pure-logic module against the fixtures above. Nothing in
  `TUTORIAL.md` is aspirational -- everything it describes is also
  asserted by a test.
- **`npm run test:integration`** (`@vscode/test-cli` + `@vscode/test-electron`,
  new dev dependencies): launches a real, headless VS Code Extension
  Development Host -- activation, command registration, language
  assignment, and a full Run Local Checks run against `clinic.ttl`
  asserting real diagnostics land in the Problems panel. Confirmed
  working in this environment (4/4 passing, ~35s including first-run VS
  Code binary download).
- Building this surfaced and fixed two real bugs:
  - **`shacl-engine` crashing on real ontology data**: the `Tried to bind
    variable ?this in a GROUP BY operator` crash (see the "Fixed while
    investigating" entry below) turned out to still occur for some
    registry shapes (`data.ttl`, `efficiency.ttl`) against a real,
    richer ontology, even with Comunica pinned to 5.2.3 -- confirmed
    data/query-shape-dependent, not resolved by the version pin alone.
    `checks/shaclRunner.ts` now validates **one shapes file at a time**
    instead of merging all six into one Validator, so a crash in one file
    only costs that file's findings instead of silently zeroing out the
    other five's real results (22 real SHACL findings recovered against
    `clinic.ttl` that were previously lost entirely).
  - **`triplify/discovery.ts`'s `findPair` never searched sibling
    directories**: every example fixture in this repo (including the ones
    that shipped in 0.1.0) puts CSVs and queries in sibling `csv/`/
    `queries/` folders, but `findPair` (which the Query Workbench's live
    preview depends on) only ever searched the *same* directory as the
    given file -- meaning the live preview never actually found its
    paired CSV for that layout. Now falls back to sibling directories of
    the parent when the same-directory search comes up empty.
  - Smaller: `rdf/ontologyModel.ts` treated `skos:example` (and a few
    other purely-documentary predicates) as "real structure" for the
    MDL-003 gist:Category heuristic, caught by a test expecting a
    deliberately structure-less class to be flagged and it wasn't.

### Multi-serialization support

Read, write, and convert between Turtle,
TriG, N-Triples, N-Quads, RDF/XML, and OWL Manchester Syntax.

- **Turtle / TriG / N-Triples / N-Quads** — handled directly by N3.js (one
  Turtle-family grammar covers all four; no new dependency).
- **RDF/XML** — read via `rdfxml-streaming-parser`; written by a
  hand-rolled serializer (`rdf/formats/rdfxml.ts` — no
  `@rdfjs/serializer-rdfxml` or equivalent exists on npm).
- **OWL Manchester Syntax** — no npm package exists for this at all.
  Built from scratch (`rdf/formats/manchester.ts` +
  `rdf/formats/classExpression.ts`): a real hand-rolled tokenizer and
  recursive-descent parser for the Manchester class-expression grammar
  (`and`/`or`/`not`/`some`/`only`/`value`/`Self`/`min`/`max`/`exactly`,
  parenthesization, `{individual, sets}`), translating to and from the
  standard OWL2-in-RDF blank-node encoding
  (`owl:intersectionOf`/`unionOf`/`complementOf`/`oneOf`,
  `owl:Restriction` + `owl:onProperty` + `someValuesFrom`/`allValuesFrom`/
  `hasValue`/`hasSelf`/cardinality restrictions). Verified round-tripping a
  real ontology with `someValuesFrom`, `intersectionOf`, and
  `qualifiedCardinality` axioms with zero triple loss. Frame-level
  declarations/annotations/domain/range/subClassOf/equivalentClass are
  supported; this is still an intentionally-scoped subset of full OWL2
  Manchester Syntax (property characteristics, property chains, and
  data-range expressions aren't covered) -- `FORMATS.manchester.
  losslessGraph` is `false` for exactly this reason.
- **Format auto-detection** (`rdf/serialization.ts`): by file extension,
  with content-sniffing for the ambiguous `.owl` case (Protege defaults it
  to RDF/XML; plenty of hand-authored `.owl` files are actually Turtle).
  The TriG content-sniff initially only matched a graph name written as a
  bare `prefix:` immediately before `{` -- missed the standard
  `prefix:localName {` form every real TriG file actually uses (caught by
  hand-authoring a genuine named-graph example instead of only round-
  tripping `domain.ttl`, which has no named graphs and produced "TriG"
  output indistinguishable from plain Turtle -- not a useful test case).
- **New command**: *Ontology Suite: Convert / Save As Serialization...* —
  pick a target format, converts the active document and opens the result.
  Warns before converting into a lossy format (Manchester Syntax).
- **`resolveImports` is now format-aware**: an `owl:imports` target can be
  in any supported serialization, not just Turtle.
- **Broadened commands**: Run Local Checks, Show Metrics & DL Expressivity,
  Run Deep Validation, and Visualize Subject Graph now work against any of
  the six formats, not just Turtle (the status bar's expressivity/profile
  badge updates for any of them too). Add Class/Category and Add Property
  remain Turtle-only (they edit by textual append, which is
  Turtle-specific); live per-edit diagnostics remain scoped to Turtle/TriG
  (both parse synchronously/fast via N3 -- N-Triples/N-Quads have no
  `@prefix`/`owl:imports` to check, and RDF/XML/Manchester are rarely
  hand-edited, so they go through the async universal reader on-demand
  instead, via the commands above).
- **Position-aware completion for Turtle/SPARQL** (`language/
  completionContext.ts`): autocomplete after `prefix:` now filters by
  cursor position instead of showing every class/property/individual in
  the namespace regardless of context -- predicate slot suggests
  properties only; object of `a`/`rdfs:subClassOf`/`rdfs:domain`/
  `rdfs:range`/`owl:equivalentClass` suggests classes only; object of
  `rdfs:subPropertyOf`/`owl:inverseOf` suggests properties only. A
  lightweight statement-position heuristic (token-counting between `.`/
  `;`/`,`, not a real parser -- doesn't specially handle nested `[ ... ]`
  blank-node property lists), fails open to unfiltered wherever it can't
  confidently classify the position.
- **Manchester Syntax completion** (`language/manchesterSection.ts` +
  `manchesterCompletion.ts`): `.omn` files previously had no completion at
  all. Now: prefix completion, section-aware term completion (`Domain:`/
  `Range:` → classes; `SubPropertyOf:` → properties; `SubClassOf:`/
  `EquivalentTo:`/`Types:` → classes *and* properties, since a class
  expression can start with either an atomic class or a property
  immediately followed by a restriction keyword), and class-expression
  keyword completion (`and`/`or`/`not`/`some`/`only`/`value`/`Self`/`min`/
  `max`/`exactly`).

### Fixed while investigating (carried over from 0.1.0's known gap)

`shacl-engine`'s SPARQL plugin crashed (`Tried to bind variable ?this in a
GROUP BY operator`) on every SHACL-SPARQL shape in the registry --
root-caused to a regression between `@comunica/query-sparql-rdfjs-lite`
5.2.3 (what `shacl-engine` actually declares support for) and 5.3.0 (what
npm's semver range resolution had picked up). Pinned via `package.json`'s
`overrides`; the local checks engine's SHACL layer now works correctly
rather than silently returning zero findings.

## 0.1.0

Initial build: ontology creation/scaffolding, TARQL-style CSV-to-RDF
triplification with a live preview, an in-process SPARQL/SHACL/OWL2-RL
checks engine with gist-informed modelling guidance, DL-expressivity/OWL2-
profile metrics, a hierarchical Ontology Outline, workspace-wide rename/
find-references, competency questions as VS Code tests, and an optional
Python CLI fallback for full OWL2 DL reasoning/docgen/version-diff/the real
`oxi-gen` triplifier. See `README.md` for the full feature list.
