import type { Quad } from 'n3';
import { HolosStore, storeWithQuads } from '../rdf/holosStore';
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
 * CSV rows via holosdb, for the live triplify preview -- the single
 * biggest UX addition over both source projects (neither offers live,
 * incremental preview of triplified output).
 *
 * TARQL's per-row semantics ("each CSV row pre-binds its column values as
 * SPARQL variables, WHERE/CONSTRUCT run once per row") are reproduced with
 * *standard* SPARQL 1.1: a `VALUES (?col1 ?col2 …) { (row1…) (row2…) … }`
 * clause is injected as the first thing inside the query's WHERE block, so
 * The engine iterates every sampled row in a single query execution rather
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

  const store = storeFor(ontologyQuads);

  try {
    // queryRdf rather than query: this pane shows a document, so the engine serialises it
    // instead of handing back terms for us to reassemble. It refuses a SELECT, which is the
    // right answer for a preview of a CONSTRUCT and reaches the caller as `error` below.
    const turtle = store.queryRdf(injected, 'turtle', undefined);
    return { turtle, rowsUsed: csv.rows.length, skippedColumns };
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
 * One cached store, rebuilt only when the ontology graph itself changes.
 *
 * The Query Workbench re-evaluates on every edit, debounced at 500ms, so a store per call
 * is a store per keystroke. That is worth avoiding whatever the engine, because WASM linear
 * memory never shrinks: an abandoned store is heap the editor holds until it exits.
 *
 * The measurement that put this cache here was taken against oxigraph, where building a
 * store meant converting every quad into wasm-bindgen wrappers -- four per quad -- freed
 * lazily via FinalizationRegistry. +59 MB over 200 refreshes against a 67-quad ontology,
 * none of it reclaimed by a forced GC, and a real session reached an out-of-memory crash at
 * ~3.8 GB. That specific mechanism is gone: the graph now crosses as one N-Quads document,
 * so there are no per-quad wrappers to leak. What remains is a parse and an engine per
 * keystroke, which is still waste, and a store that is still not reclaimed if dropped
 * without `free()`.
 *
 * The ontology does not change while someone types a *query*, so the store is keyed on the
 * quad array's identity: the caller holds one array across refreshes and the store is reused
 * untouched. A genuinely new graph frees the old store before building the next, so at most
 * one is ever live.
 */
let cachedStore: { key: Quad[]; store: HolosStore } | undefined;

function storeFor(ontologyQuads: Quad[]): HolosStore {
  if (cachedStore && cachedStore.key === ontologyQuads) return cachedStore.store;
  if (cachedStore) freeWasm(cachedStore.store);

  const store = storeWithQuads(ontologyQuads);
  cachedStore = { key: ontologyQuads, store };
  return store;
}

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
