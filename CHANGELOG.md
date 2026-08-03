# Changelog

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
  releases -- v11.0.0 and v14.1.0, vendored from
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
