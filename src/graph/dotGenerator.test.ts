import { describe, expect, it } from 'vitest';
import { Parser } from 'n3';
import { generateDot, quadKey } from './dotGenerator';

const quads = new Parser().parse(`
  @prefix ex: <http://example.org/> .
  @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
  ex:Rex a ex:Dog ;
    rdfs:label "Rex" ;
    ex:hasOwner ex:Alice .
`);
const prefixes = { ex: 'http://example.org/', rdfs: 'http://www.w3.org/2000/01/rdf-schema#' };

describe('generateDot', () => {
  it('produces a digraph with nodes for the subject and its object references', () => {
    const dot = generateDot(quads, ['http://example.org/Rex'], prefixes, { hideTypes: false, hideAnnotations: false, showPrefixes: true, maxDepth: 3 });
    expect(dot).toContain('digraph G');
    expect(dot).toContain('ex:Rex');
    expect(dot).toContain('ex:Alice');
    expect(dot).toContain('ex:hasOwner');
  });

  it('hideTypes omits rdf:type edges', () => {
    const withTypes = generateDot(quads, ['http://example.org/Rex'], prefixes, { hideTypes: false, hideAnnotations: false, showPrefixes: true, maxDepth: 3 });
    const withoutTypes = generateDot(quads, ['http://example.org/Rex'], prefixes, { hideTypes: true, hideAnnotations: false, showPrefixes: true, maxDepth: 3 });
    expect(withTypes).toContain('ex:Dog');
    expect(withoutTypes).not.toContain('ex:Dog');
  });

  it('hideAnnotations omits the rdfs:label literal node/edge (the ex:Rex subject node itself still appears)', () => {
    const withAnnotations = generateDot(quads, ['http://example.org/Rex'], prefixes, { hideTypes: false, hideAnnotations: false, showPrefixes: true, maxDepth: 3 });
    const withoutAnnotations = generateDot(quads, ['http://example.org/Rex'], prefixes, { hideTypes: false, hideAnnotations: true, showPrefixes: true, maxDepth: 3 });
    expect(withAnnotations).toContain('label="Rex"');
    expect(withoutAnnotations).not.toContain('label="Rex"');
    expect(withoutAnnotations).toContain('ex:Rex'); // the subject node itself is unaffected
  });

  it('returns an empty-ish graph for a subject not present in the quads', () => {
    const dot = generateDot(quads, ['http://example.org/DoesNotExist'], prefixes, { hideTypes: false, hideAnnotations: false, showPrefixes: true, maxDepth: 3 });
    expect(dot).toContain('digraph G');
    expect(dot).not.toContain('ex:Rex');
  });

  it('defaults to rankdir=LR and honors an explicit rankdir option', () => {
    const withDefault = generateDot(quads, ['http://example.org/Rex'], prefixes, {});
    expect(withDefault).toContain('rankdir=LR;');
    const withBT = generateDot(quads, ['http://example.org/Rex'], prefixes, { rankdir: 'BT' });
    expect(withBT).toContain('rankdir=BT;');
    expect(withBT).not.toContain('rankdir=LR;');
  });

  it('hideIsDefinedBy omits rdfs:isDefinedBy edges without affecting other annotation edges', () => {
    const withIsDefinedBy = new Parser().parse(`
      @prefix ex: <http://example.org/> .
      @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
      ex:Rex a ex:Dog ;
        rdfs:label "Rex" ;
        rdfs:isDefinedBy ex:SomeOntology .
    `);
    const shown = generateDot(withIsDefinedBy, ['http://example.org/Rex'], prefixes, { hideIsDefinedBy: false });
    const hidden = generateDot(withIsDefinedBy, ['http://example.org/Rex'], prefixes, { hideIsDefinedBy: true });
    expect(shown).toContain('ex:SomeOntology');
    expect(hidden).not.toContain('ex:SomeOntology');
    expect(hidden).toContain('label="Rex"'); // rdfs:label is unaffected -- a separate toggle
  });

  it('hideImportedDownstream keeps an imported term as a leaf but does not expand its own quads', () => {
    // ex:Rex is local; ex:Dog and its own further structure come from an "imported" file.
    const mixedQuads = new Parser().parse(`
      @prefix ex: <http://example.org/> .
      @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
      ex:Rex a ex:Dog .
      ex:Dog rdfs:label "Dog" ;
        rdfs:subClassOf ex:Animal .
    `);
    const localSubjects = new Set(['http://example.org/Rex']);

    const expanded = generateDot(mixedQuads, ['http://example.org/Rex'], prefixes, { hideImportedDownstream: false }, localSubjects);
    expect(expanded).toContain('ex:Dog'); // reached via rdf:type
    expect(expanded).toContain('ex:Animal'); // expanded from ex:Dog's own rdfs:subClassOf

    const restricted = generateDot(mixedQuads, ['http://example.org/Rex'], prefixes, { hideImportedDownstream: true }, localSubjects);
    expect(restricted).toContain('ex:Dog'); // still shown as a leaf -- Rex still asserts "a ex:Dog"
    expect(restricted).not.toContain('ex:Animal'); // but ex:Dog's own downstream is not pulled in
    expect(restricted).not.toContain('label="Dog"'); // ex:Dog's own rdfs:label is also not pulled in
  });

  it('hideImportedDownstream still expands a selected root subject even if it is not local', () => {
    const mixedQuads = new Parser().parse(`
      @prefix ex: <http://example.org/> .
      @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
      ex:Dog rdfs:subClassOf ex:Animal .
    `);
    const localSubjects = new Set<string>(); // ex:Dog is NOT local, but it's the selected root
    const dot = generateDot(mixedQuads, ['http://example.org/Dog'], prefixes, { hideImportedDownstream: true }, localSubjects);
    expect(dot).toContain('ex:Animal');
  });

  it('styles an inferred edge (present in inferredKeys) as dashed purple, leaving asserted edges the default style', () => {
    const inferredEdgeQuad = quads.find((q) => q.predicate.value === 'http://example.org/hasOwner')!;
    const inferredKeys = new Set([quadKey(inferredEdgeQuad)]);
    const dot = generateDot(quads, ['http://example.org/Rex'], prefixes, {}, undefined, inferredKeys);
    expect(dot).toContain('style=dashed');
    expect(dot).toContain('color="purple"');
    // Only the one edge in inferredKeys (hasOwner) should be styled -- the rdf:type edge (not in
    // inferredKeys) must render as a plain, undecorated edge line.
    const purpleLines = dot.split('\n').filter((l) => l.includes('purple'));
    expect(purpleLines).toHaveLength(1);
    expect(purpleLines[0]).toContain('hasOwner');
  });

  it('quadKey distinguishes a literal object from a same-string resource object', () => {
    const literalQuad = new Parser().parse('<http://ex/s> <http://ex/p> "http://ex/o" .')[0];
    const resourceQuad = new Parser().parse('<http://ex/s> <http://ex/p> <http://ex/o> .')[0];
    expect(quadKey(literalQuad)).not.toBe(quadKey(resourceQuad));
  });
});
