import * as fs from 'node:fs';
import { Parser, Quad } from 'n3';
import { localName, Registry } from './registryLoader';
import type { ResultRow, Severity } from '../types';

const SEVERITY_LABEL: Record<string, Severity> = {
  'http://www.w3.org/ns/shacl#Violation': 'Violation',
  'http://www.w3.org/ns/shacl#Warning': 'Warning',
  'http://www.w3.org/ns/shacl#Info': 'Info',
};

interface CachedValidator {
  validator: import('shacl-engine').Validator;
  shapeFilesKey: string;
}
let cached: CachedValidator | undefined;

/**
 * Runs the registry's shapes/*.ttl (advanced SHACL-SPARQL shapes named
 * `oq:<CHECK-ID>`, mirroring consolidated_ontology_suite's pyshacl-based
 * runner) via `shacl-engine` -- the only pure-JS SHACL engine found that
 * actually implements SPARQL-based constraints/targets (`sh:sparql`,
 * `sh:target [a sh:SPARQLTarget]`); `rdf-validate-shacl` was tried first
 * and silently reports `conforms: true` against these shapes since it only
 * covers SHACL Core, not the SPARQL extensions every check here relies on.
 *
 * `shacl-engine`'s SPARQL plugin pulls in a Comunica-lite query engine,
 * whose *module graph* costs several seconds to load on first import --
 * the `Validator` instance is cached at module scope so that cost (and the
 * shapes-parsing cost) is paid once per session, not once per check run.
 */
export async function runShaclChecks(quads: Quad[], registry: Registry): Promise<ResultRow[]> {
  const dataFactory = (await import('@rdfjs/data-model')).default;
  const rdf = (await import('@zazuko/env-node')).default;

  const validator = await getOrBuildValidator(registry, dataFactory, rdf);
  if (!validator) return [];

  const dataDataset = rdf.dataset(quads as never);
  const report = await validator.validate({ dataset: dataDataset });

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
  registry: Registry,
  dataFactory: typeof import('@rdfjs/data-model').default,
  rdf: typeof import('@zazuko/env-node').default,
): Promise<import('shacl-engine').Validator | undefined> {
  const key = registry.shaclFiles.slice().sort().join('|');
  if (cached && cached.shapeFilesKey === key) return cached.validator;

  const shapeQuads: Quad[] = [];
  for (const file of registry.shaclFiles) {
    try {
      shapeQuads.push(...new Parser().parse(fs.readFileSync(file, 'utf8')));
    } catch (err) {
       
      console.error(`[ontologySuite] failed to parse shapes file ${file}:`, err);
    }
  }
  if (shapeQuads.length === 0) return undefined;

  const { Validator } = await import('shacl-engine');
  const { targetResolvers, validations } = await import('shacl-engine/sparql.js');
  const shapesDataset = rdf.dataset(shapeQuads as never);
  const validator = new Validator(shapesDataset, { factory: dataFactory, targetResolvers, validations });
  cached = { validator, shapeFilesKey: key };
  return validator;
}
