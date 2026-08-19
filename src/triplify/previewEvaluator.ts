import type { Quad } from 'n3';
import type { CsvSample } from '../types';

const VALID_SPARQL_VAR = /^[A-Za-z_][A-Za-z0-9_]*$/;
const WHERE_BLOCK = /\bWHERE\s*\{/i;

export interface PreviewResult {
  turtle: string;
  rowsUsed: number;
  skippedColumns: string[];
  error?: string;
}

/**
 * Executes a real TARQL/oxi-gen-style CONSTRUCT query against a sample of
 * CSV rows via Oxigraph, for the live triplify preview -- the single
 * biggest UX addition over both source projects (neither offers live,
 * incremental preview of triplified output).
 *
 * TARQL's per-row semantics ("each CSV row pre-binds its column values as
 * SPARQL variables, WHERE/CONSTRUCT run once per row") are reproduced with
 * *standard* SPARQL 1.1: a `VALUES (?col1 ?col2 …) { (row1…) (row2…) … }`
 * clause is injected as the first thing inside the query's WHERE block, so
 * Oxigraph iterates every sampled row in a single query execution rather
 * than one execution per row.
 */
export function evaluatePreview(queryText: string, csv: CsvSample, ontologyQuads: import('n3').Quad[] = []): PreviewResult {
  const skippedColumns = csv.headers.filter((h) => !VALID_SPARQL_VAR.test(h));
  const usableHeaders = csv.headers.filter((h) => VALID_SPARQL_VAR.test(h));

  const match = WHERE_BLOCK.exec(queryText);
  if (!match) {
    return { turtle: '', rowsUsed: 0, skippedColumns, error: 'No WHERE clause found in query.' };
  }

  const valuesClause = buildValuesClause(usableHeaders, csv.rows);
  const insertAt = match.index + match[0].length;
  const injected = `${queryText.slice(0, insertAt)}\n  ${valuesClause}\n${queryText.slice(insertAt)}`;

   
  const oxigraph = require('oxigraph') as typeof import('oxigraph');
  const store = storeFor(oxigraph, ontologyQuads);

  try {
    const result = store.query(injected, { results_format: 'text/turtle' });
    return { turtle: typeof result === 'string' ? result : '', rowsUsed: csv.rows.length, skippedColumns };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { turtle: '', rowsUsed: 0, skippedColumns, error: message };
  }
}

/** wasm-bindgen emits `free()` at runtime but omits it from the .d.ts, hence the cast. */
function freeWasm(handle: unknown): void {
  (handle as { free?: () => void }).free?.();
}

/**
 * One cached Oxigraph store, rebuilt only when the ontology graph itself changes.
 *
 * The Query Workbench re-evaluates on every edit, debounced at 500ms. Building a
 * store per call meant converting every ontology quad into wasm-bindgen wrappers
 * each time -- four per quad -- and wasm-bindgen frees lazily via FinalizationRegistry
 * while WASM linear memory never shrinks. Measured: +59 MB over 200 refreshes against
 * a 67-quad ontology, none of it reclaimed by a forced GC. A real session against a
 * real ontology reached an out-of-memory crash at ~3.8 GB.
 *
 * The ontology does not change while someone types a *query*, so the store is keyed
 * on the quad array's identity: the caller holds one array across refreshes and the
 * store is reused untouched. A genuinely new graph frees the old store before
 * building the next, so at most one is ever live.
 */
let cachedStore: { key: Quad[]; store: OxiStore } | undefined;

function storeFor(oxigraph: typeof import('oxigraph'), ontologyQuads: Quad[]): OxiStore {
  if (cachedStore && cachedStore.key === ontologyQuads) return cachedStore.store;
  if (cachedStore) freeWasm(cachedStore.store);

  const store = new oxigraph.Store();
  for (const q of ontologyQuads) store.add(toOxiQuad(oxigraph, q));
  cachedStore = { key: ontologyQuads, store };
  return store;
}

type OxiStore = InstanceType<typeof import('oxigraph').Store>;

function buildValuesClause(headers: string[], rows: Record<string, string>[]): string {
  if (headers.length === 0 || rows.length === 0) return '';
  const varList = headers.map((h) => `?${h}`).join(' ');
  const rowLines = rows.map((row) => {
    const values = headers.map((h) => {
      const v = row[h];
      return v === undefined || v === '' ? 'UNDEF' : sparqlStringLiteral(v);
    });
    return `    (${values.join(' ')})`;
  });
  return `VALUES (${varList}) {\n${rowLines.join('\n')}\n  }`;
}

function sparqlStringLiteral(value: string): string {
  const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
  return `"${escaped}"`;
}

function toOxiQuad(oxi: typeof import('oxigraph'), q: import('n3').Quad) {
  const toTerm = (term: import('n3').Quad['subject'] | import('n3').Quad['predicate'] | import('n3').Quad['object']) => {
    switch (term.termType) {
      case 'NamedNode':
        return oxi.namedNode(term.value);
      case 'BlankNode':
        return oxi.blankNode(term.value);
      case 'Literal': {
        const lit = term as import('n3').Literal;
        return lit.language ? oxi.literal(lit.value, lit.language) : oxi.literal(lit.value, oxi.namedNode(lit.datatype.value));
      }
      default:
        return oxi.namedNode(term.value);
    }
  };
  return oxi.quad(toTerm(q.subject) as never, toTerm(q.predicate) as never, toTerm(q.object) as never);
}
