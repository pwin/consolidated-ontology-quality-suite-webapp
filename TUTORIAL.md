# Tutorial: The Ontology Development Suite, end to end

This walks through every major feature using two real fixture sets:

- **`examples/tutorial/`** — a small, coherent "veterinary clinic" ontology
  (`core.ttl` + `clinic.ttl`, imported), instance data, a CSV → RDF
  triplification example, and competency-question tests. Built specifically
  for this tutorial, but every finding it produces below is real —
  everything in this document was verified by actually running the
  relevant engine against these files, not written from what it *should*
  do.
- **`examples/gist/`** — two real, unmodified releases of Semantic Arts'
  `gist` upper ontology (v11.0.0 and v14.1.0, copied from
  `consolidated_ontology_suite`), used for a genuine "was this written
  against an older upstream ontology?" scenario in [Part 10](#part-10-a-real-upstream-ontology-migration-gist-v11--v141).
- **`examples/scripting/`** — two TypeScript scripts (`pets.ontology.ts`,
  `pets-advanced.ontology.ts`) used in [Part 11](#part-11-scripting-ontologies-with-typescript)
  to demonstrate authoring an ontology as real, loop-driven code instead of
  hand-typed Turtle.

Everything here is also exercised by the automated test suite
(`npm test`) — see the `*.test.ts` file next to the relevant module if you
want the exact assertions.

## Setup

1. Open this folder in VS Code and press `F5` — this runs `npm run
   compile` (via `.vscode/tasks.json`) and launches an Extension
   Development Host with the extension loaded.
2. In the new window, **File → Open Folder** → `examples/tutorial`.

## Part 1: Explore the ontology

Open `clinic.ttl`. It declares `owl:imports <http://example.org/clinic/core>`,
resolved from `core.ttl` sitting alongside it (local-first, transitive
import resolution — see `ontology/resolveImports.ts`).

- Open the **Ontology Outline** view in the Explorer sidebar. You'll see
  `Classes`, `Object Properties`, and `Datatype Properties` as nested
  trees — `Mammal → {Cat, Dog → Puppy}`-style hierarchies aren't in this
  particular ontology, but `Animal`/`Person`/`Mammal`/`Dog`/`Cat`/`Owner`/
  `Veterinarian`/`Appointment` show the class structure, and `hasOwner`
  groups with any sub-properties the same way.
- Hover over any `ex:` term (e.g. `ex:hasOwner`) to see its label, domain,
  and range.
- Ctrl/Cmd-click `ex:Animal` (used in `clinic.ttl` but declared in
  `core.ttl`) to jump straight to its declaration in the other file —
  go-to-definition works across the import.

## Part 2: Run Local Checks

With `clinic.ttl` active, run **"Ontology Suite: Run Local Checks"** from
the Command Palette. This runs the SPARQL check registry, the SHACL
registry, the reasoner, and the modelling-guidance rules — all in-process,
no external dependency — and merges everything into the Problems panel.

`clinic.ttl` deliberately carries one instance of each modelling-guidance
smell (grounded in gist's own conventions — see the README's
"Gist-informed modelling guidance" section):

| You'll see | Because |
|---|---|
| `MDL-001` on `ex:isOwnerOf` | It's declared as a top-level `owl:inverseOf ex:hasOwner`. gist itself only ever scopes `owl:inverseOf` inline to one restriction, never as a second named property — the fix is a SPARQL property path (`^ex:hasOwner`) instead. |
| `MDL-002` on `ex:Veterinarian` | `owl:equivalentClass ex:AnimalDoctor` with no logical definition attached — should be `rdfs:subClassOf`, or a SKOS mapping if these came from different ontologies. |
| `MDL-003` on `ex:AppointmentType` (and a few others) | No restrictions/relationships of its own — a candidate for `gist:Category` instead of a new class. The heuristic is intentionally broad: it'll flag *every* structure-less class it finds (`ex:Animal`, `ex:Person`, `ex:Appointment` too), not just the one purpose-built example — that's honest heuristic behavior, not a bug. |

You'll also see real SPARQL/SHACL structural and style findings (missing
`owl:versionInfo`, naming-convention checks, etc.) — the same 39+6-check
registry `consolidated_ontology_suite` ships, just run by Oxigraph and
`shacl-engine` instead of a Python subprocess.

You'll also see a `PRJ-REQUIRED` finding on `ex:Vaccination`: it's missing
`rdfs:label`. That's not from the copied-in registry — it's from *this
project's own* `.ontology-suite/class-rules.json`, which declares "every
`owl:Class` needs `rdfs:label`" (see [Part 3](#part-3-quick-fix-the-findings)).

