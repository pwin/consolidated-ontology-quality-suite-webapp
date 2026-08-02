import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { detectFormat, detectFormatFromContent, FORMATS, parseRdf, RdfFormat, serializeRdf } from './serialization';

const domainPath = path.resolve(__dirname, '../../examples/ontology/domain.ttl');
const domainText = fs.readFileSync(domainPath, 'utf8');

describe('detectFormat', () => {
  it('resolves unambiguous extensions directly', () => {
    expect(detectFormat('foo.ttl')).toBe('turtle');
    expect(detectFormat('foo.trig')).toBe('trig');
    expect(detectFormat('foo.nt')).toBe('ntriples');
    expect(detectFormat('foo.nq')).toBe('nquads');
    expect(detectFormat('foo.rdf')).toBe('rdfxml');
    expect(detectFormat('foo.omn')).toBe('manchester');
  });

  it('content-sniffs the ambiguous .owl extension', () => {
    expect(detectFormat('foo.owl', '@prefix ex: <http://example.org/> .\nex:a ex:b ex:c .')).toBe('turtle');
    expect(detectFormat('foo.owl', '<?xml version="1.0"?>\n<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"></rdf:RDF>')).toBe('rdfxml');
  });
});

describe('detectFormatFromContent', () => {
  it('recognizes a genuine TriG named-graph block (prefix:localName { )', () => {
    expect(detectFormatFromContent('@prefix ex: <http://example.org/> .\nex:g {\n  ex:a ex:b ex:c .\n}\n')).toBe('trig');
  });

  it('does not misdetect plain Turtle as TriG', () => {
    expect(detectFormatFromContent(domainText)).toBe('turtle');
  });

  it('recognizes RDF/XML and Manchester Syntax headers', () => {
    expect(detectFormatFromContent('<?xml version="1.0"?>\n<rdf:RDF xmlns:rdf="...">')).toBe('rdfxml');
    expect(detectFormatFromContent('Prefix: ex: <http://example.org/>\n\nClass: ex:Foo\n')).toBe('manchester');
  });
});

describe('round-tripping domain.ttl through every format', () => {
  const original = parseRdf(domainText, 'turtle');

  it.each(Object.keys(FORMATS) as RdfFormat[])('%s round-trips with zero parse errors', async (format) => {
    const { quads: originalQuads, prefixes } = await original;
    const serialized = await serializeRdf(originalQuads, format, prefixes);
    const reparsed = await parseRdf(serialized, format);
    expect(reparsed.errors).toEqual([]);
    expect(reparsed.quads.length).toBeGreaterThan(0);
  });

  it('turtle/trig/ntriples/nquads preserve every triple losslessly', async () => {
    const { quads: originalQuads, prefixes } = await original;
    for (const format of ['turtle', 'trig', 'ntriples', 'nquads'] as const) {
      const serialized = await serializeRdf(originalQuads, format, prefixes);
      const reparsed = await parseRdf(serialized, format);
      expect(reparsed.quads).toHaveLength(originalQuads.length);
    }
  });

  it('manchester drops the ontology-header annotations (documented losslessGraph: false) but keeps class/property axioms', async () => {
    const { quads: originalQuads, prefixes } = await original;
    expect(FORMATS.manchester.losslessGraph).toBe(false);
    const serialized = await serializeRdf(originalQuads, 'manchester', prefixes);
    const reparsed = await parseRdf(serialized, 'manchester');
    expect(reparsed.quads.length).toBeLessThan(originalQuads.length);
    expect(reparsed.quads.length).toBeGreaterThan(0);
  });
});

describe('real named-graph TriG fixture (examples/ontology/domain.trig)', () => {
  it('parses into two distinct named graphs, not the default graph', async () => {
    const trigPath = path.resolve(__dirname, '../../examples/ontology/domain.trig');
    const trigText = fs.readFileSync(trigPath, 'utf8');
    expect(detectFormatFromContent(trigText)).toBe('trig');
    const { quads, errors } = await parseRdf(trigText, 'trig');
    expect(errors).toEqual([]);
    const graphs = new Set(quads.map((q) => q.graph.value));
    expect(graphs).toEqual(new Set(['http://example.org/demo#schemaGraph', 'http://example.org/demo#instanceGraph']));
  });
});
