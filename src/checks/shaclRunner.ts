import * as fs from 'node:fs';
import { Parser, Quad } from 'n3';
import { localName, Registry } from './registryLoader';
import { SH } from '../rdf/vocab';
import type { ResultRow, Severity } from '../types';

const SEVERITY_LABEL: Record<string, Severity> = {
  'http://www.w3.org/ns/shacl#Violation': 'Violation',
  'http://www.w3.org/ns/shacl#Warning': 'Warning',
  'http://www.w3.org/ns/shacl#Info': 'Info',
};

const SH_SEVERITY = `${SH}severity`;
const SH_SPARQL = `${SH}sparql`;

interface CachedShapes {
  validator: import('shacl-engine').Validator;
  /** Shape IRI -> the severity that shape actually declares; see extractDeclaredSeverities. */
  declaredSeverities: Map<string, Severity>;
}

const cachedValidators = new Map<string, CachedShapes>();

/**
 * Runs the registry's shapes/*.ttl (advanced SHACL-SPARQL shapes named
 * `oq:<CHECK-ID>`, mirroring consolidated_ontology_suite's pyshacl-based
 * runner) via `shacl-engine` -- the only pure-JS SHACL engine found that
 * actually implements SPARQL-based constraints/targets (`sh:sparql`,
 * `sh:target [a sh:SPARQLTarget]`); `rdf-validate-shacl` was tried first
 * and silently reports `conforms: true` against these shapes since it only
 * covers SHACL Core, not the SPARQL extensions every check here relies on.
 *
 * Validates **one shapes file at a time**, not all six merged into one
 * Validator: `shacl-engine`'s SPARQL plugin (via its pinned Comunica-lite
 * dependency, see package.json's `overrides`) throws `Tried to bind
 * variable ?this in a GROUP BY operator` on some SPARQL-constraint shapes
 * against some graphs -- confirmed data/query-shape-dependent, not a
 * blanket incompatibility (`data.ttl`/`efficiency.ttl` crash against a
 * real ontology fixture while `structural.ttl`/`style.ttl`/`logical.ttl`/
 * `quality.ttl` succeed with real findings on the exact same graph).
 * Merging all shapes into one Validator meant one incompatible file
 * silently zeroed out every other file's real results; per-file isolation
 * means a crash in one only costs that file's checks.
 *
 * `shacl-engine`'s SPARQL plugin pulls in a Comunica-lite query engine,
 * whose *module graph* costs real time to load on first import -- each
 * file's `Validator` instance is cached at module scope so that cost (and
 * the shape-parsing cost) is paid once per file per session, not once per
 * check run.
 *
 * **Patched dependency, see `patches/shacl-engine+1.1.2.patch`**: caching
 * the `Validator` alone didn't actually buy the above -- confirmed by
 * timing real runs against `examples/tutorial/clinic.ttl` before and after
 * (three consecutive warm runs: ~6.7s each, unpatched; ~1.1s each,
 * patched). `shacl-engine`'s own `lib/sparql.js` constructs a brand new
 * Comunica `QueryEngine` on *every* `sh:sparql` constraint/target
 * evaluation (once per focus node, not once per validate() call) --
 * Comunica's own docs recommend constructing one `QueryEngine` and reusing
 * it across queries, which is exactly what the patch does (a module-scope
 * singleton in `sparql.js`, no behavior change to which sources/bindings
 * each query runs against). `npm install` reapplies this automatically via
 * `postinstall: patch-package` -- if `shacl-engine` is ever upgraded past
 * 1.1.2, re-verify this still applies (`npx patch-package shacl-engine`)
 * or drop it if upstream fixes this directly.
 */
export async function runShaclChecks(quads: Quad[], registry: Registry): Promise<ResultRow[]> {
  const dataFactory = (await import('@rdfjs/data-model')).default;
  const rdf = (await import('@zazuko/env-node')).default;
  const dataDataset = rdf.dataset(quads as never);

  const rows: ResultRow[] = [];
  for (const file of registry.shaclFiles) {
    const shapes = await getOrBuildValidator(file, dataFactory, rdf);
    if (!shapes) continue;
    try {
      const report = await shapes.validator.validate({ dataset: dataDataset });
      rows.push(...toResultRows(report, registry, shapes.declaredSeverities));
    } catch (err) {

      console.error(`[ontologySuite] shacl-engine failed validating against ${file} (see shaclRunner.ts's per-file-isolation comment):`, err);
    }
  }
  return rows;
}

