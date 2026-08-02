import { describe, expect, it } from 'vitest';
import { Parser } from 'n3';
import { generateDot } from './dotGenerator';

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
});
