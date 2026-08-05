import * as fs from 'node:fs';
import { Parser, Quad } from 'n3';
import { localName, Registry } from './registryLoader';
import type { ResultRow, Severity } from '../types';

const SEVERITY_LABEL: Record<string, Severity> = {
  'http://www.w3.org/ns/shacl#Violation': 'Violation',
  'http://www.w3.org/ns/shacl#Warning': 'Warning',
  'http://www.w3.org/ns/shacl#Info': 'Info',
};

const cachedValidators = new Map<string, import('shacl-engine').Validator>();

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
    const validator = await getOrBuildValidator(file, dataFactory, rdf);
    if (!validator) continue;
    try {
      const report = await validator.validate({ dataset: dataDataset });
      rows.push(...toResultRows(report, registry));
    } catch (err) {
       
      console.error(`[ontologySuite] shacl-engine failed validating against ${file} (see shaclRunner.ts's per-file-isolation comment):`, err);
    }
  }
  return rows;
}

function toResultRows(report: Awaited<ReturnType<import('shacl-engine').Validator['validate']>>, registry: Registry): ResultRow[] {
  const rows: ResultRow[] = [];
  for (const result of report.results) {
    const sourceShapeIri = result.shape?.ptr?.value;
    const checkId = sourceShapeIri ? localName(sourceShapeIri) : null;
    const check = checkId ? registry.checksById.get(checkId) : undefined;
    const focus = result.focusNode?.value ?? '';
    const messageTerms = Array.isArray(result.message) ? result.message : result.message ? [result.message] : [];

    rows.push({
      checkId,
      category: check?.category ?? null,
      title: check?.title ?? null,
      severity: result.severity?.value ? (SEVERITY_LABEL[result.severity.value] ?? 'Info') : 'Info',
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
): Promise<import('shacl-engine').Validator | undefined> {
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
  cachedValidators.set(file, validator);
  return validator;
}
