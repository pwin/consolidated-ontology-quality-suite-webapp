import { BlankNode, DataFactory, NamedNode, Quad, Term } from 'n3';
import { expand, shrink, OWL, RDF, XSD } from '../vocab';
import type { ClassExpr } from './classExpressionParser';

// The grammar, its AST and the parsers live in classExpressionParser.ts, which has no imports;
// re-exported here for every existing caller.
export type { ClassExpr } from './classExpressionParser';
export { ClassExpressionSyntaxError, mapClassExprNames, parseClassExpression, parseClassExpressionStrict, tokenizeExpression } from './classExpressionParser';

const { namedNode, blankNode, literal, quad } = DataFactory;

// ---------------------------------------------------------------------------
// AST <-> RDF (OWL2 blank-node encoding)
// ---------------------------------------------------------------------------

export function classExprToRdf(expr: ClassExpr, prefixes: Record<string, string>, out: Quad[]): NamedNode | BlankNode {
  const resolve = (ref: string): string => (ref.startsWith('http://') || ref.startsWith('https://') ? ref : expand(ref, prefixes) ?? ref);

  switch (expr.kind) {
    case 'class':
      return namedNode(resolve(expr.iri));
    case 'and':
    case 'or': {
      const bnode = blankNode();
      const listHead = rdfList(
        expr.operands.map((o) => classExprToRdf(o, prefixes, out)),
        out,
      );
      out.push(quad(bnode, namedNode(`${RDF}type`), namedNode(`${OWL}Class`)));
      out.push(quad(bnode, namedNode(expr.kind === 'and' ? `${OWL}intersectionOf` : `${OWL}unionOf`), listHead));
      return bnode;
    }
    case 'not': {
      const bnode = blankNode();
      out.push(quad(bnode, namedNode(`${RDF}type`), namedNode(`${OWL}Class`)));
      out.push(quad(bnode, namedNode(`${OWL}complementOf`), classExprToRdf(expr.operand, prefixes, out)));
      return bnode;
    }
    case 'oneOf': {
      const bnode = blankNode();
      const listHead = rdfList(
        expr.individuals.map((i) => namedNode(resolve(i))),
        out,
      );
      out.push(quad(bnode, namedNode(`${RDF}type`), namedNode(`${OWL}Class`)));
      out.push(quad(bnode, namedNode(`${OWL}oneOf`), listHead));
      return bnode;
    }
    case 'restriction': {
      const bnode = blankNode();
      out.push(quad(bnode, namedNode(`${RDF}type`), namedNode(`${OWL}Restriction`)));
      out.push(quad(bnode, namedNode(`${OWL}onProperty`), namedNode(resolve(expr.property))));
      switch (expr.type) {
        case 'some':
          out.push(quad(bnode, namedNode(`${OWL}someValuesFrom`), classExprToRdf(expr.filler!, prefixes, out)));
          break;
        case 'only':
          out.push(quad(bnode, namedNode(`${OWL}allValuesFrom`), classExprToRdf(expr.filler!, prefixes, out)));
          break;
        case 'self':
          out.push(quad(bnode, namedNode(`${OWL}hasSelf`), literal('true', namedNode(`${XSD}boolean`))));
          break;
        case 'value':
          if (expr.individual) out.push(quad(bnode, namedNode(`${OWL}hasValue`), namedNode(resolve(expr.individual))));
          else if (expr.literalValue) {
            const lv = expr.literalValue;
            out.push(
              quad(
                bnode,
                namedNode(`${OWL}hasValue`),
                lv.language ? literal(lv.value, lv.language) : literal(lv.value, namedNode(lv.datatype ? resolve(lv.datatype) : `${XSD}string`)),
              ),
            );
          }
          break;
        case 'min':
        case 'max':
        case 'exactly': {
          const card = String(expr.cardinality ?? 0);
          const qualified = Boolean(expr.filler);
          // Spelled out, not derived: deriving them by replacing 'Cardinality' missed the exact
          // case, whose base name is lower-case, and wrote owl:cardinality + owl:onClass.
          const pred = {
            min: qualified ? 'minQualifiedCardinality' : 'minCardinality',
            max: qualified ? 'maxQualifiedCardinality' : 'maxCardinality',
            exactly: qualified ? 'qualifiedCardinality' : 'cardinality',
          }[expr.type];
          out.push(quad(bnode, namedNode(`${OWL}${pred}`), literal(card, namedNode(`${XSD}nonNegativeInteger`))));
          if (qualified) out.push(quad(bnode, namedNode(`${OWL}onClass`), classExprToRdf(expr.filler!, prefixes, out)));
          break;
        }
      }
      return bnode;
    }
  }
}

