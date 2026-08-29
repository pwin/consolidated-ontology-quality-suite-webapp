import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { classExprToRdf, parseClassExpression, rdfToClassExpr, renderClassExpression } from './classExpression';
import { parseRdf, serializeRdf } from '../serialization';
import { DataFactory, type Quad } from 'n3';

const prefixes = { ex: 'http://example.org/demo#' };

describe('Manchester class-expression grammar: parse -> render -> RDF -> read-back round trip', () => {
  const cases = [
    'ex:Dog',
    'ex:Dog and ex:OwnedDog',
    'ex:Dog or ex:Cat',
    'not ex:Dog',
    'ex:hasOwner some ex:Person',
    'ex:hasOwner only ex:Person',
    'ex:hasOwner value ex:alice',
    'ex:hasOwner Self',
    'ex:hasOwner min 1 ex:Person',
    'ex:hasOwner exactly 1 ex:Person',
    '(ex:Dog and ex:hasOwner some ex:Person) or ex:Cat',
    '{ex:alice, ex:bob}',
  ];

  it.each(cases)('round-trips: %s', (exprText) => {
    const expr = parseClassExpression(exprText);
    expect(expr).toBeDefined();
    const rendered = renderClassExpression(expr!, prefixes);

    const rdfQuads: Quad[] = [];
    const term = classExprToRdf(expr!, prefixes, rdfQuads);
    const bySubject = new Map<string, Quad[]>();
    for (const q of rdfQuads) {
      if (!bySubject.has(q.subject.value)) bySubject.set(q.subject.value, []);
      bySubject.get(q.subject.value)!.push(q);
    }

    const roundTripped = rdfToClassExpr(term as never, bySubject);
    expect(roundTripped).toBeDefined();
    expect(renderClassExpression(roundTripped!, prefixes)).toBe(rendered);
  });

  it('renders an already-CURIE-shaped (unexpanded) reference as-is, not wrapped in <>', () => {
    // Regression test: renderClassExpression must not mis-render "ex:Dog" as "<ex:Dog>"
    // when handed an AST whose `iri` field hasn't been resolved to a full IRI yet.
    const expr = parseClassExpression('ex:Dog')!;
    expect(renderClassExpression(expr, prefixes)).toBe('ex:Dog');
  });

  it('renders minimal parentheses (relies on and-before-or precedence, not explicit grouping)', () => {
    const expr = parseClassExpression('(ex:Dog and ex:hasOwner some ex:Person) or ex:Cat')!;
    expect(renderClassExpression(expr, prefixes)).toBe('ex:Dog and ex:hasOwner some ex:Person or ex:Cat');
  });
});

describe('a real ontology with OWL2 restrictions round-trips through Manchester with zero triple loss', () => {
  it('someValuesFrom / intersectionOf / qualifiedCardinality axioms all survive', async () => {
    const fixturePath = path.resolve(__dirname, '../../../examples/ontology/expressions-demo.ttl');
    const text = fs.readFileSync(fixturePath, 'utf8');
    const original = await parseRdf(text, 'turtle');
    expect(original.errors).toEqual([]);

    const manchesterText = await serializeRdf(original.quads, 'manchester', original.prefixes);
    const reparsed = await parseRdf(manchesterText, 'manchester');
    expect(reparsed.errors).toEqual([]);
    expect(reparsed.quads).toHaveLength(original.quads.length);
  });
});

/**
 * A class expression that walks back into itself is malformed OWL and perfectly
 * well-formed RDF -- two triples are enough. Before `rdfToClassExpr` tracked the
 * path down to a node it recurred forever on one, and a `RangeError: Maximum call
 * stack size exceeded` came out of whatever asked to render Manchester. Same class
 * of bug as the `computeMaxDepth` fix in 0.11.4: a graph walk guarding neither
 * cycles nor descent.
 */
describe('a cyclic or unbounded class expression fails as undefined rather than a stack overflow', () => {
  const { namedNode, blankNode, quad } = DataFactory;
  const OWL = 'http://www.w3.org/2002/07/owl#';
  const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';

  const index = (quads: Quad[]) => {
    const bySubject = new Map<string, Quad[]>();
    for (const q of quads) {
      const existing = bySubject.get(q.subject.value);
      if (existing) existing.push(q);
      else bySubject.set(q.subject.value, [q]);
    }
    return bySubject;
  };

  it('stops on a node that is its own complement', () => {
    const node = blankNode('cyc');
    const quads = [quad(node, namedNode(`${OWL}complementOf`), node)];
    expect(rdfToClassExpr(node, index(quads))).toBeUndefined();
  });

  it('stops on a cycle that runs through an intersection list', () => {
    const node = blankNode('x');
    const list = blankNode('l');
    const quads = [
      quad(node, namedNode(`${OWL}intersectionOf`), list),
      quad(list, namedNode(`${RDF}first`), node),
      quad(list, namedNode(`${RDF}rest`), namedNode(`${RDF}nil`)),
    ];
    // The list walk has always been cycle-guarded; the cycle here is between
    // levels of the expression, which is what that guard cannot see.
    expect(rdfToClassExpr(node, index(quads))).toEqual({ kind: 'and', operands: [] });
  });

  it('reads a legitimately deep expression, and gives up rather than overflowing beyond that', () => {
    const chain = (depth: number) => {
      const nodes = Array.from({ length: depth }, (_, i) => blankNode(`n${i}`));
      const quads = nodes.slice(0, -1).map((n, i) => quad(n, namedNode(`${OWL}complementOf`), nodes[i + 1]));
      quads.push(quad(nodes[depth - 1], namedNode(`${OWL}complementOf`), namedNode('http://example.org/Thing')));
      return { head: nodes[0], bySubject: index(quads) };
    };

    const shallow = chain(100);
    expect(rdfToClassExpr(shallow.head, shallow.bySubject)).toBeDefined();

    // 20,000 was a RangeError before the depth cap. Deeper than any ontology, so
    // the only thing that matters is that it is a return rather than a crash.
    const deep = chain(20000);
    expect(rdfToClassExpr(deep.head, deep.bySubject)).toBeUndefined();
  });

  it('does not mistake a node reached twice down different branches for a cycle', () => {
    const shared = blankNode('shared');
    const root = blankNode('root');
    const list = blankNode('l1');
    const list2 = blankNode('l2');
    const quads = [
      quad(root, namedNode(`${OWL}intersectionOf`), list),
      quad(list, namedNode(`${RDF}first`), shared),
      quad(list, namedNode(`${RDF}rest`), list2),
      quad(list2, namedNode(`${RDF}first`), shared),
      quad(list2, namedNode(`${RDF}rest`), namedNode(`${RDF}nil`)),
      quad(shared, namedNode(`${OWL}complementOf`), namedNode('http://example.org/Thing')),
    ];
    // Path-scoped, not a single visited set for the whole walk: both operands read.
    const expr = rdfToClassExpr(root, index(quads));
    expect(expr).toEqual({ kind: 'and', operands: [
      { kind: 'not', operand: { kind: 'class', iri: 'http://example.org/Thing' } },
      { kind: 'not', operand: { kind: 'class', iri: 'http://example.org/Thing' } },
    ] });
  });
});
