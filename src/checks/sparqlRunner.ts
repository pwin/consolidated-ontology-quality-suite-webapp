import * as fs from 'node:fs';
import * as path from 'node:path';
import { Parser, Quad, Writer } from 'n3';
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
 * Runs every registry.json-listed sparql/**\/*.rq CONSTRUCT check against the
 * combined ontology(+data) graph via **holosdb**, in-process. Each query
 * constructs sh:ValidationResult individuals (portable across engines); this
 * walks the constructed graph back into ResultRow, mirroring
 * consolidated_ontology_suite's checks/merge.py::_extract_rows.
 *
 * `disabled` holds check ids from `ontologySuite.disabledChecks`. Their queries
 * are skipped rather than run and filtered, since each is a full pass over the
 * merged graph.
 *
 * # Why holosdb and not oxigraph
 *
 * Both are conformant, and on these checks they agree -- which is the point:
 * the swap is not a bet on different answers. It makes both of the extension's
 * engines the ones this project maintains, so a defect found here can be fixed
 * here. The SHACL tier already runs on `shacl-wasm-node`; this is the other
 * half. The Python suite made the same move for the same reason -- see its
 * docs/ARCHITECTURE.md, "Which engine does the work".
 *
 * # What crossing the boundary costs
 *
 * holosdb's wasm binding takes RDF as *text* and returns CONSTRUCT results as
 * N-Triples strings, so this serialises the merged graph once per run and
 * parses each check's results back. oxigraph took n3 quads term by term.
 *
 * The visible consequence is blank node labels. Adding a term programmatically
 * preserves its label, which is why this arm used to report n3's own `n3-0`;
 * parsing text does not, because a document's labels are document-scoped and an
 * engine may rename them. So an anonymous focus node now carries holosdb's
 * label rather than n3's, which is why `merge.anonymousKey` cannot key on it
 * and matches anonymous findings positionally instead. Nothing that was
 * reproducible has stopped being so: the label was already arbitrary.
 */
export function runSparqlChecks(quads: Quad[], registry: Registry, disabled: ReadonlySet<string> = new Set()): ResultRow[] {
  // Imported lazily, and left as a real runtime `require` by esbuild's
  // `packages: 'external'` -- its wasm-bindgen shim reads the .wasm from its own
  // package directory, which bundling would break. Same arrangement as
  // shacl-wasm-node, eyereasoner and @viz-js/viz.
  const holos = require('holos-wasm-node') as HolosModule;
  const store = new holos.Store();
  loadQuadsIntoStore(store, quads);

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
    let resultQuads: Quad[];
    try {
      resultQuads = parseConstructed(store.query(queryText, undefined));
    } catch (err) {
      // A malformed check query shouldn't take down the whole run.
      console.error(`[ontologySuite] sparql check ${file} failed:`, err);
      continue;
    }
    if (resultQuads.length === 0) continue;
    for (const r of extractRows(resultQuads, registry, 'sparql')) rows.push(r);
  }
  // Same reasoning as previewEvaluator: release the WASM store rather than waiting
  // on finalization. Less pressing here (once per checks run, not per keystroke) but
  // the store holds the whole merged graph, so it is the larger single allocation.
  store.free?.();
  return rows;
}

/** As much of holos-wasm-node as this file uses. */
interface HolosStore {
  load(text: string, format: string, base?: string): number;
  /** A boolean for ASK, N-Triples strings for CONSTRUCT, row objects for SELECT. */
  query(query: string, base?: string): unknown;
  free?: () => void;
}
interface HolosModule {
  Store: new () => HolosStore;
}

/**
 * A term as this file reads one.
 *
 * n3's terms carry `termType` and `value` exactly as oxigraph's did, which is what let the
 * engine change without `extractRows` changing: it was already written against this shape
 * rather than against either library.
 */
interface RdfTerm {
  termType: string;
  value: string;
}
interface RdfQuad {
  subject: RdfTerm;
  predicate: RdfTerm;
  object: RdfTerm;
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

/**
 * Serialises the merged graph into the store, as N-Quads.
 *
 * The binding loads from a string, so the graph crosses as text rather than term by term.
 * N-Quads because it carries a graph name, streams a line at a time, and is the one
 * serialisation both sides agree on exactly -- and because n3's writer produces it without
 * needing prefixes to round-trip.
 *
 * A write error is thrown rather than swallowed: a graph that only partly arrived would make
 * every check quietly under-report, which looks like the checks going quiet rather than like
 * a bug.
 */
function loadQuadsIntoStore(store: HolosStore, quads: Quad[]): void {
  if (quads.length === 0) return;
  const writer = new Writer({ format: 'N-Quads' });
  for (const q of quads) writer.addQuad(q);
  let text = '';
  let failure: Error | undefined;
  // n3's Writer.end is callback-style but synchronous for an in-memory sink, so the result is
  // available by the time it returns.
  writer.end((err: Error | null, result: string) => {
    if (err) failure = err;
    else text = result;
  });
  if (failure) throw failure;
  store.load(text, 'nquads', undefined);
}

/**
 * Parses what `query` returned for a CONSTRUCT back into quads.
 *
 * The binding hands back one N-Triples string per triple with no trailing separator, so the
 * separator is added here before parsing. A non-array means the query was not a CONSTRUCT --
 * an ASK returns a boolean and a SELECT returns row objects -- which is a caller error rather
 * than an empty result, so it is reported as one.
 */
function parseConstructed(result: unknown): Quad[] {
  if (typeof result === 'boolean') {
    throw new Error('a check must be a CONSTRUCT, not an ASK');
  }
  if (!Array.isArray(result)) {
    throw new Error(`a check must be a CONSTRUCT; got ${typeof result}`);
  }
  if (result.length === 0) return [];
  if (typeof result[0] !== 'string') {
    throw new Error('a check must be a CONSTRUCT, not a SELECT');
  }
  const nt = (result as string[]).map((line) => `${line} .`).join('\n');
  return new Parser({ format: 'N-Triples' }).parse(nt);
}

function extractRows(quads: RdfQuad[], registry: Registry, source: string): ResultRow[] {
  const bySubject = new Map<string, RdfQuad[]>();
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

    const get = (pred: string): RdfTerm | undefined => subjectQuads.find((q) => q.predicate.value === pred)?.object;
    const all = (pred: string): RdfTerm[] => subjectQuads.filter((q) => q.predicate.value === pred).map((q) => q.object);
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
      // From the term, not the string: this arm reports n3's bare label while
      // the SHACL arm reports `_:`-prefixed, so the spelling cannot be the test.
      focusIsBlank: focus.termType === 'BlankNode',
    });
  }
  return results;
}
