# Changelog

## 0.13.2 (unreleased)

### SHACL engine 0.1.10 → 0.1.12

`shacl-wasm-node`, the WebAssembly build of
[the native Rust SHACL engine](https://github.com/pwin/SHACL_Engine). Two fixes
in it matter here, neither of which changes a single finding this project
currently produces — verified by diffing every SHACL and merged row across four
fixtures before and after, 106 and 134 rows respectively, identical down to the
severities and merge sources.

- **A term that left through `to_oxrdf` and came back could vanish.** Three
  functions claimed to reverse that rendering and each had its own idea of what
  could be reversed; an unresolvable term was not an error anywhere, so a result
  quietly lost its `sh:value`. That matters more here than the finding count
  suggests: `value` is part of the dedup key in `merge.ts`, so a lost one is a
  row that cannot merge with its SPARQL twin — the same failure this project hit
  from the other end in 0.13.0. Blank nodes were fixed in 0.1.10; RDF 1.2 triple
  terms survived neither boundary until 0.1.11.
- **Shape compilation is iterative rather than recursive**, so a deeply nested
  shapes file cannot overflow the stack while compiling. Not reachable through
  the bundled registry, whose shapes nest three deep at most; reachable through
  `ontologySuite.checksRegistryPath` and someone else’s shapes.

The engine’s next release reorders the arguments of its module-level
`validateTurtle` one-shot, having found that a transposed call silently
*conformed* — the data compiles as a shapes graph, declares no shapes, and
validating against no shapes passes. This project only ever uses the `Validator`
path, whose signature is unchanged across all three versions, so nothing here
moves with it. `shaclRunner.ts` now says so, since the two names are identical
and only the receiver tells them apart.

### Fixed: the Python CLI could never be found

`consolidated_ontology_suite` renamed its console script to
`ontology-quality-suite`, and `ontologySuite.pythonCliPath` still defaulted to
the old `ontology-suite`. So *Run Deep Validation*, *Run Full Triplify* and
*Generate Documentation* could not launch out of the box against any current
install — the default itself was unreachable, whatever the user had.

The old name is named in the failure message for anyone whose install predates
the rename, rather than tried as a silent fallback: `shell: true` on Windows
means a missing command surfaces as a non-zero exit rather than an `ENOENT`, so
there is no reliable signal to retry on and guessing twice would bury the real
error.

### `docs/TESTING_TARQL.md`

The companion to the `TQL-00x` checks added in 0.13.0: what goes wrong in a
folder of CONSTRUCT queries, which surface here catches each thing, what nothing
here catches, and a review order that puts the cheapest checks first. Adapted
from the same file upstream rather than copied — that one is written around CLI
stages, and two differences needed saying rather than glossing. The `TQL` checks
report twice here (diagnostics on the queries, each competing `BIND` carrying the
others as related information, plus the reviewer’s report in an output channel).
And this extension has **no sketch-graph stage**: the CLI renders CONSTRUCT
templates into a placeholder graph and runs `CNF-001`..`CNF-005` over it before
any data exists, while the Query Workbench covers only the undeclared-term half
of that.

## 0.13.1

### Fixed: a cyclic class expression crashed the Manchester serializer

`rdfToClassExpr` walked blank-node class expressions with no guard on either
cycles or descent. Two triples were enough to take it down:

```turtle
_:b owl:complementOf _:b .
```

That is malformed OWL and perfectly well-formed RDF, so it survives a parse and
reaches the serializer, where it came out as an unhandled
`RangeError: Maximum call stack size exceeded` — *Convert / Save As
Serialization* to Manchester dying on one corrupt file. Legitimate depth broke it
too, somewhere between 2,000 and 20,000 nested levels.

Same class of bug as `computeMaxDepth` in 0.11.4, and as the six walks
`consolidated_ontology_suite_python` moved onto the heap in its 0.7.0: a graph
walk that guards neither cycles nor descent. `readRdfList` beside it has been
cycle-guarded all along, but its `seen` set is per list, so a cycle running
between *levels* of an expression was invisible to it.

The path down to a node is now tracked, so a node that is its own ancestor stops
and returns `undefined`, and depth is capped at 200 — gist’s deepest expression
is single figures. Path-scoped rather than one visited set for the whole walk, so
a blank node legitimately reached down two different branches still renders in
both. Callers already handle `undefined`: the unrenderable axiom is dropped and
the rest of the class still serializes.

### The check that floods a run now says so, and offers to stop

`QUA-009`/`QUA-010` ask for SKOS documentation on every term, so on an ontology
documented with `rdfs:label` they do not *add* findings, they **are** the
findings — 52 of them on `examples/tutorial/clinic.ttl`. 0.13.0 shipped
`ontologySuite.disabledChecks` as the answer and left the user to find it.

The run summary now names the id when one check is both **half the findings** and
**at least ten** of them, and offers to disable it in one click — workspace
settings where there is a workspace, so the choice travels with the project
rather than silencing the check in every other ontology you open. Below either
threshold nothing changes: four findings, three of them one check, is true and
not a reason to change a setting.

### Correction to 0.13.0: the nested-shape fix was bigger than described

Those release notes said findings from a nested `sh:property` shape arrived
*without their check id*. Measured properly, it was worse: `checkId` is part of
the dedup key in `merge.ts`, so a null one could never match its SPARQL twin, and
a single defect reached the Problems panel as **two diagnostics** — one coded,
one anonymous, reading only `SHACL validation failed`.

`LOG-003` and `STR-002` are the pre-existing checks that behaved that way. Both
now merge to one row each, pinned by a test, since they are the ones nobody would
notice regressing — the checks added in 0.13.0 have their own coverage.

## 0.13.0

Six checks brought across from `consolidated_ontology_suite_python` (0.9.0 and
0.10.0), and the two things in this project that had to be fixed before they
could report properly.

### Three new graph checks: `QUA-009`, `QUA-010`, `DAT-004`

- **`QUA-009`** — a declared class or property must carry at least one
  `skos:prefLabel`, and no more than one per language. Not "exactly one":
  SKOS defines `prefLabel` as unique *per language tag*, so `"Road"@en` +
  `"Ffordd"@cy` is correct and flagging it would be wrong about SKOS rather
  than strict about it. An **untagged** literal counts as its own language —
  RDF 1.1 types a plain literal `xsd:string` with no tag, so it is a real slot
  with room for one value. That case needs stating because SHACL’s own
  `sh:uniqueLang` ignores untagged values entirely, and untagged is how
  gist-based ontologies label everything.
- **`QUA-010`** — a declared class or property must carry a `skos:definition`.
  Distinct from `STR-004`, which asks whether a class is formally *defined* by
  an axiom: that is a question about logic, this one about prose, and a term
  can be fully axiomatised and still leave a reader unable to act on it.
- **`DAT-004`** — a `gist:Magnitude` must have a `gist:hasUnitOfMeasure` value
  typed `gist:UnitOfMeasure`. A magnitude without a unit is not a quantity, and
  the omission stays invisible until someone tries to compare two of them.
  Both subclass walks come free from SHACL’s own semantics, so a project
  subclass of `gist:Magnitude` is still checked.

Each ships in both formulations — a SPARQL CONSTRUCT and a native SHACL core
shape — so the two engines cross-validate through genuinely different
mechanisms rather than running the same SPARQL twice.
`examples/gist_patterns/` comes across with them, seeding one case per check
plus the negative cases that pin the rules from the other side: two prefLabels
in *different* languages, and a magnitude typed through a subclass.

**`QUA-009` and `QUA-010` will be noisy on an ontology documented with
`rdfs:label`.** They ask for SKOS specifically; `examples/tutorial/clinic.ttl`
gains 52 findings. The new `ontologySuite.disabledChecks` setting is the way to
turn a check off — its SPARQL query is then not run at all, and findings for
the id are dropped whichever engine reported them.

### Fixed: every native-SHACL-core finding arrived with no check id

A property-constraint result reports `sh:sourceShape` as the *nested*
`sh:property [ ... ]` shape, not the enclosing `oq:<CHECK-ID>` node shape the
id is readable from — and a blank node has no name to read one from. So every
finding from a check written in native SHACL core (`DAT-004`, `LOG-001`,
`LOG-003`, `QUA-009`, `QUA-010`, `STR-002`) came back with a null `checkId`: no
title, no category, no remediation, and no dedup key in common with its SPARQL
twin, so **both engines’ copies of one finding survived into the Problems
panel**. 52 of 81 rows across this project’s two fixtures.

Upstream fixed the same bug against pyshacl by walking up `sh:property` in the
shapes graph. Walking up needs the reported blank node to be findable in *our*
parse of the shapes, and it is not: `_:0_b6` and n3’s `_:b6_…` are two parsers’
private labels for the same node. The shapes are now given real IRIs before
they are compiled, so the engine reports an IRI that is a key into a map built
in the same pass. The finding set is unchanged — same 81 rows, same severities
— every one of them now carrying its id.

### Three new query checks: the TARQL BIND review (`TQL-001`…`TQL-003`)

A folder of TARQL queries is a program, and like any program it drifts. The
same conceptual IRI gets minted in six files, five of them the same way. That
drift is invisible in the output — each query is valid, each produces triples,
and the two IRIs for what should be one node simply never join. It surfaces
much later as a dangling reference or a duplicate entity, a long way from the
query that caused it.

- **`TQL-001`** — one target variable bound by structurally different
  expressions across files. Compared as **skeletons**, with every `?var` reduced
  to `?`, so two files feeding the same template from differently-named columns
  are not reported and two files wrapping one of them in a `REPLACE()` are.
  Comparing raw text would report both and be ignored accordingly.
- **`TQL-002`** — a `?something_IRI` variable used in a CONSTRUCT template and
  never bound. By that naming convention it is built rather than read from a
  column, so nothing will bind it and every triple using it is dropped.
- **`TQL-003`** — the same for a variable *not* following that convention,
  reported at Info. TARQL binds each CSV header as a variable of the same name,
  so an unbound `?roadname` is ordinarily just a column; telling a column from a
  typo means reading the CSV header, which is a reviewer’s judgement.

These are **native** checks: `sketch.ts` keeps only a query’s prefixes and its
CONSTRUCT template, so the WHERE clause and every BIND in it is gone before the
sketch graph exists. No SPARQL or SHACL formulation over that graph can see any
of this. It reads the query text instead — with a comment stripper that knows
`#` is the fragment separator in almost every RDF namespace, and a
bracket-matcher rather than a regex, because a non-greedy regex stops at the
wrong paren the moment `AS` is not the outermost thing in the statement.

Run from *Ontology Suite: Review TARQL BIND Consistency*, with a query open or
on any folder in the explorer’s context menu. `TQL-001` is a cross-file finding,
so this is folder-scoped rather than document-scoped, and reports both ways:
diagnostics on the queries (each competing BIND pointing at the others through
related information) and the side-by-side reviewer’s report in a *TARQL BIND
Review* output channel.

## 0.12.5

### Query conformance no longer rebuilds the ontology model on every refresh

`checkUndeclaredTerms` ran `buildOntologyModel` over the whole merged ontology --
imports included -- and copied every term into two arrays, each time the Query
Workbench refreshed. None of it can have changed: it is derived entirely from the
*ontology*, while what is being edited is the *query*.

Against a 185k-quad ontology that was **100ms of a 110ms refresh**. The declared
class and property sets are now cached against the quad array itself, which
`QueryWorkbench`'s own ontology cache already keeps stable across refreshes. A
`WeakMap` is the entire invalidation story: a changed graph is a new array, so it is
a new key, and the old entry becomes collectible on its own.

| full refresh (conformance + preview) | before | after |
|---|---|---|
| 67-quad ontology | 1.0 ms | 0.8 ms |
| 185k-quad ontology | 110 ms | **5.8 ms** |

Same findings before and after, and a genuinely different graph still recomputes.

### Competency questions load their ontology once per run, not once per question

Every `.cq.rq` test read, parsed and import-resolved its target ontologies, serialized
the entire graph to N-Triples and re-parsed that into a fresh Oxigraph store --
**per test**. Questions in one folder almost always ask about the same ontology.

Stores are now shared across a run, keyed on the resolved target paths so a question
with its own `@against` still gets its own graph, and freed when the run ends (an
unfreed WASM store is heap the editor keeps until it exits -- see 0.12.1).

One graph load measured at 12.0s for a 185k-triple target:

| questions in a run | before | after |
|---|---|---|
| 2 | 24.0s | **12.0s** |
| 5 | 59.9s | **12.0s** |
| 20 | 239.5s | **12.0s** |

### Fixed: a large ontology silently failed every competency question

The same `push(...array)` overflow 0.11.3 fixed in ten places survived here, missed
because the file sits under `src/tests/` and reads as test code -- it is the Test
Explorer *provider*, which ships. Spreading makes every quad a function argument, and
this runtime refuses at ~125k of them.

Worse than the crash it caused elsewhere: the throw landed inside a `catch` meant for
a missing `@against` file, so a large ontology produced an **empty graph** and every
question failed against nothing, reporting the wrong reason.

### Saving an unrelated file no longer invalidates the term index

The save handler asked `detectFormat(path, document.getText())`. `detectFormat` falls
back to `'turtle'` for anything it cannot place, so that predicate was true for
**every file in the workspace**: saving a `.ts`, `.py`, `.json` or `.md` invalidated
the index and, before 0.12.4, re-parsed every ontology in the workspace on the next
hover. It also materialised the whole document to do it.

The sniff was never needed for the case the code was guarding: `.rdf` resolves from
its extension alone. Only `.owl` is genuinely content-ambiguous, and it answers
`'turtle'` either way -- which is all this predicate needs to know.
## 0.12.4

### The CURIE scan was the other half of the unresponsive-host profiles

Three further profiles of the same session put `scanFileForCuries` above the parser:
**2.2s of self time in one, and `expand` alone was 65% of another**. 0.12.3 stopped it
running repeatedly; this makes the run itself cheaper.

- **Occurrences hold line/column numbers instead of a `vscode.Range`.** The index keeps
  one occurrence per CURIE token in the workspace -- 317k of them in the measured
  corpus -- and a `Range` is three objects (itself plus two `Position`s) where three
  numbers do. Every consumer (go-to-definition, find-references, rename) works on the
  handful of occurrences for a single term, so the ranges are now built on demand.
- **`expand` is inlined into the scan.** The regex has already separated prefix from
  local name, so joining them into a CURIE only for `expand` to `indexOf`/`slice` it
  apart again allocated a string per match -- once per term occurrence in the workspace.
- **The first-non-whitespace search is hoisted out of the match loop.** It was
  recomputed per match to answer the same question each time.

### The merged quad array is no longer retained

`TermIndex` kept a workspace-wide `Quad[]` alive purely to hand out through
`getMergedQuads()`, which nothing called. It is only ever the input to
`buildOntologyModel`; the per-file quads in the cache are what an incremental rebuild
actually needs.

One settled index over the same 7 MB / 18-file corpus:

| | per index | 12 interleaved hover/save cycles |
|---|---|---|
| 0.12.1 | 184 MB | 1465 MB |
| 0.12.2 | 193 MB | 2065 MB |
| 0.12.3 | 193 MB | 270 MB |
| 0.12.4 | **161 MB** | **238 MB** |

Cold build 997 ms against 1107 ms, longest event-loop stall 101 ms against 121 ms.

What remains is inherent: an index costs roughly a kilobyte per quad, and 113 MB of
the 161 MB is the parsed quads themselves, held per file so that an edit to one
ontology does not re-parse the rest. `ontologySuite.maxIndexedFileSizeKb` is the lever
if a workspace holds data graphs that are not worth indexing.

### `Reset Index & Diagnostics` now reports what it rebuilt

Files, quads, term occurrences, and how many files were skipped for size. When the
editor is struggling the first useful question is how much there actually is to index,
and nothing in the UI answered it.
## 0.12.3

### Fixed: concurrent index rebuilds crashed the extension host at a 3.9 GB heap

`Ineffective mark-compacts near heap limit -- JavaScript heap out of memory`,
terminating the extension host and every extension running in it.

**0.12.2 did not fix this**, and measured slightly worse. It addressed how *long* a
rebuild took; this is about how many of them ran at once.

The tell was in the GC log rather than the profile:

```
Mark-Compact 3940.7 (4016.0) -> 3938.9 (4026.2) MB, 4726.50 / 0.00 ms
```

Nearly five seconds of mark-compact to free **2 MB of 3.9 GB**. That is not a
collector failing to keep up with garbage -- it is a collector finding almost
everything still reachable.

It was reachable because `invalidate()` set `building = undefined`. The rebuild it
was cancelling could not actually be cancelled: it kept running with nothing pointing
at it, while the next hover, completion or go-to-definition saw no build in flight and
started another from scratch. Invalidations arrive constantly in a real session --
every save, every scaffold command, every quick fix -- and each rebuild takes a second
or more, so several ran at once, each holding its own copy of every quad in the
workspace. Nothing leaked; there were simply N live indexes.

Rebuilds are now serialised. A caller arriving mid-build joins the one in flight
instead of starting a rival, so at most one index can be live no matter how many
invalidations land.

Measured on a 7 MB / 18-file workspace where **one settled index costs 184 MB**,
driving interleaved hover/save cycles:

| cycles | 0.12.1 | 0.12.2 | 0.12.3 |
|---|---|---|---|
| 4 | 691 MB | 847 MB | **265 MB** |
| 12 | 1465 MB | 2065 MB | **270 MB** |

Flat against the number of cycles, where both previous versions grow linearly with
them -- which is the runaway that reached 3.9 GB. A forced GC returned every version
to ~190 MB, confirming the diagnosis: all three hold the same amount of *retained*
memory, and the difference is purely how much is simultaneously live.

Cold build also came out faster (820 ms against 1330 ms) and the longest event-loop
stall shorter (101 ms against 155 ms), because the concurrent rebuilds had been
competing for the same CPU.

### `Reset Index & Diagnostics` is now authoritative over an in-flight rebuild

A rebuild already running cannot be cancelled -- that is the whole lesson above -- so
it used to finish and repopulate the very cache the reset had just cleared. Rebuilds
now carry a generation, and one superseded by a reset discards its results.
## 0.12.2

### Fixed: the term index re-parsed the whole workspace on every invalidation

Reported as `UNRESPONSIVE extension host: took 60% of 3008ms`, with a CPU profile.
The profile was unambiguous: **98% of it was N3 lexing under `TermIndex.rebuild`**,
reached through a single `provideHover` -- 3.5s in `_tokenizeToEnd`, plus 2s of GC
from the garbage it produced.

`rebuild` read and parsed *every* ontology in the workspace from scratch. Anything
that invalidates the index -- saving a file, any scaffold command, applying a quick
fix -- threw all of that away and paid for it again on the next hover, completion or
go-to-definition. Invalidation is necessarily coarse; the work it triggered was total.

Each file now keeps its own parse result, revalidated by size and mtime, so a rebuild
costs only what actually changed. Keying on the file rather than on an event also
covers changes the extension never hears about -- a `git checkout`, an external
editor -- which an event-driven cache would miss.

Measured over a 7 MB / 18-file workspace (185k quads):

| | time | files read |
|---|---|---|
| rebuild after invalidate | 1090 ms | 18 |
| **after** | **2 ms** | **0** |
| rebuild after editing one file | 1564 ms | 18 |
| **after** | **347 ms** | **1** |

Cold build is slightly faster too (~1.4s either way): the old merge did a `Map.set`
per *occurrence* rather than per new key.

### The index no longer blocks the extension host while it builds

A cold build is still real work, and it ran as one uninterrupted burst -- N3 parses
synchronously, and the `await`s between files resolve as microtasks, so the event
loop never got a turn. Measured on the same workspace: **the loop got zero turns**
across the entire 1.35s build, which is precisely why the host could not answer a
ping and VS Code declared it unresponsive.

The build now hands the loop back every 40ms. Same workspace: 12 turns, longest
stall 155ms -- of which 134ms is `buildOntologyModel`, a single pass that only runs
when something changed.

The yield is `setImmediate`, not `setTimeout(0)`: a zero timeout is clamped to the
platform timer granularity (~15ms on Windows), and paying that per slice nearly
doubled the cold build in measurement.

### New: `ontologySuite.maxIndexedFileSizeKb` (default 5120)

Files above the limit are stat'd but not parsed. A multi-MB data graph costs seconds
of blocked editor to index terms nobody is going to hover; hand-authored ontologies
are far below the default (gist core is under 1 MB). Skipped files are **named in the
extension host log** along with what is lost -- hover, completion, go-to-definition
and rename for their terms -- rather than silently disappearing.

### `Reset Index & Diagnostics` really resets

It called `invalidate()`, which now deliberately *keeps* per-file parse results. The
command is what someone reaches for when the editor is misbehaving, so it drops those
too.
## 0.12.1

### Fixed: the Query Workbench leaked memory until VS Code ran out of heap

Reported as the workbench slowing down badly in use, ending in
`Ineffective mark-compacts near heap limit — JavaScript heap out of memory` at
~3.8 GB, with GC mutator utilisation down at 1.8%: the collector running almost
continuously and reclaiming almost nothing.

`refresh()` runs on every edit, debounced at 500ms, and it rebuilt everything each
time — re-reading, re-parsing and re-resolving imports for every ontology, then
converting every resulting quad into wasm-bindgen wrappers to load a fresh Oxigraph
store. None of that can change while someone is typing a *query*.

The leak is that wasm-bindgen frees lazily through a `FinalizationRegistry` and
**WASM linear memory never shrinks**, so a store per keystroke grows the heap
monotonically. Measured against a **67-quad** ontology: **+59 MB over 200
refreshes**, none of it returned by a forced GC. A real ontology in a real session
is what reached 3.8 GB.

Two caches, because each alone was insufficient — freeing the store explicitly
recovered only 9 MB of the 59, since the per-quad wrappers were the bulk:

- **Parsed ontologies are held across refreshes**, keyed on each file's path, size
  and mtime, so an edit to the ontology is still picked up on the next refresh
  without watching anything.
- **The Oxigraph store is cached** against the quad array's identity -- which is
  exactly what the first cache makes stable. A genuinely new graph frees the old
  store before building the next, so at most one is ever live.

Measured over 200 refreshes, before and after:

| | memory | time |
|---|---|---|
| rebuilding each refresh | +59 MB | 909 ms |
| ontology cached | **+1 MB** | **42 ms** |

`runSparqlChecks` frees its store too. It runs once per checks run rather than per
keystroke, so it was never the leak, but it holds the whole merged graph and is the
larger single allocation.

## 0.12.0

### The term index now covers every serialization the extension opens

It globbed only `{ttl,owl}` and `{rq,sparql}`, so terms declared in a **TriG,
N-Triples, N-Quads, Manchester or RDF/XML** ontology were invisible to hover,
completion, go-to-definition and rename — as were `.tq`/`.tarql` queries, which
0.11.1 registered as a language without teaching the index about them.

Both globs now cover every registered serialization, and ontology files are read
through `readOntologyDocument` rather than assumed to be Turtle, so a `.omn` or
`.rdf` file contributes its terms instead of only parse errors.

One deliberate exception: the CURIE text scan does not run over RDF/XML. It
records *source positions*, which mean something only where `prefix:localName` is
the surface syntax; in RDF/XML that pattern is an XML QName in an attribute, so
scanning it would invent an occurrence of a term named `about` and offer it to
find-references and rename. Its quads are still indexed.

**Saving** now invalidates the index for any of those serializations, not just
Turtle and SPARQL. Keyed on `languageId` where this extension owns it and on
`detectFormat` otherwise, because `.rdf` registers as plain `xml` — shared with
every other XML file — so keying on languageId alone would rebuild on unrelated
saves.

### New: `Ontology Suite: Reset Index & Diagnostics`

Saving an indexed file already invalidates, but that is a side effect nobody
would guess at when the editor is misbehaving, and *Refresh Outline* only
refreshes the tree — an easy thing to reach for and be disappointed by. The new
command clears the term index and both diagnostic collections, then rebuilds.

### Language providers degrade instead of erroring

`hover`, `manchesterCompletion` and `definitionReferencesRename` called
`ensureBuilt` with no error handling, so an index failure escaped as a raw
`ERR …` notification **on every hover** — which is exactly how the 0.11.3 stack
overflow presented. New `ensureBuiltQuietly` returns false instead, degrading to
"no hover this time", and logs once per failure streak rather than once per
call. `ensureBuilt` still throws for callers that should report.

### A `files.associations` mismatch now explains itself

"Open a CONSTRUCT query file first" is actively misleading when such a file *is*
open. `files.associations` overrides an extension's language registration, so a
stale mapping silently sends the file elsewhere and every command gating on
`languageId` refuses it, naming none of that. This caught the same user twice —
`.rq` mapped away to work around a competing RDF extension, then `.tq` left
mapped to `"sparql"` after 0.11.1 made that workaround unnecessary.

The guard now distinguishes no-editor, unrelated-file, and **right extension /
wrong language** — reporting which language the file actually got, which is
needed, and that a `files.associations` entry for that glob is the cause, with a
**Fix association** action that writes the correction into whichever scope
currently defines the key.

### SHACL engine updated to `shacl-wasm-node` 0.1.10

Moves property descent off the call stack, so a recursive shape following a chain
costs one heap frame per link instead of one call frame. Verified through the npm
package the extension actually loads: a **20,000-link chain validates** (20,001
findings) where the engine previously refused at 47 links and overflowed the
stack at about 100.

Findings were captured per finding — shape, focus node, path, value, severity —
across `domain.ttl`, `clinic.ttl` and `expressions-demo.ttl` under 0.1.9, then
re-captured under 0.1.10 and compared: **identical, no crashes**.
## 0.11.4

### Fixed: metrics could overflow the stack on a deep class hierarchy

Found by auditing for the rest of the class of bug 0.11.3 fixed, rather than
from a report.

`computeMaxDepth` guarded *cycles* but not *descent*. Hierarchy depth follows the
longest subclass chain, and the recursive walk cost one stack frame per link, so
a long chain overflowed on what is only a metrics report. Memoisation hid it
whenever classes happened to be visited shallowest-first; declared the other way
round — which is just as valid a document — a 20,000-deep chain threw.

A depth cap was the obvious fix and the wrong one: measured on this runtime,
~5,000 frames of a closure that size already overflow, so any limit low enough to
be safe was also low enough to silently truncate a real answer. The walk is now
iterative over an explicit stack, which removes the ceiling instead of choosing
one — a 100,000-deep chain reports 99,999. Cycles still terminate with the same
result as before.

Also replaced `Math.max(...parents.map(...))` there: spread makes every element a
function argument, the same ~125k limit behind 0.11.3.

## 0.11.3

### Fixed: `Maximum call stack size exceeded` on hover

Reported against the installed 0.11.2 build:

```
ERR Maximum call stack size exceeded: RangeError: Maximum call stack size exceeded
    at At.rebuild (…/dist/extension.js)
    at async Object.provideHover (…/dist/extension.js)
```

`TermIndex.rebuild` merged each parsed file with `allQuads.push(...parsed.quads)`.
Spreading an array into `push` makes **every element a function argument**, and
this runtime throws at ~125,546 of them — measured, not estimated. So a single
`.ttl` or `.owl` past that many quads crashed the index, and since `rebuild`
scans the whole workspace (`**/*.{ttl,owl}`, up to 2000 files), one large data
graph anywhere in the project was enough. The failure then surfaced as a stack
overflow with nothing in the message naming the file responsible.

The same pattern was in **nine** other places, each on an array whose length is
set by the input rather than by syntax — `resolveImports` merging an imported
graph, the SPARQL and SHACL runners collecting findings, live diagnostics,
the registry walk, and the file/glob walks in `discovery.ts`. All ten now
iterate. The five remaining spread-pushes are bounded by document syntax (the
comment lines attached to one statement, one term’s annotation lines) and cannot
approach the limit.

Guarded by a behavioural regression test rather than a source grep: it builds a
130,000-quad import and asserts the merge completes with every quad present.
Confirmed to fail with the old code, reproducing exactly the reported
`RangeError`, and to pass with the fix.

### Fixed: one bad file left the editor looking permanently broken

Found while fixing the above. `TermIndex.ensureBuilt` memoises the in-flight
build so concurrent callers share one rebuild — but it memoised **rejections**
too. Once a build failed, every later hover, completion and go-to-definition
re-threw the same stale error until a save happened to invalidate the index.
That is why the crash above presented as continuous rather than one-off. A
failed build now clears the cached promise so the next caller retries, and
rethrows so the failure stays visible instead of silently serving an empty index.

## 0.11.2

### `queryOntologyPaths` accepts glob patterns

Entries may now be **literal paths, glob patterns, or any mix of the two in one
list** — the mix being the point, since a project typically has a couple of
ontologies worth naming and a directory of others worth sweeping up:

```json
"ontologySuite.queryOntologyPaths": [
  "core.ttl",
  "vocab/*_ontology.ttl",
  "imported/**/*.ttl",
  "C:/shared/gist/gistCore14.1.0.ttl"
]
```

`*` matches within one path segment, `?` one character, `**` any depth of
directories (including none, so `vocab/**/*.ttl` finds `vocab/draft.ttl` as well
as `vocab/nested/deep.ttl`). Matching is case-insensitive and results are sorted,
so a run over one project is reproducible. Duplicates are collapsed, since a
literal and a pattern can name the same file and an ontology should not be read
twice.

A **literal** entry still passes through without an existence check, so a
mistyped path surfaces as a read error naming the file rather than vanishing as
"no ontology found". A **pattern** that matches nothing contributes nothing —
there is no single path to blame, and `*_ontology.ttl` matching none is a normal
state for a project that hasn't written one yet.

Purely additive: a list of literal paths behaves exactly as it did in 0.11.1.

## 0.11.1

Four fixes to the TARQL/query side and to CURIE rendering. All four are
**webapp-only** — the Python CLI is unaffected, because it is *told* what the
extension has to infer: `--ontology` is `required=True` and `action="append"`,
and `.tq`/`.tarql` are already in its query globs.

### `.tq` and `.tarql` are recognised

The two halves of the extension disagreed. `triplify/discovery.ts` accepted
`.sparql`/`.rq`/`.tarql`/`.tq` for CSV pairing (ported faithfully from the
Python suite's `DEFAULT_QUERY_GLOBS`), but the manifest registered
`sparql-construct` for only `.rq`/`.sparql`/`.cq.rq`. So a `.tq` query was
*paired with its CSV* and then **rejected by Open Query Workbench**, which gates
on `languageId === 'sparql-construct'` — no syntax highlighting either. Both
extensions are now registered, added to this repo's `files.associations`, and the
command's error message names all four instead of just `.rq`.

### Query→ontology discovery finds the ontology, and finds all of them

It took the first `*.ttl` in the query's **own directory** and nothing else, so:

- `examples/tutorial/queries/appointments.rq`, whose ontology is one level up,
  silently got **no conformance checking at all** — the tutorial's own layout;
- a project built on several ontologies only ever saw one of them.

`triplify/discovery.ts` gains `findOntologies`, searching the query's own
directory, then its parent, then its siblings, and returning **every** ontology
in the first directory that yields any — an extension ontology plus the upper
ontology it builds on is the normal case. Each is import-resolved in its own
right and then merged. Stopping at the first productive directory is deliberate:
collecting across all three would drag unrelated ontologies into the check, and
a spurious "undeclared property" is worse than a missing one.

New **`ontologySuite.queryOntologyPaths`** pins an explicit list when the guess
is wrong — absolute, or relative to the workspace root.

### The Ontology Outline shows `ex:Thing`, not `:Thing`

`shrink()` returned the first prefix whose namespace matched, in whatever order
the parser produced them — so a document binding both `:` and `ex:` to one
namespace rendered `:Dog` or `ex:Dog` purely on which `@prefix` line came first.
Candidates are now ranked, which also fixes a latent bug found on the way:

- **Longest namespace wins.** With both `http://ex.org/` and
  `http://ex.org/sub/` bound, `http://ex.org/sub/Thing` was rendered
  `ex:sub/Thing` — a *different* CURIE that only round-trips by accident. Now
  `sub:Thing`.
- **A named prefix beats the empty one**, so the term says which vocabulary it
  came from. `:Dog` is still used when `:` is the only binding.

This reaches everything that renders a CURIE: the Outline, the graph view, and
the scaffolding commands that write Turtle.

## 0.11.0

Takes up the check fixes from `consolidated_ontology_suite_python` 0.5.0–0.6.0,
whose 0.6.0 came out of a sibling fixture repo of 13 deliberately broken OWL2
ontologies. Each was assessed against *this* stack rather than adopted on
trust — two of the four turned out not to apply here, and one applied in a
different form.

### `sh:severity` moved to where SHACL defines it

The registry's shapes declared `sh:severity` *inside* each
`sh:sparql [...] SPARQLConstraint` block rather than on the enclosing shape.
A strict engine is right to ignore it there, which is what `shacl-engine`
did — so 0.9.2's `extractDeclaredSeverities` workaround was treating
correct engine behaviour as an engine bug. **The shapes were authored
wrong.** All six now declare it on the shape, so every engine reads it.

### Two identical findings no longer counted twice

`LOG-001`'s and `STY-003`'s SPARQL formulations omitted a `sh:resultPath` /
`sh:value` that their SHACL twins emit, so the same finding arrived with two
different dedup keys and both survived. Both now emit them, and the effect is
visible: on `examples/ontology/domain.ttl`, **9 of 12** merged findings are now
corroborated by both engines rather than double-counted.

Supporting that required porting two fixes into `sparqlRunner.ts`:

- **`sh:resultPath` and `sh:value` are read as sets, not first-match.** Several
  CONSTRUCTs bind two values for one finding deliberately (`LOG-004`'s two
  inverses, `LOG-006`/`007`'s domain and range, `REA-001`'s two disjoint
  classes, `STR-007`'s subject and object). Taking one arbitrarily both halved
  the finding and made the dedup key depend on result order. Now sorted and
  joined. Pinned by a determinism check: three identical runs, one stable result.
- **SHACL property paths render as path expressions.** `LOG-001` now emits
  `sh:resultPath [ sh:oneOrMorePath rdfs:subClassOf ]`, a blank node — whose
  identifier is minted per parse, so it could never match its twin's. Rendered
  as `(rdfs:subClassOf)+`, including inverse, alternative and sequence paths.

### `STR-002` no longer flags W3C-namespace predicates

It exempted `rdf:`/`rdfs:`/`owl:` by their three individual namespace IRIs
while its siblings exempt `http://www.w3.org/` wholesale, so using
`skos:prefLabel` without redeclaring SKOS locally was a Violation-severity
"undefined property" — on the very predicate `QUA-001`/`002`/`004` accept as a
valid label. `domain.ttl` produced exactly two such false positives.

### `DAT-001` now checks value space, not just lexical form

Upstream found its `xsd:boolean` branch unreachable because rdflib coerces
`"yes"^^xsd:boolean` to `'false'` before the regex sees it. **That does not
apply here** — n3 stores the lexical form verbatim, so the portable
formulations already catch it (verified, not assumed).

The *other* half does apply: `"2021-02-30"^^xsd:date` is lexically perfect and
denotes nothing. Upstream leans on rdflib's `Literal.ill_typed`; there is no
equivalent here, so new `checks/literalTyping.ts` checks the value spaces
directly for `date`/`dateTime`/`gMonth`/`gDay` — the datatypes with an
unambiguous, cheaply-decidable value space. Anything else is left to the
lexical checks rather than guessed at, since a false "invalid" on real data is
worse than a miss. Reports as `DAT-001` so it merges with the existing
formulations. The registry description now says what is actually checked.

### Quick Fix no longer breaks on a non-IRI path or value

Upstream's equivalent finding, and one the changes above made *reachable* here
rather than merely possible. `repairEngine.ts`'s `formatIriOrUndef` wrapped any
non-empty string in `<...>`, so a property-path expression
(`<(rdfs:subClassOf)+>`) or a joined multi-value
(`<http://ex/p1, http://ex/p2>`) produced a malformed IRI — and since
`buildRepairUpdate` binds every variable in one `VALUES` row whether the
template uses it or not, one bad term made the whole update unparseable,
breaking repairs that never referenced it. It now requires a single absolute
IRI and emits `UNDEF` otherwise.

Upstream's `--engine` selection has no analogue here — this extension runs one
SHACL engine — so that item is not carried.

## 0.10.3

Updates the SHACL engine to `shacl-wasm-node` **0.1.9** (from 0.1.7), which
adds SHACL-AF rules (`sh:rule`, `sh:condition`, `sh:order`,
`sh:deactivated`) and fixes `$this` substitution in CONSTRUCT-based rules —
it previously fell through, so a SPARQL rule ran for every node in the graph
rather than for its focus node.

Neither affects this extension today: the change to the WASM API is purely
additive (`inference` gains `"rules"`/`"rules-iterated"` alongside `"none"`
and `"rdfs"`), the rules fix is in the rule path rather than the `sh:select`
constraint path the registry's shapes use, and this runner asks for
`"none"` deliberately — inference is the reasoner tier's job here, and a
SHACL finding should be about what the document says rather than about what
a second pass added underneath it.

Verified rather than assumed: findings were captured from both
`examples/ontology/domain.ttl` (11) and `examples/tutorial/clinic.ttl` (25)
under 0.1.7, then re-captured under 0.1.9 and compared per-finding on
shape/focus node/path/severity. Byte-identical, no crashes either way.

## 0.10.2

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

## 0.10.1

The first packaged release since 0.9.2, carrying the three check-query fixes
from 0.9.3 and the SHACL engine replacement from 0.10.0 — both committed but
never released at the time. No changes of its own.

Superseded by 0.10.2 for publishing purposes: 0.10.1 shipped before the
Marketplace readiness work, so its `.vsix` still carries `private: true` and
the oversized icon. It installs fine from a file; it cannot be published to
the Marketplace.

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
