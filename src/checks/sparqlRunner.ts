import * as fs from 'node:fs';
import { Quad } from 'n3';
import { localName, Registry } from './registryLoader';
import type { ResultRow, Severity } from '../types';

const SH_VALIDATION_RESULT = 'http://www.w3.org/ns/shacl#ValidationResult';
const SH_RESULT_SEVERITY = 'http://www.w3.org/ns/shacl#resultSeverity';
const SH_FOCUS_NODE = 'http://www.w3.org/ns/shacl#focusNode';
const SH_RESULT_PATH = 'http://www.w3.org/ns/shacl#resultPath';
const SH_VALUE = 'http://www.w3.org/ns/shacl#value';
const SH_RESULT_MESSAGE = 'http://www.w3.org/ns/shacl#resultMessage';
const SH_SOURCE_CONSTRAINT_COMPONENT = 'http://www.w3.org/ns/shacl#sourceConstraintComponent';

const SEVERITY_LABEL: Record<string, Severity> = {
  'http://www.w3.org/ns/shacl#Violation': 'Violation',
  'http://www.w3.org/ns/shacl#Warning': 'Warning',
  'http://www.w3.org/ns/shacl#Info': 'Info',
};

/**
 * Runs every registry.json-listed sparql/**\/*.rq CONSTRUCT check against
 * the combined ontology(+data) graph via Oxigraph, in-process. Each query
 * constructs sh:ValidationResult individuals (portable across engines);
 * this walks the constructed graph back into ResultRow, mirroring
 * consolidated_ontology_suite's checks/merge.py::_extract_rows.
 */
export function runSparqlChecks(quads: Quad[], registry: Registry): ResultRow[] {
  // Imported lazily: oxigraph's WASM module is only needed when checks run.
   
  const oxigraph = require('oxigraph') as typeof import('oxigraph');
  const store = new oxigraph.Store();
  loadQuadsIntoStore(store, oxigraph, quads);

  const rows: ResultRow[] = [];
  for (const file of registry.sparqlFiles) {
    let queryText: string;
    try {
      queryText = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    let resultQuads: unknown[];
    try {
      resultQuads = store.query(queryText) as unknown[];
    } catch (err) {
      // A malformed check query shouldn't take down the whole run.
       
      console.error(`[ontologySuite] sparql check ${file} failed:`, err);
      continue;
    }
    if (!Array.isArray(resultQuads) || resultQuads.length === 0) continue;
    rows.push(...extractRows(resultQuads as OxiQuad[], registry, 'sparql'));
  }
  return rows;
}

interface OxiTerm {
  termType: string;
  value: string;
}
interface OxiQuad {
  subject: OxiTerm;
  predicate: OxiTerm;
  object: OxiTerm;
}

function loadQuadsIntoStore(store: InstanceType<typeof import('oxigraph').Store>, oxi: typeof import('oxigraph'), quads: Quad[]): void {
  for (const q of quads) {
    store.add(
      oxi.quad(toOxiTerm(oxi, q.subject) as never, toOxiTerm(oxi, q.predicate) as never, toOxiTerm(oxi, q.object) as never),
    );
  }
}

function toOxiTerm(oxi: typeof import('oxigraph'), term: Quad['subject'] | Quad['predicate'] | Quad['object']) {
  switch (term.termType) {
    case 'NamedNode':
      return oxi.namedNode(term.value);
    case 'BlankNode':
      return oxi.blankNode(term.value);
    case 'Literal': {
      const lit = term as import('n3').Literal;
      if (lit.language) return oxi.literal(lit.value, lit.language);
      return oxi.literal(lit.value, oxi.namedNode(lit.datatype.value));
    }
    default:
      return oxi.namedNode(term.value);
  }
}

function extractRows(quads: OxiQuad[], registry: Registry, source: string): ResultRow[] {
  const bySubject = new Map<string, OxiQuad[]>();
  for (const q of quads) {
    const key = q.subject.value;
    if (!bySubject.has(key)) bySubject.set(key, []);
    bySubject.get(key)!.push(q);
  }

  const results: ResultRow[] = [];
  for (const [subject, subjectQuads] of bySubject) {
    const isValidationResult = subjectQuads.some(
      (q) => q.predicate.value === 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type' && q.object.value === SH_VALIDATION_RESULT,
    );
    if (!isValidationResult) continue;

    const get = (pred: string): OxiTerm | undefined => subjectQuads.find((q) => q.predicate.value === pred)?.object;
    const severity = get(SH_RESULT_SEVERITY);
    const focus = get(SH_FOCUS_NODE);
    const path = get(SH_RESULT_PATH);
    let value = get(SH_VALUE);
    const message = get(SH_RESULT_MESSAGE);
    const scc = get(SH_SOURCE_CONSTRAINT_COMPONENT);
    if (!focus) continue;
    // A check whose CONSTRUCT never binds sh:value defaults to the focus
    // node, matching pyshacl's own default for sh:select queries without a
    // ?value column -- keeps the SPARQL and SHACL formulations of the same
    // check deduplicating to one finding instead of two.
    if (!value) value = focus;

    const checkId = scc ? localName(scc.value) : null;
    const check = checkId ? registry.checksById.get(checkId) : undefined;

    results.push({
      checkId: checkId ?? null,
      category: check?.category ?? null,
      title: check?.title ?? null,
      severity: severity ? (SEVERITY_LABEL[severity.value] ?? 'Info') : 'Info',
      focusNode: focus.value,
      path: path?.value ?? null,
      value: value?.value ?? null,
      message: message?.value ?? subject,
      remediation: check?.remediation ?? null,
      sources: [source],
    });
  }
  return results;
}
