/**
 * Renders a SHACL property path -- `sh:path` in a shapes graph, `sh:resultPath`
 * in a report -- as a stable SPARQL 1.1 property-path expression.
 *
 * A path is only sometimes a plain IRI. SHACL also allows *path expressions*,
 * encoded as blank-node structures: `[ sh:oneOrMorePath rdfs:subClassOf ]`,
 * `[ sh:inversePath ... ]`, an RDF list for a sequence, `sh:alternativePath`
 * for `|`. Taking such a node's `.value` yields the blank node's *identifier*,
 * which is minted fresh per parse -- so the same finding gets a different path
 * on every run, and since `path` is part of the dedup key in merge.ts, the
 * SPARQL and SHACL formulations of one path-expression finding can never merge:
 * their blank node ids never match. `LOG-001`
 * (`sh:oneOrMorePath rdfs:subClassOf`) is this registry's own instance, and it
 * did exactly that -- one unsatisfiable class, two rows in the Problems panel,
 * one of them showing a raw `_:0_b0` where the path should be.
 *
 * Shared by both runners on purpose, and this is the whole reason the module
 * exists. Two renderings of one path only have to differ by a bracket for the
 * two rows to stop merging, and nothing about that failure looks like a bug:
 * it looks like the two engines disagreeing. One function cannot drift from
 * itself.
 *
 * The term/quad shapes below are structural, so both n3's terms (what the
 * shapes graph is parsed with) and Oxigraph's (what the report comes back as)
 * satisfy them without either runner converting.
 *
 * Falls back to the raw value for anything unrecognised, so an unexpected
 * structure degrades the output rather than throwing.
 */
export interface PathTerm {
  termType: string;
  value: string;
}

export interface PathQuad {
  predicate: { value: string };
  object: PathTerm;
}

const SH = 'http://www.w3.org/ns/shacl#';
const RDF_FIRST = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#first';
const RDF_REST = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#rest';
const RDF_NIL = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#nil';

/** `sh:<op>Path <inner>` -> the SPARQL 1.1 path-expression suffix meaning the same thing. */
const PATH_SUFFIXES: [string, string][] = [
  [`${SH}zeroOrMorePath`, '*'],
  [`${SH}oneOrMorePath`, '+'],
  [`${SH}zeroOrOnePath`, '?'],
];

export function renderPathExpression<Q extends PathQuad>(
  node: PathTerm,
  bySubject: Map<string, Q[]>,
  depth = 0,
): string {
  if (node.termType !== 'BlankNode' || depth > 10) return node.value;
  const quads = bySubject.get(node.value) ?? [];
  const objectOf = (pred: string): PathTerm | undefined => quads.find((q) => q.predicate.value === pred)?.object;

  for (const [operator, suffix] of PATH_SUFFIXES) {
    const inner = objectOf(operator);
    if (inner) return `(${renderPathExpression(inner, bySubject, depth + 1)})${suffix}`;
  }
  const inverse = objectOf(`${SH}inversePath`);
  if (inverse) return `^(${renderPathExpression(inverse, bySubject, depth + 1)})`;

  const alternative = objectOf(`${SH}alternativePath`);
  if (alternative) {
    return rdfList(alternative, bySubject, depth).map((m) => renderPathExpression(m, bySubject, depth + 1)).join('|');
  }

  // A sequence path is a bare RDF list.
  if (objectOf(RDF_FIRST)) {
    return rdfList(node, bySubject, depth).map((m) => renderPathExpression(m, bySubject, depth + 1)).join('/');
  }

  return node.value;
}

/** Walks an RDF list into its members, bounded so a malformed/cyclic list can't spin. */
function rdfList<Q extends PathQuad>(head: PathTerm, bySubject: Map<string, Q[]>, depth: number): PathTerm[] {
  const out: PathTerm[] = [];
  let cursor: PathTerm | undefined = head;
  for (let i = 0; cursor && cursor.value !== RDF_NIL && i < 100 && depth <= 10; i++) {
    const quads: Q[] = bySubject.get(cursor.value) ?? [];
    const first = quads.find((q) => q.predicate.value === RDF_FIRST)?.object;
    if (!first) break;
    out.push(first);
    cursor = quads.find((q) => q.predicate.value === RDF_REST)?.object;
  }
  return out;
}
