# Changelog

## 0.2.0

Multi-serialization support: read, write, and convert between Turtle,
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
