# Changelog

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