## Part 3: Quick Fix the findings

Click on the `MDL-001` diagnostic for `ex:isOwnerOf` (or put the cursor on
that line) and open the Quick Fix menu (the lightbulb, or `Ctrl+.`/`Cmd+.`).
You'll see **"Ontology Suite: Fix MDL-001 (Remove the named inverse
property)"**. Selecting it opens a modal showing exactly what would change:

```
- ex:isOwnerOf owl:inverseOf ex:hasOwner
```

Nothing is written until you click **"Apply Fix"** — cancel it and try the
other three fixable findings from Part 2 instead:

| Finding | Quick Fix does | Where the project-specific part comes from |
|---|---|---|
| `MDL-002` on `ex:Veterinarian` | Deletes `owl:equivalentClass ex:AnimalDoctor`, inserts `rdfs:subClassOf` instead | `equivalentClassPolicy` in `.ontology-suite/standards.json` (`"subClassOf"` here — set it to `"closeMatch"` and the same finding would insert `skos:closeMatch` instead) |
| `MDL-003` on `ex:AppointmentType` | Deletes `a owl:Class`, inserts `a ex:Classification` | `categoryClass` in `.ontology-suite/standards.json` — this project defined its own `ex:Classification` term (in `core.ttl`) instead of using the built-in default, `gist:Category` |
| `PRJ-REQUIRED` on `ex:Vaccination` | Inserts `rdfs:label "Vaccination"@en` | `defaultLanguageTag` in `.ontology-suite/standards.json`; the label text itself is derived from the local name (`Vaccination` → `Vaccination`, or `hasOwner` → `has Owner` for camelCase names) |

Try changing `.ontology-suite/standards.json`'s `categoryClass` to
`"gist:Category"` and re-running the `MDL-003` fix on a fresh copy of
`clinic.ttl` — the Quick Fix now proposes `a gist:Category` instead,
with zero code changes: the repair template
(`resources/checks-registry/repairs/MDL-003.ru`) is a real SPARQL Update
that only knows about `?focusNode` and `?categoryClass` — which class
that resolves to is entirely this project's call.

