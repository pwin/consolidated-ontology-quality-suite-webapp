/**
 * The one place this extension crosses into holosdb.
 *
 * `holos-wasm-node` takes RDF as text and hands results back as text or as rdf-js terms, so
 * every caller needs the same two conversions: n3 quads out to a document on the way in, and
 * N-Triples strings back to n3 quads on the way out. Three modules need them —
 * `checks/sparqlRunner`, `checks/repairEngine` and `triplify/previewEvaluator` — and three
 * copies of a boundary is three places for it to drift.
 *
 * The module is `require`d lazily and left external by esbuild's `packages: 'external'`: its
 * wasm-bindgen shim reads the `.wasm` from its own package directory, which bundling would
 * break. Same arrangement as `shacl-wasm-node`, `eyereasoner` and `@viz-js/viz`.
 *
 * # Blank node labels do not survive the crossing
 *
 * Adding a term programmatically preserves its label; parsing a document does not, because a
 * document's labels are document-scoped and a parser may rename them. holosdb does. So a
 * blank node that went in as n3's `n3-0` comes back under holosdb's own label, and anything
 * correlating results with the input graph has to do it by something other than the label —
 * see `checks/merge.anonymousKey`, which matches anonymous findings positionally for exactly
 * this reason.
 */
import { DataFactory, Parser, Quad, Writer } from 'n3';

/** As much of holos-wasm-node as this extension uses. */
export interface HolosStore {
  /** Returns how many quads were added. `format` takes turtle, ntriples, nquads, trig, … */
  load(text: string, format: string, base?: string): number;
  /** A boolean for ASK, N-Triples strings for CONSTRUCT, rdf-js term rows for SELECT. */
  query(query: string, base?: string): unknown;
  /** A CONSTRUCT or DESCRIBE serialised. Refuses a SELECT or ASK. */
  queryRdf(query: string, format: string, base?: string): string;
  /** SPARQL Update. All-or-nothing: a refused write leaves the store as it was. */
  update(update: string, base?: string): UpdateOutcome;
  /** Everything the store holds. Use nquads or trig where named graphs matter. */
  dump(format: string): string;
  readonly size: number;
  free?: () => void;
}

export interface UpdateOutcome {
  inserted: number;
  deleted: number;
  graphsCreated: number;
  graphsDropped: number;
}

interface HolosModule {
  Store: new () => HolosStore;
}

/**
 * A term as this extension reads one.
 *
 * n3 and holosdb agree on `termType` and `value`, and oxigraph did too, which is why the
 * result-walking code in `sparqlRunner` needed no change when the engine did: it was written
 * against this shape rather than against any one library.
 */
export interface RdfTerm {
  termType: string;
  value: string;
  language?: string;
  datatype?: { value: string };
}

export interface RdfQuad {
  subject: RdfTerm;
  predicate: RdfTerm;
  object: RdfTerm;
}

function holos(): HolosModule {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('holos-wasm-node') as HolosModule;
}

/**
 * n3 quads as one N-Quads document.
 *
 * N-Quads because it carries a graph name, streams a line at a time, and needs no prefixes to
 * round-trip. A write error is thrown rather than swallowed: a graph that only partly arrived
 * would make every query quietly under-report, which looks like the data getting smaller
 * rather than like a bug.
 */
export function quadsToNQuads(quads: Quad[]): string {
  if (quads.length === 0) return '';
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
  return text;
}

/** An empty store. The caller owns it and should `free()` it. */
export function emptyStore(): HolosStore {
  const { Store } = holos();
  return new Store();
}

/** An empty store holding these quads. The caller owns it and should `free()` it. */
export function storeWithQuads(quads: Quad[]): HolosStore {
  const store = emptyStore();
  const text = quadsToNQuads(quads);
  if (text) store.load(text, 'nquads', undefined);
  return store;
}

/**
 * What `query` returned for a CONSTRUCT, as n3 quads.
 *
 * The binding hands back one N-Triples string per triple with no trailing separator, so the
 * separator is added here. A non-array, or an array of anything but strings, means the query
 * was not a CONSTRUCT — an ASK returns a boolean and a SELECT returns term rows — which is a
 * caller error rather than an empty result, so it is reported as one.
 */
export function constructedQuads(result: unknown): Quad[] {
  if (typeof result === 'boolean') {
    throw new Error('expected a CONSTRUCT, not an ASK');
  }
  if (!Array.isArray(result)) {
    throw new Error(`expected a CONSTRUCT; got ${typeof result}`);
  }
  if (result.length === 0) return [];
  if (typeof result[0] !== 'string') {
    throw new Error('expected a CONSTRUCT, not a SELECT');
  }
  const nt = (result as string[]).map((line) => `${line} .`).join('\n');
  return new Parser({ format: 'N-Triples' }).parse(nt);
}

/**
 * The IRI prefix a skolemised blank node wears while it is inside the store.
 *
 * Long and specific so it cannot collide with anything an ontology declares, and greppable
 * so a leak into a file is obvious.
 */
const SKOLEM = 'urn:x-holos-skolem:';

/**
 * A graph whose blank nodes are IRIs, so its labels survive a round trip through a document.
 *
 * Blank node labels are document-scoped: a parser may rename them, and both holosdb and n3
 * do. That is fine when results are only *reported* — `sparqlRunner` never correlates a
 * finding back to an input term — and fatal when they are *diffed*, which is what
 * `repairEngine` does: it compares the store before and after an update and then writes the
 * result back over the user's file.
 *
 * Replacing each blank node with a stable IRI makes every label round-trip exactly, so a diff
 * can be computed on plain term equality and the file keeps the labels it had.
 *
 * **It changes what the data means, so it is opt-in.** A skolemised node answers `isBlank()`
 * with false, so any query that asks would get a different answer. `repairEngine` is the only
 * caller, no repair template mentions `isBlank` or matches a blank-node pattern, and
 * `repairEngine.test.ts` asserts that stays true.
 */
export function skolemise(quads: Quad[]): Quad[] {
  return quads.map((q) => {
    const subject = q.subject.termType === 'BlankNode'
      ? DataFactory.namedNode(SKOLEM + q.subject.value)
      : q.subject;
    const object = q.object.termType === 'BlankNode'
      ? DataFactory.namedNode(SKOLEM + q.object.value)
      : q.object;
    if (subject === q.subject && object === q.object) return q;
    return DataFactory.quad(subject as never, q.predicate as never, object as never, q.graph);
  });
}

/** The inverse of `skolemise`. A term that was never skolemised passes through untouched. */
export function deskolemise(quads: Quad[]): Quad[] {
  const back = (t: Quad['subject'] | Quad['object']) =>
    t.termType === 'NamedNode' && t.value.startsWith(SKOLEM)
      ? DataFactory.blankNode(t.value.slice(SKOLEM.length))
      : t;
  return quads.map((q) => {
    const subject = back(q.subject);
    const object = back(q.object);
    if (subject === q.subject && object === q.object) return q;
    return DataFactory.quad(subject as never, q.predicate as never, object as never, q.graph);
  });
}

/** Everything a store holds, as n3 quads. Graph names survive; `dump` uses N-Quads. */
export function storeQuads(store: HolosStore): Quad[] {
  const nq = store.dump('nquads');
  if (!nq.trim()) return [];
  return new Parser({ format: 'N-Quads' }).parse(nq);
}
