import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { classExprToRdf, parseClassExpression, rdfToClassExpr, renderClassExpression } from './classExpression';
import { parseRdf, serializeRdf } from '../serialization';
import type { Quad } from 'n3';

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