/** An RDF list of `items`, its triples pushed to `out`; returns its head (rdf:nil when empty). */
export function rdfList(items: (NamedNode | BlankNode)[], out: Quad[]): NamedNode | BlankNode {
  if (items.length === 0) return namedNode(`${RDF}nil`);
  let tail: NamedNode | BlankNode = namedNode(`${RDF}nil`);
  const nodes = items.map(() => blankNode());
  for (let i = items.length - 1; i >= 0; i--) {
    out.push(quad(nodes[i], namedNode(`${RDF}first`), items[i]));
    out.push(quad(nodes[i], namedNode(`${RDF}rest`), tail));
    tail = nodes[i];
  }
  return tail;
}

/**
 * How deep a blank-node class expression may nest before this gives up.
 *
 * Well past anything an ontology contains -- gist's deepest is single figures --
 * and the point is only to fail as `undefined` rather than as a stack overflow.
 */
const MAX_CLASS_EXPRESSION_DEPTH = 200;

/** Reads an OWL2 blank-node class expression back out of a quad set (the inverse of classExprToRdf). */
export function rdfToClassExpr(term: Term, bySubject: Map<string, Quad[]>): ClassExpr | undefined {
  return readClassExpr(term, bySubject, new Set(), 0);
}

/**
 * `ancestors` holds the blank nodes on the path down to `term`, so a node that is
 * its own ancestor stops here instead of recurring forever.
 *
 * A cyclic class expression is malformed OWL but perfectly well-formed RDF, and it
 * takes two triples: `_:b owl:complementOf _:b`. Before this guard that was a hard
 * `RangeError: Maximum call stack size exceeded` out of the Manchester serializer,
 * so one corrupt file took down whatever asked to render it. Legitimate depth blew
 * the stack too, between 2,000 and 20,000 levels. Same class of bug as the
 * `computeMaxDepth` fix in 0.11.4 and the six walks
 * `consolidated_ontology_suite_python` rewrote onto the heap in its 0.7.0: a graph
 * walk that guards neither cycles nor descent.
 *
 * Path-scoped rather than a single visited set for the whole walk: one blank node
 * legitimately reached down two different branches should render in both, and only
 * a node reached from itself is a cycle.
 */
function readClassExpr(term: Term, bySubject: Map<string, Quad[]>, ancestors: Set<string>, depth: number): ClassExpr | undefined {
  if (term.termType === 'NamedNode') return { kind: 'class', iri: term.value };
  if (term.termType !== 'BlankNode') return undefined;
  if (depth > MAX_CLASS_EXPRESSION_DEPTH || ancestors.has(term.value)) return undefined;

  ancestors.add(term.value);
  try {
    return readClassExprBody(term, bySubject, ancestors, depth);
  } finally {
    ancestors.delete(term.value);
  }
}

function readClassExprBody(term: Term, bySubject: Map<string, Quad[]>, ancestors: Set<string>, depth: number): ClassExpr | undefined {
  const own = bySubject.get(term.value) ?? [];
  const get = (pred: string) => own.find((q) => q.predicate.value === pred)?.object;

  const intersectionOf = get(`${OWL}intersectionOf`);
  if (intersectionOf) return { kind: 'and', operands: readRdfList(intersectionOf, bySubject).map((t) => readClassExpr(t, bySubject, ancestors, depth + 1)!).filter(Boolean) };
  const unionOf = get(`${OWL}unionOf`);
  if (unionOf) return { kind: 'or', operands: readRdfList(unionOf, bySubject).map((t) => readClassExpr(t, bySubject, ancestors, depth + 1)!).filter(Boolean) };
  const complementOf = get(`${OWL}complementOf`);
  if (complementOf) {
    const operand = readClassExpr(complementOf, bySubject, ancestors, depth + 1);
    return operand ? { kind: 'not', operand } : undefined;
  }
  const oneOf = get(`${OWL}oneOf`);
  if (oneOf) return { kind: 'oneOf', individuals: readRdfList(oneOf, bySubject).map((t) => t.value) };

  const onProperty = get(`${OWL}onProperty`);
  if (onProperty) {
    const property = onProperty.value;
    const someValuesFrom = get(`${OWL}someValuesFrom`);
    if (someValuesFrom) return { kind: 'restriction', property, type: 'some', filler: readClassExpr(someValuesFrom, bySubject, ancestors, depth + 1) };
    const allValuesFrom = get(`${OWL}allValuesFrom`);
    if (allValuesFrom) return { kind: 'restriction', property, type: 'only', filler: readClassExpr(allValuesFrom, bySubject, ancestors, depth + 1) };
    const hasValue = get(`${OWL}hasValue`);
    if (hasValue) {
      if (hasValue.termType === 'NamedNode') return { kind: 'restriction', property, type: 'value', individual: hasValue.value };
      const lit = hasValue as import('n3').Literal;
      return { kind: 'restriction', property, type: 'value', literalValue: { value: lit.value, datatype: lit.datatype?.value, language: lit.language || undefined } };
    }
    const hasSelf = get(`${OWL}hasSelf`);
    if (hasSelf) return { kind: 'restriction', property, type: 'self' };
    for (const [predSuffix, kind] of [
      ['minQualifiedCardinality', 'min'],
      ['maxQualifiedCardinality', 'max'],
      ['qualifiedCardinality', 'exactly'],
      ['minCardinality', 'min'],
      ['maxCardinality', 'max'],
      ['cardinality', 'exactly'],
    ] as const) {
      const card = get(`${OWL}${predSuffix}`);
      if (card) {
        const onClass = get(`${OWL}onClass`) ?? get(`${OWL}onDataRange`);
        return {
          kind: 'restriction',
          property,
          type: kind,
          cardinality: Number(card.value),
          filler: onClass ? readClassExpr(onClass, bySubject, ancestors, depth + 1) : undefined,
        };
      }
    }
  }
  return undefined;
}