Two things worth trying to see the safety rails:
- Open `core.ttl` on its own (not via `clinic.ttl`'s import) and look for
  an `MDL-003` finding on `ex:Person` or `ex:Animal` — those *are*
  declared there, so the fix works normally. But if you somehow triggered
  the same fix from `clinic.ttl` (where `ex:Animal`/`ex:Person` are only
  *used*, not *declared*), it would show 0 triples changed and decline to
  apply anything — a Quick Fix only ever edits the document you're
  actually looking at, never an imported file.
- `PRJ-REQUIRED` also fires on `ex:isOwnerOf` (missing `rdfs:domain`/
  `rdfs:range`) — but no Quick Fix is offered for it. There's no safe
  value to invent for a domain/range class, so `class-rules.json`'s
  `requires` list is honest about flagging it without pretending to fix it.

## Part 4: Validate with the reasoner

Open `reasoning-demo.ttl` (kept separate from `clinic.ttl` so its findings
aren't mixed in) and run **Run Local Checks** again. You'll see:

- **`REA-DISJOINT`** on `ex:rex` — asserted `a ex:Puppy, ex:Cat`. `Puppy`
  isn't itself declared disjoint with `Cat` — only `Dog` is. This finding
  only appears because the reasoner (EYE, via the `eyereasoner` WASM
  package) first infers `ex:rex a ex:Dog` from `Puppy rdfs:subClassOf Dog`,
  *then* checks disjointness — a real demonstration of the closure doing
  more than flat pattern-matching.
- **`REA-SAMEDIFF`** on `ex:alice` — asserted both `owl:sameAs` and
  `owl:differentFrom` the same individual.

Try it yourself: add `ex:Puppy owl:disjointWith ex:Cat` directly (making it
non-inferred) and re-run — the same finding still appears, now for a more
obvious reason. Then remove the `ex:rex a ex:Cat` triple entirely and
re-run — `REA-DISJOINT` disappears.

## Part 5: Visualize

With `clinic.ttl` active, run **"Ontology Suite: Visualize Subject Graph"**,
pick a few classes (or accept the default first-10), and you'll get a real
rendered SVG (via `@viz-js/viz`, the actual Graphviz WASM build — the same
mechanism that generated the image in the main `README.md`).

## Part 6: Metrics & DL expressivity

Run **"Ontology Suite: Show Metrics & DL Expressivity"** on `clinic.ttl`.
You'll get a Markdown report with OntoQA-style schema metrics (class
count, inheritance/relationship/attribute richness, hierarchy depth) and a
DL-expressivity label. Because `clinic.ttl` only uses atomic
`rdfs:subClassOf`/`rdfs:domain`/`rdfs:range`/`owl:disjointWith` (no
`and`/`or`/`some`/`only`/cardinality restrictions), you'll see a fairly
minimal expressivity label and full `EL`/`QL`/`RL` profile membership —
compare against `examples/ontology/expressions-demo.ttl`, which uses real
`owl:someValuesFrom`/`intersectionOf`/`qualifiedCardinality` restrictions
and drops out of all three lighter profiles.

The same expressivity/profile badge also lives in the status bar whenever
an RDF file is active — click it to open the same report.

## Part 7: TARQL-style triplification

Open `queries/appointments.rq` — a CONSTRUCT query for
`csv/appointments.csv` (paired by filename convention). Run **"Ontology
Suite: Open Query Workbench"**. You'll see, live and updating as you edit:

1. **The static sketch** — the CONSTRUCT template's shape, with `?var`s
   turned into `:var` entities, no CSV or SPARQL engine involved.
2. **The real triplified output** — all three CSV rows actually run
   through Oxigraph (via a SPARQL `VALUES` injection reproducing TARQL's
   per-row-binding semantics), producing real typed triples: dates as
   `xsd:date`, animal/vet names IRI-minted with `ENCODE_FOR_URI` (so `Dr
   Patel` correctly becomes `vet-Dr%20Patel`).
3. **A conformance warning**: `ex:appointmentNotes` is used in the
   CONSTRUCT template but never declared in `clinic.ttl` — deliberately,
   to show what an undeclared-property warning looks like. Try adding
   `ex:appointmentNotes a owl:DatatypeProperty .` to `clinic.ttl` and
   watch the warning disappear on the next live-preview refresh.

Once you're happy with a query, **"Run Full Triplify"** hands the real CSV
folder off to the Python CLI's `oxi-gen` binary for production-scale
output (optional — only if `consolidated_ontology_suite` is installed).

## Part 8: Competency questions as tests

`instances.ttl` is a hand-saved snapshot of what triplifying
`appointments.csv` would produce — with `appointment-2` **deliberately**
missing a `ex:treatedBy` vet assignment, to give the test suite something
real to catch.

Open the **Test Explorer** (flask icon in the sidebar). You'll see two
`.cq.rq` competency questions:

- **`every-appointment-has-vet`** — **red**. It checks `clinic.ttl` +
  `instances.ttl` and correctly finds the gap.
- **`every-appointment-has-date`** — **green**. Every appointment has a
  date.

Fix it yourself: add `ex:treatedBy ex:vet-DrIto` to `ex:appointment-2` in
`instances.ttl`, save, and re-run the tests — `every-appointment-has-vet`
turns green.

## Part 9: Convert between serializations

With any RDF file active, run **"Ontology Suite: Convert / Save As
Serialization..."** and pick a target format. Try converting `clinic.ttl`
to `.omn` (Manchester Syntax) — you'll get real `Class:`/`ObjectProperty:`/
`SubClassOf:` frames, not just a dump. Converting to Manchester specifically
will warn you first, since it only round-trips the OWL-axiom subset
(see the README's "Serializations" section) — everything in `clinic.ttl`
happens to be inside that subset, so nothing is actually lost here.

For a conversion that exercises real OWL2 class expressions (not just
atomic declarations), try `examples/ontology/expressions-demo.ttl`
instead — it has `someValuesFrom`, `intersectionOf`, and
`qualifiedCardinality` restrictions that all survive the round trip
losslessly (verified in `rdf/formats/classExpression.test.ts`).

## Part 10: A real upstream-ontology migration (gist v11 → v14.1)

This is the most "real-world" scenario in the tutorial: **`examples/gist/`**
vendors two actual, unmodified `gist` releases —
[`gistCore11.0.0.ttl`](examples/gist/gistCore11.0.0.ttl) (April 2022) and
[`gistCore14.1.0.ttl`](examples/gist/gistCore14.1.0.ttl) (April 2026) — and
a small extension ontology written against each.

Between these two versions, gist moved its entire namespace from
`https://ontologies.semanticarts.com/gist/` to
`https://w3id.org/semanticarts/ns/ontology/gist/` — confirmed directly by
diffing the two copied-in files, not assumed. The class/property *local
names* (`Organization`, `PhysicalIdentifiableItem`, `owns`, ...) stayed
identical; only the namespace IRI changed.

1. Open **`fleet-vehicle-gist11.ttl`** — "written for gist11": it
   `owl:imports <https://ontologies.semanticarts.com/o/gistCore11.0.0>`
   and uses `gist:` bound to the old namespace. With `gistCore11.0.0.ttl`
   present alongside it (it is), the import resolves cleanly and **Run
   Local Checks** passes without complaint.
2. Now imagine your workspace "upgraded" to only ship `gistCore14.1.0.ttl`
   — copy `fleet-vehicle-gist11.ttl` and `gistCore14.1.0.ttl` (not
   `gistCore11.0.0.ttl`) into a fresh folder and open the copy there. The
   `owl:imports` target no longer resolves to anything — Live Diagnostics
   flags the unresolved import directly on the `owl:imports` line, and
   `ex:Vehicle`'s `rdfs:subClassOf gist:PhysicalIdentifiableItem` now
   points at a completely undeclared class, because `gist:` still resolves
   to the *old* namespace that's no longer present anywhere in the merged
   graph.
3. **`fleet-vehicle-gist14.ttl`** is the fix: identical content, but
   `owl:imports` and the `gist:` prefix both re-pointed at the new
   namespace. Open it in that same gist14.1.0-only folder — imports
   resolve, superclasses resolve, clean.

The lesson this demonstrates concretely: because gist preserved local
names across the migration, the *entire* fix is two lines (`owl:imports`
target + one `@prefix` binding) — not a rewrite. This exact before/drift/
after sequence is asserted in `ontology/resolveImports.test.ts` if you want
to see it run automatically rather than by hand.

## Part 11: Scripting ontologies with TypeScript

Everything so far edits Turtle by hand or through one-shot commands. For
patterns that repeat across a data table — a family of related classes, the
same restriction shape applied many times — a real scripting language beats
both. This is the same idea as [Tawny-OWL](https://github.com/phillord/tawny-owl)
(a Clojure DSL over the OWL API): author ontology fragments as code, in a
real language, with real loops and functions. The DSL here
(`ontology-suite/dsl`) deliberately doesn't reinvent testing or reasoning —
it reuses the exact same Local Checks, reasoner, and class-expression engine
already exercised in Parts 2–5, just fed from a script instead of a hand-
written `.ttl` file.

Open **`examples/scripting/pets.ontology.ts`** — the simple case, a plain
`.ts` file with real VS Code IntelliSense (hover `defclass` to see its
signature):

```typescript
import { ontology, defclass, defobjectproperty } from 'ontology-suite/dsl';

ontology('http://example.org/pets#', 'pets');

const Animal = defclass('Animal', { label: 'Animal', comment: 'A living creature.' });
defclass('Dog', { label: 'Dog', subClassOf: [Animal] });
defclass('Cat', { label: 'Cat', subClassOf: [Animal] });

defobjectproperty('hasOwner', { label: 'has owner' });
```

With it active, run **"Ontology Suite: Run Ontology Script"**. Since no
`pets.ttl` exists next to it yet, one is created directly:

```turtle
pets:Animal a owl:Class;
    rdfs:label "Animal";
    rdfs:comment "A living creature.".
pets:Dog a owl:Class;
    rdfs:label "Dog";
    rdfs:subClassOf pets:Animal.
pets:Cat a owl:Class;
    rdfs:label "Cat";
    rdfs:subClassOf pets:Animal.
pets:hasOwner a owl:ObjectProperty;
    rdfs:label "has owner".
```

Now open **`examples/scripting/pets-advanced.ontology.ts`** — this is where
scripting earns its keep over a GUI or hand-typed Turtle. A real
`for`-loop generates a whole family of breed classes from a data table in
one step, `disjointWith` declares `Cat` and `Dog` mutually exclusive, and
`some()` builds a Manchester-style existential restriction — the exact same
`classExprToRdf` engine used by the Outline's "Add Subclass" restriction
option and by `.omn` files:

```typescript
const Animal = defclass('Animal');
const Dog = defclass('Dog');
const Cat = defclass('Cat', { disjointWith: [Dog] });
const Person = defclass('Person', { label: 'Person' });
const hasOwner = defobjectproperty('hasOwner', { label: 'has owner', domain: Animal, range: Person });

const breeds = [
  { name: 'Labrador', species: Dog },
  { name: 'Poodle', species: Dog },
  { name: 'Siamese', species: Cat },
];
for (const breed of breeds) {
  defclass(breed.name, { subClassOf: [breed.species] }); // deliberately no label
}

defclass('OwnedAnimal', {
  label: 'Owned Animal',
  subClassOf: [Animal, some(hasOwner, Person)],
});
```

Run **"Ontology Suite: Run Ontology Script"** again. This time `pets.ttl`
already exists, so a QuickPick asks **"Append"** or **"Replace whole
file"** — pick **Append** (the safe default; nothing already in `pets.ttl`
is touched). The appended Turtle is real, including the anonymous
restriction blank node:

```turtle
pets:Animal a owl:Class.
pets:Dog a owl:Class.
pets:Cat a owl:Class;
    owl:disjointWith pets:Dog.
pets:Person a owl:Class;
    rdfs:label "Person".
pets:hasOwner a owl:ObjectProperty;
    rdfs:label "has owner";
    rdfs:domain pets:Animal;
    rdfs:range pets:Person.
pets:Labrador a owl:Class;
    rdfs:subClassOf pets:Dog.
pets:Poodle a owl:Class;
    rdfs:subClassOf pets:Dog.
pets:Siamese a owl:Class;
    rdfs:subClassOf pets:Cat.
pets:OwnedAnimal a owl:Class;
    rdfs:label "Owned Animal";
    rdfs:subClassOf pets:Animal.
_:n3-0 a owl:Restriction;
    owl:onProperty pets:hasOwner;
    owl:someValuesFrom pets:Person.
pets:OwnedAnimal rdfs:subClassOf _:n3-0.
```

### Local Checks catch what the loop left out

`Labrador`, `Poodle`, and `Siamese` were deliberately left without a
`rdfs:label` in the loop above. Run **Run Local Checks** on `pets.ttl` and
you'll see exactly that:

```
QUA-001 (missing label): http://example.org/pets#Siamese
QUA-001 (missing label): http://example.org/pets#Poodle
QUA-001 (missing label): http://example.org/pets#Labrador
```

Fix them with the same Quick Fix flow from [Part 3](#part-3-quick-fix-the-findings) —
no special handling needed just because the triples came from a script
rather than a hand-typed file; once it's on disk as Turtle, every other
feature in this suite treats it identically.

### The reasoner and the graph view, together

Add one individual by hand at the bottom of `pets.ttl`:

```turtle
pets:rex a pets:Labrador .
```

Run **"Ontology Suite: Visualize Subject Graph"**, pick `pets:rex`, and
tick **"Show inferred (reasoner closure)"** in the toolbar. Nothing in
`pets.ttl` says `rex` is a `Dog` or an `Animal` — but the class hierarchy
built by the loop above (`Labrador ⊑ Dog ⊑` … `⊑ Animal`) lets the reasoner
derive both, and you'll see them rendered as dashed purple edges
(`pets:rex → pets:Dog`, `pets:rex → pets:Animal`, and
`pets:Labrador → pets:Animal`), exactly the same "asserted vs. inferred"
distinction as the badge introduced for reasoning results, now visualized
directly on the graph instead of only reported as text.

Now add a second, contradictory type assertion:

```turtle
pets:rex a pets:Siamese .
```

Run **Run Local Checks** again. `Labrador ⊑ Dog` and `Siamese ⊑ Cat`, and
the script above declared `Cat owl:disjointWith Dog` — so the reasoner
infers `rex a Dog` *and* `rex a Cat` from a chain the ontology never states
directly, then flags the contradiction:

```
REA-DISJOINT: Individual is asserted as both http://example.org/pets#Cat
and http://example.org/pets#Dog, which are declared owl:disjointWith each
other.
```

This is the same `REA-DISJOINT` mechanism as [Part 4](#part-4-validate-with-the-reasoner)'s
`Puppy`/`Cat` demo — the difference here is that every class involved
(`Labrador`, `Dog`, `Cat`, `disjointWith`) came from the loop-generating
script, not from typing Turtle by hand.

## Where to go next

- `README.md` — full command/settings reference, architecture diagram,
  packaging notes.
- `CHANGELOG.md` — what changed across 0.1.0, 0.2.0, and 0.3.0, including
  real bugs found and fixed while building this tutorial (`shacl-engine`
  crashing on some check shapes; `findPair` not searching sibling `csv/`/
  `queries/` directories) and the Quick Fix repair engine added in 0.3.0.
- `npm test` — the full automated suite these examples are also verified
  against (151 tests as of this writing).