/**
 * Shape IRI -> the severity that shape actually declares.
 *
 * `shacl-engine` silently drops `sh:severity` declared *inside* a shape's
 * `sh:sparql [ a sh:SPARQLConstraint ; ... ]` block, reporting every
 * SPARQL-constraint result as `sh:Violation` regardless of what the shape says.
 * Confirmed empirically against `resources/checks-registry/shapes` rather than
 * assumed: `STR-003` declares `sh:Warning` and `STY-003` declares `sh:Info`, yet
 * all 11 findings against `examples/ontology/domain.ttl` came back `Violation`,
 * while the *same* checks' SPARQL-CONSTRUCT counterparts (sparqlRunner.ts, same
 * registry) correctly reported 9 Info / 3 Warning / 2 Violation -- so the two
 * engines contradicted each other on identical findings, and 8 rows reached the
 * Problems panel as red errors that the registry says are Info/Warning. The
 * identical limitation is documented upstream in
 * `consolidated_ontology_suite_python` for pyshacl (its 0.3.3 review, finding 1),
 * which resolved it by switching to a native engine -- not an option here, since
 * `shacl-engine` is the only pure-JS engine implementing SHACL-SPARQL at all.
 *
 * Applied as an override in `toResultRows` rather than by rewriting the shapes,
 * so `resources/checks-registry/` stays byte-identical to the copied-in upstream
 * registry (verified: all 6 shapes files and all 39 shared SPARQL checks match
 * upstream exactly). A severity declared directly on the shape -- the
 * spec-proper location, which the engine already honors -- wins over one found
 * inside its `sh:sparql` block, so this can only ever correct a dropped value,
 * never contradict one the engine got right.
 */
function extractDeclaredSeverities(shapeQuads: Quad[]): Map<string, Severity> {
  const severityBySubject = new Map<string, Severity>();
  const sparqlNodeToShape = new Map<string, string>();
  for (const q of shapeQuads) {
    if (q.predicate.value === SH_SEVERITY && q.object.termType === 'NamedNode') {
      const severity = SEVERITY_LABEL[q.object.value];
      if (severity) severityBySubject.set(q.subject.value, severity);
    } else if (q.predicate.value === SH_SPARQL) {
      sparqlNodeToShape.set(q.object.value, q.subject.value);
    }
  }

  const declared = new Map<string, Severity>();
  for (const [sparqlNode, shapeIri] of sparqlNodeToShape) {
    const severity = severityBySubject.get(sparqlNode);
    if (severity) declared.set(shapeIri, severity);
  }
  // Spec-proper placement wins -- see the note above.
  for (const [subject, severity] of severityBySubject) {
    if (!sparqlNodeToShape.has(subject)) declared.set(subject, severity);
  }
  return declared;
}

function toResultRows(
  report: Awaited<ReturnType<import('shacl-engine').Validator['validate']>>,
  registry: Registry,
  declaredSeverities: Map<string, Severity>,
): ResultRow[] {
  const rows: ResultRow[] = [];
  for (const result of report.results) {
    const sourceShapeIri = result.shape?.ptr?.value;
    const checkId = sourceShapeIri ? localName(sourceShapeIri) : null;
    const check = checkId ? registry.checksById.get(checkId) : undefined;
    const focus = result.focusNode?.value ?? '';
    const messageTerms = Array.isArray(result.message) ? result.message : result.message ? [result.message] : [];
    const engineSeverity: Severity = result.severity?.value ? (SEVERITY_LABEL[result.severity.value] ?? 'Info') : 'Info';

    rows.push({
      checkId,
      category: check?.category ?? null,
      title: check?.title ?? null,
      severity: (sourceShapeIri ? declaredSeverities.get(sourceShapeIri) : undefined) ?? engineSeverity,
      focusNode: focus,
      path: result.path?.value ?? null,
      value: result.value?.value ?? focus,
      message: messageTerms.map((m) => m.value).join(' ') || (checkId ? `Violates ${checkId}.` : 'SHACL validation failed.'),
      remediation: check?.remediation ?? null,
      sources: ['shacl'],
    });
  }
  return rows;
}

async function getOrBuildValidator(
  file: string,
  dataFactory: typeof import('@rdfjs/data-model').default,
  rdf: typeof import('@zazuko/env-node').default,
): Promise<CachedShapes | undefined> {
  const cached = cachedValidators.get(file);
  if (cached) return cached;

  let shapeQuads: Quad[];
  try {
    shapeQuads = new Parser().parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {

    console.error(`[ontologySuite] failed to parse shapes file ${file}:`, err);
    return undefined;
  }
  if (shapeQuads.length === 0) return undefined;

  const { Validator } = await import('shacl-engine');
  const { targetResolvers, validations } = await import('shacl-engine/sparql.js');
  const shapesDataset = rdf.dataset(shapeQuads as never);
  const validator = new Validator(shapesDataset, { factory: dataFactory, targetResolvers, validations });
  const entry: CachedShapes = { validator, declaredSeverities: extractDeclaredSeverities(shapeQuads) };
  cachedValidators.set(file, entry);
  return entry;
}
