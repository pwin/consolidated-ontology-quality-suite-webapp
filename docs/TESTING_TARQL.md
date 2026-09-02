# Testing TARQL/CONSTRUCT query files

A folder of TARQL `CONSTRUCT` queries is a program. It has no compiler, no type
checker and no test runner of its own, and every one of its failure modes
produces *valid output* — triples that parse, load and query cleanly, and are
wrong. That is what makes query bugs expensive: nothing fails at the point of the
mistake, and the symptom appears somewhere else entirely, often months later and
usually as "why are there two nodes for this road".

This document is about catching those before they reach data. It covers what can
go wrong, which surface of this extension catches each thing, what none of them
can catch, and a review order that puts the cheapest checks first.

Adapted from `docs/TESTING_TARQL.md` in
[`consolidated_ontology_suite_python`](https://github.com/pwin/consolidated_ontology_suite_python),
whose CLI has a stage this extension does not — see
[What none of this checks](#what-none-of-this-checks).

## The four things that go wrong

**1. The query references vocabulary the ontology doesn't have.** A typo, a stale
namespace after a rename, a term removed in a new ontology version.

**2. The same conceptual IRI is minted two different ways in two files.** Both
queries are valid. Both produce triples. The two IRIs simply never join, and the
break surfaces later as a dangling reference or a duplicate entity.

**3. A variable in the `CONSTRUCT` template is never bound.** Every triple using
it is silently dropped — for every input row, with no error.

**4. The query builds a shape the ontology forbids.** A property used outside its
declared domain, a value outside its range.

## Where each is caught

| | Surface | Needs |
|---|---|---|
| 1. Undeclared vocabulary | Query Workbench conformance panel | the query + an ontology beside it |
| 2. Drifting IRI templates | `TQL-001`, *Review TARQL BIND Consistency* | the queries, nothing else |
| 3. Unbound `CONSTRUCT` variable | `TQL-002`/`TQL-003`, same command | the queries, nothing else |
| 4. Domain/range violations | `CNF-003`/`CNF-004`, *Run Local Checks* | **real triplified output** |

Note the asymmetry in the last row. Rows 1–3 are cheap and need no data; row 4
needs the pipeline to have run, because this extension has no sketch-graph stage
(see below).

## Query source review: `TQL-001`, `TQL-002`, `TQL-003`

**Ontology Suite: Review TARQL BIND Consistency** — from the palette with a query
open, or right-click any folder in the explorer. No ontology, no CSV, no
triplification: it parses each query's `BIND` statements and `CONSTRUCT` template
and compares them across the folder.

| Check | Severity | Fires when |
|---|---|---|
| `TQL-001` | Warning | One variable is bound by structurally different expressions in different files |
| `TQL-002` | Violation | A `?something_IRI` variable is used in `CONSTRUCT` but never bound |
| `TQL-003` | Info | Any other `CONSTRUCT` variable is unbound — probably a CSV column, worth confirming |

It reports twice over, deliberately. Findings land in the **Problems** panel on
the queries themselves, so a `TQL-001` sits on each competing `BIND` with the
others attached as related information — ctrl-click to jump between them. The
same run also writes the reviewer's report to the **TARQL BIND Review** output
channel, which puts the competing templates one above the other so the judgement
can be made without opening either file.

Because `TQL-001` is a cross-file finding, the command is scoped to a folder, and
each run replaces the previous run's findings wholesale.

### `TQL-001` compares skeletons, not text

The expression is reduced by replacing every `?var` with `?` before comparing.
This is the difference between a check people use and a check people mute:

```sparql
# NOT reported -- same template, different column name. Ordinary.
BIND(... CONCAT("exd:_Road_", ?roadid)   ... AS ?road_IRI)     # a.rq
BIND(... CONCAT("exd:_Road_", ?roadname) ... AS ?road_IRI)     # b.rq

# Reported -- the template itself differs, so the IRIs differ whenever
# the value contains a space.
BIND(... CONCAT("exd:_Road_", ?roadid)                    ... AS ?road_IRI)
BIND(... CONCAT("exd:_Road_", REPLACE(?roadid," ","_"))   ... AS ?road_IRI)
```

Measured upstream on a real ten-query folder: 37 variables are bound in more than
one file, 8 of those with differing expression text, and skeleton comparison
reports 7 — dropping the one case where two files feed an identical template from
differently-named columns. The gain is modest there because that folder's column
naming is fairly consistent; it grows with the number of files reading the same
concept under different column names.

The 7 it kept included a literal typo — `_Magnitude_LaneSegementTexture_` against
`_Magnitude_LaneSegmentTexture_` — which had survived human review precisely
because it reads correctly at a glance.

### `TQL-002` and `TQL-003` are one situation split by naming convention

TARQL binds every CSV header as a variable of the same name, so "used in
`CONSTRUCT`, not bound in `WHERE`" is the *normal* case: 32 of 228 variables in
that same folder, exactly one of them a defect. A `?x_IRI` variable is built
rather than read, so an unbound one cannot be a column, and it is a Violation.
Everything else is Info, and says plainly that the CSV header is what settles it.

The constructed-variable suffixes are `_IRI`, `_iri`, `_URI`, `_uri`. In this
extension they are fixed; the Python library takes them as an argument.

## Query shape against the ontology

Open a query with **Ontology Suite: Open Query Workbench**. Its conformance panel
reports two things against the ontology found beside the query (or the ones
pinned with `ontologySuite.queryOntologyPaths`):

- **prefix and namespace drift** — the query declaring a prefix the ontology
  spells differently, which is the quiet way a rename breaks a query set;
- **undeclared classes and properties** — a term the `CONSTRUCT` template builds
  that the ontology never declares.

That second one is the cheapest useful signal there is: found by reading the
query, without a single row of CSV. Run it whenever the ontology changes and the
queries have not.

**If you get a flood of undeclared terms, check the import closure first.** Every
term declared in an ontology your file fails to import is, by definition,
undeclared. Unresolved `owl:imports` are reported as diagnostics on the ontology
file itself — read those before believing a large undeclared-term count.

## Competency questions

`.cq.rq` files appear in the **Test Explorer** as red/green tests, run against the
ontology or the triplified output. They are the one surface here that checks
whether the data *answers the questions it exists to answer* — every check above
asks only whether it is well-formed. Worth writing one per real user question
before the queries are finished, not after.

## What none of this checks

Worth knowing before trusting a clean result:

- **CSV headers are never read.** Nothing here can tell a `TQL-003` finding that
  names a real column from one that names a typo. That is the reviewer's job, and
  it is why those are Info rather than Warning.
- **Expressions are compared, not evaluated.** `TQL-001` sees that two templates
  differ; it cannot tell you which is correct, or whether they happen to produce
  identical output for your actual data.
- **The `WHERE` clause is not otherwise analysed.** Joins, `OPTIONAL` blocks,
  `FILTER` conditions and `VALUES` are read only for the variable names they
  mention.
- **One query cannot drift against itself.** `TQL-001` needs a variable bound in
  at least two files. A single-query folder produces no drift findings, and that
  is not the same as being consistent — the output channel's section 4 is what
  tells you the check had something to compare.
- **There is no sketch-graph stage here.** The Python CLI renders the `CONSTRUCT`
  templates into a placeholder graph and runs the full `CNF-001`..`CNF-005` set
  over it, catching domain/range violations before any data exists. This
  extension's conformance panel covers the undeclared-term half of that; for
  `CNF-003`/`CNF-004` you need real triplified output, via **Run Full Triplify**
  and then **Run Local Checks** on the result — or the CLI's `sketch --ontology`
  stage through **Run Deep Validation**.
- **Dynamically built predicates stay invisible either way.** A predicate
  assembled with `IRI(CONCAT(...))` never appears literally in the `CONSTRUCT`
  template, so no amount of reading the query text will type it. Only checks
  against real output see these.

## A review order that works

1. **Review TARQL BIND Consistency, on the query folder.** Fast, needs nothing
   else. Read the output channel top to bottom — it is ordered by how sure the
   findings are.
2. **Fix every `TQL-002`.** An unbound constructed IRI is never correct.
3. **Adjudicate each `TQL-001`.** For each, one of the two expressions is right.
   Decide which, or rename the variables if the two genuinely mean different
   things.
4. **Spot-check `TQL-003` against the CSV headers.** Mostly columns; a typo here
   silently drops triples for every row.
5. **Open the Query Workbench.** Now the query set is internally consistent,
   check it against the vocabulary. Confirm the imports resolved before reading
   the counts.
6. **Run Full Triplify, then Run Local Checks on the output.** Only once the
   cheap checks are clean, because everything above costs seconds and this costs
   a pipeline run.

## Reading the review

Against `examples/tarql_drift/`, the fixture that seeds one finding per check:

```
TARQL BIND review
============================================================
2 query file(s), 5 BIND statement(s), 3 distinct target variable(s).

1. Variables bound differently across files (1)
------------------------------------------------------------
   ?road_IRI  -- 2 patterns across 2 files
       tarql:expandPrefixedName(CONCAT("exd:_Road_", ?))
           roads_to_rdf.rq:17
       tarql:expandPrefixedName(CONCAT("exd:_Road_", REPLACE(?, " ", "_")))
           lanes_to_rdf.rq:17

2. Constructed-IRI variables never bound (1)
------------------------------------------------------------
   ?direction_IRI                      lanes_to_rdf.rq

3. CONSTRUCT variables not bound in the query (1)
------------------------------------------------------------
   Expected to be CSV columns. Confirm each against its header.
   roads_to_rdf.rq
       ?roadname

4. Shared and consistent (1)
------------------------------------------------------------
   Bound in several files, always the same way -- no action needed.
   ?surface_IRI                        2 files
```

Each variant carries its files and line numbers, and the two templates sit one
above the other, so the judgement can be made without opening either file.

Section 4 is the part worth not skipping: it lists the variables bound in several
files that *agree*. A short section 1 means little on its own — it could equally
mean nothing was compared. Section 4 is what tells you the check found things to
compare and they lined up. Here, `?surface_IRI` is bound in both files from
differently-named columns through an identical template, which is exactly the
case skeleton comparison exists to *not* report.

## Turning a check up or down

`ontologySuite.disabledChecks` takes a list of check ids to suppress. After a run
where one check is most of the findings, the summary notification names it and
offers to add it there in one click.

To change a severity rather than silence a check, point
`ontologySuite.checksRegistryPath` at your own copy of the registry and edit
`default_severity`. The check keeps its id, prose and implementation.

## In CI

This extension has no headless mode; the checks run in the editor. For a build
that fails on `TQL-002`, use the Python CLI directly:

```bash
ontology-quality-suite sketch --queries scripts/to_rdf \
  --ontology ontology/MergedOntologies.ttl \
  --out-dir out/sketch --fail-on Violation
```

`--fail-on` gates the exit code on severity; `sketch` defaults to `never`, so it
has to be passed explicitly. The check ids, severities and prose are the same on
both sides — this extension vendors that project's registry under
`resources/checks-registry/`.
