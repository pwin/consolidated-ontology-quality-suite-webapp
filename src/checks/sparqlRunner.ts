import * as fs from 'node:fs';
import * as path from 'node:path';
import { Quad } from 'n3';
import { localName, Registry } from './registryLoader';
import { renderPathExpression } from './pathExpression';
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
 *
 * `disabled` holds check ids from `ontologySuite.disabledChecks`. Their queries
 * are skipped rather than run and filtered, since each is a full pass over the
 * merged graph.
 */
export function runSparqlChecks(quads: Quad[], registry: Registry, disabled: ReadonlySet<string> = new Set()): ResultRow[] {
  // Imported lazily: oxigraph's WASM module is only needed when checks run.
   
  const oxigraph = require('oxigraph') as typeof import('oxigraph');
  const store = new oxigraph.Store();
  loadQuadsIntoStore(store, oxigraph, quads);

  const rows: ResultRow[] = [];
  for (const file of registry.sparqlFiles) {
    // The file is named for the check it runs, so this needs no parse to decide.
    if (disabled.has(path.basename(file, '.rq'))) continue;
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
    for (const r of extractRows(resultQuads as OxiQuad[], registry, 'sparql')) rows.push(r);
  }
  // Same reasoning as previewEvaluator: release the WASM store rather than waiting
  // on finalization. Less pressing here (once per checks run, not per keystroke) but
  // the store holds the whole merged graph, so it is the larger single allocation.
  (store as unknown as { free?: () => void }).free?.();
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

/**
 * One display string for a result property that may legitimately carry several
 * values, ordered so the same finding always renders identically -- see the
 * note at the call site for which checks bind two on purpose.
 */
function joined(values: string[]): string | null {
  if (values.length === 0) return null;
  return [...new Set(values)].sort().join(', ');
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
    const all = (pred: string): OxiTerm[] => subjectQuads.filter((q) => q.predicate.value === pred).map((q) => q.object);
    const severity = get(SH_RESULT_SEVERITY);
    const focus = get(SH_FOCUS_NODE);
    const message = get(SH_RESULT_MESSAGE);
    const scc = get(SH_SOURCE_CONSTRAINT_COMPONENT);
    if (!focus) continue;

    // sh:resultPath and sh:value are read as *sets*, not as "whichever came
    // back first". Several of the registry's CONSTRUCTs bind two values for
    // one finding deliberately -- LOG-004's two inverses, LOG-006/007's domain
    // and range, REA-001's two disjoint classes, STR-007's subject and object
    // -- so taking one arbitrarily both halves the finding and makes the dedup
    // key depend on result order, which is not guaranteed. Sorting and joining
    // makes the key order-independent and shows the whole finding.
    const path = joined(all(SH_RESULT_PATH).map((p) => renderPathExpression(p, bySubject)));
    // A check whose CONSTRUCT never binds sh:value defaults to the focus
    // node, matching pyshacl's own default for sh:select queries without a
    // ?value column -- keeps the SPARQL and SHACL formulations of the same
    // check deduplicating to one finding instead of two.
    const value = joined(all(SH_VALUE).map((v) => v.value)) ?? focus.value;

    const checkId = scc ? localName(scc.value) : null;
    const check = checkId ? registry.checksById.get(checkId) : undefined;

    results.push({
      checkId: checkId ?? null,
      category: check?.category ?? null,
      title: check?.title ?? null,
      severity: severity ? (SEVERITY_LABEL[severity.value] ?? 'Info') : 'Info',
      focusNode: focus.value,
      path: path,
      value: value,
      message: message?.value ?? subject,
      remediation: check?.remediation ?? null,
      sources: [source],
    });
  }
  return results;
}
