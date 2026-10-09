import { describe, expect, it } from 'vitest';
import { DataFactory, type Quad } from 'n3';
import { blankNodesApartFrom } from './blankNodeLabels';
import { parseRdf, serializeRdf } from './serialization';

const { namedNode, blankNode, quad } = DataFactory;
const ex = (local: string) => namedNode(`http://example.org/zoo#${local}`);
const owl = (local: string) => namedNode(`http://www.w3.org/2002/07/owl#${local}`);
const prefixes = { ex: 'http://example.org/zoo#', owl: 'http://www.w3.org/2002/07/owl#', rdfs: 'http://www.w3.org/2000/01/rdf-schema#' };

/** `cls subClassOf (property some filler)`, its restriction labelled `n3-0` as a fresh process labels it. */
function someRestriction(cls: string, property: string, filler: string): Quad[] {
  const r = blankNode('n3-0');
  return [
    quad(r, namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#type'), owl('Restriction')),
    quad(r, owl('onProperty'), ex(property)),
    quad(r, owl('someValuesFrom'), ex(filler)),
    quad(ex(cls), namedNode('http://www.w3.org/2000/01/rdf-schema#subClassOf'), r),
  ];
}

/** What Run Ontology Script's Append adds: the Turtle without its prefix lines. */
async function appended(quads: Quad[]): Promise<string> {
  const turtle = await serializeRdf(quads, 'turtle', prefixes);
  return turtle.split('\n').filter((line) => !line.startsWith('@prefix')).join('\n');
}

describe('blankNodesApartFrom', () => {
  it('keeps a second run’s restriction apart from the first’s, where both were labelled n3-0', async () => {
    let file = await serializeRdf(someRestriction('Fish', 'livesIn', 'Aquarium'), 'turtle', prefixes);
    const second = someRestriction('WaterTank', 'isPartOf', 'Enclosure');

    const merged = (await parseRdf(file + (await appended(second)), 'turtle')).quads;
    expect(merged.filter((q) => q.predicate.equals(owl('onProperty')))).toHaveLength(2);
    expect(new Set(merged.filter((q) => q.predicate.equals(owl('onProperty'))).map((q) => q.subject.value)).size).toBe(1);

    file += await appended(blankNodesApartFrom(second, file));
    const kept = (await parseRdf(file, 'turtle')).quads;
    const onProperty = kept.filter((q) => q.predicate.equals(owl('onProperty')));
    expect(new Set(onProperty.map((q) => q.subject.value)).size).toBe(2);
  });

  it('gives one label to every use of the same blank node', () => {
    const [type, onProperty, someValuesFrom, subClassOf] = blankNodesApartFrom(someRestriction('Fish', 'livesIn', 'Aquarium'), '');
    expect(type.subject.value).toBe('b0');
    expect([onProperty.subject.value, someValuesFrom.subject.value, subClassOf.object.value]).toEqual(['b0', 'b0', 'b0']);
  });

  it('skips every label already in the text, wherever it appears', () => {
    const text = 'ex:A rdfs:subClassOf _:b0.\n_:b1 a owl:Restriction.\n# _:b2 in a comment\nex:B ex:p (_:b3).';
    const quads = [...someRestriction('Fish', 'livesIn', 'Aquarium'), quad(ex('Other'), ex('p'), blankNode('n3-1'))];
    const labels = new Set(blankNodesApartFrom(quads, text).flatMap((q) => [q.subject, q.object]).filter((t) => t.termType === 'BlankNode').map((t) => t.value));
    expect([...labels]).toEqual(['b4', 'b5']);
  });

  it('returns quads without blank nodes as they were', () => {
    const plain = quad(ex('Fish'), namedNode('http://www.w3.org/2000/01/rdf-schema#subClassOf'), ex('Animal'));
    expect(blankNodesApartFrom([plain], '_:b0')[0]).toBe(plain);
  });
});