function readRdfList(head: Term, bySubject: Map<string, Quad[]>): Term[] {
  const items: Term[] = [];
  let current = head;
  const seen = new Set<string>();
  while (current.termType === 'BlankNode' && !seen.has(current.value)) {
    seen.add(current.value);
    const quads = bySubject.get(current.value) ?? [];
    const first = quads.find((q) => q.predicate.value === `${RDF}first`)?.object;
    const rest = quads.find((q) => q.predicate.value === `${RDF}rest`)?.object;
    if (first) items.push(first);
    if (!rest) break;
    current = rest;
  }
  return items;
}

/** Renders a ClassExpr back to Manchester text, parenthesizing only where precedence requires it. */
export function renderClassExpression(expr: ClassExpr, prefixes: Record<string, string>): string {
  return render(expr, 0);

  function ref(iri: string): string {
    // Defensive against being handed an already-CURIE-shaped (unexpanded) string
    // -- e.g. a live-preview render of a freshly-parsed, not-yet-resolved AST --
    // rather than always assuming `iri` is a full IRI and wrapping non-matches
    // in `<>` (which would otherwise mis-render "ex:Dog" as "<ex:Dog>").
    if (!iri.includes('://')) return iri;
    const curie = shrink(iri, prefixes);
    return curie === iri ? `<${iri}>` : curie;
  }

  function render(e: ClassExpr, parentPrecedence: number): string {
    switch (e.kind) {
      case 'class':
        return ref(e.iri);
      case 'oneOf':
        return `{${e.individuals.map(ref).join(', ')}}`;
      case 'not':
        return wrap(`not ${render(e.operand, 2)}`, 2, parentPrecedence);
      case 'and':
        return wrap(e.operands.map((o) => render(o, 1)).join(' and '), 1, parentPrecedence);
      case 'or':
        return wrap(e.operands.map((o) => render(o, 0)).join(' or '), 0, parentPrecedence);
      case 'restriction':
        return wrap(renderRestriction(e), 2, parentPrecedence);
    }
  }

  function renderRestriction(e: Extract<ClassExpr, { kind: 'restriction' }>): string {
    const p = ref(e.property);
    switch (e.type) {
      case 'self':
        return `${p} Self`;
      case 'value':
        if (e.individual) return `${p} value ${ref(e.individual)}`;
        if (e.literalValue) {
          const lv = e.literalValue;
          const suffix = lv.language ? `@${lv.language}` : lv.datatype ? `^^${ref(lv.datatype)}` : '';
          return `${p} value "${lv.value}"${suffix}`;
        }
        return `${p} value ?`;
      case 'some':
        return `${p} some ${render(e.filler!, 2)}`;
      case 'only':
        return `${p} only ${render(e.filler!, 2)}`;
      case 'min':
      case 'max':
      case 'exactly':
        return `${p} ${e.type} ${e.cardinality}${e.filler ? ` ${render(e.filler, 2)}` : ''}`;
    }
  }

  function wrap(s: string, precedence: number, parentPrecedence: number): string {
    return precedence < parentPrecedence ? `(${s})` : s;
  }
}
