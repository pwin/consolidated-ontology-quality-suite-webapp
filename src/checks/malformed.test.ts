import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Quad } from 'n3';
import { runMalformedChecks, withoutRelativeIris } from './malformed';
import { parseRdf } from '../rdf/serialization';
import { storeWithQuads } from '../rdf/holosStore';

const PREFIXES = [
  '@prefix ex: <http://example.org/zoo#> .',
  '@prefix owl: <http://www.w3.org/2002/07/owl#> .',
  '@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .',
  '@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .',
  '',
].join('\n');
const EX = 'http://example.org/zoo#';

async function quadsOf(turtle: string): Promise<Quad[]> {
  const parsed = await parseRdf(PREFIXES + turtle, 'turtle');
  expect(parsed.errors).toEqual([]);
  return parsed.quads as Quad[];
}

const found = (quads: Quad[]) => runMalformedChecks(quads).map((r) => [r.checkId, r.focusNode.replace(EX, 'ex:'), r.value?.replace(new RegExp(EX, 'g'), 'ex:')]);

describe('MAL-001: a qualified cardinality written as unqualified', () => {
  it('is reported at the class that uses it, as `exactly 2 ex:Animal` was written before 0.13.14', async () => {
    const quads = await quadsOf('ex:BreedingPair rdfs:subClassOf [ a owl:Restriction ; owl:onProperty ex:hasMember ; owl:cardinality "2"^^xsd:nonNegativeInteger ; owl:onClass ex:Animal ] .');
    expect(found(quads)).toEqual([['MAL-001', 'ex:BreedingPair', 'ex:hasMember']]);
    const [row] = runMalformedChecks(quads);
    expect(row.message).toContain('pairs owl:cardinality with owl:onClass');
    expect(row.remediation).toContain('owl:qualifiedCardinality');
  });

  it('is not reported for a correct qualified or unqualified cardinality', async () => {
    const quads = await quadsOf(
      [
        'ex:A rdfs:subClassOf [ a owl:Restriction ; owl:onProperty ex:p ; owl:qualifiedCardinality "2"^^xsd:nonNegativeInteger ; owl:onClass ex:B ] .',
        'ex:C rdfs:subClassOf [ a owl:Restriction ; owl:onProperty ex:p ; owl:maxCardinality "1"^^xsd:nonNegativeInteger ] .',
      ].join('\n'),
    );
    expect(found(quads)).toEqual([]);
  });
});

describe('MAL-002: a restriction on more than one property', () => {
  it('is reported for the merge two Appends left before 0.13.14', async () => {
    // What a second Append wrote: its restriction reused the first one's label, _:n3-0.
    const quads = await quadsOf(
      [
        '_:n3-0 a owl:Restriction ; owl:onProperty ex:livesIn ; owl:someValuesFrom ex:Aquarium .',
        'ex:Fish rdfs:subClassOf _:n3-0 .',
        '_:n3-0 a owl:Restriction ; owl:onProperty ex:isPartOf ; owl:someValuesFrom ex:Enclosure .',
        'ex:WaterTank rdfs:subClassOf _:n3-0 .',
      ].join('\n'),
    );
    expect(found(quads)).toEqual([['MAL-002', 'ex:Fish', 'ex:livesIn, ex:isPartOf']]);
  });
});

describe('MAL-003: an IRI with no scheme', () => {
  it('is reported once per relative IRI, at the class whose restriction uses it, as Add Subclass wrote before 0.14.0', async () => {
    const quads = await quadsOf('ex:Parent a owl:Class ; rdfs:subClassOf [ a owl:Restriction ; owl:onProperty <hasChild> ; owl:someValuesFrom <Person> ] .');
    expect(found(quads)).toEqual([
      ['MAL-003', 'ex:Parent', 'hasChild'],
      ['MAL-003', 'ex:Parent', 'Person'],
    ]);
    expect(runMalformedChecks(quads)[0].message).toBe(
      '<hasChild> is a relative IRI: it has no scheme, so no OWL tool reads it as the term it was meant to name. Local Checks leaves out the 1 statement that uses it.',
    );
  });

  it('is its own focus when it is a subject, which puts the finding on its line', async () => {
    expect(found(await quadsOf('<Foo> a owl:Class ; rdfs:subClassOf ex:Animal .'))).toEqual([['MAL-003', 'Foo', 'Foo']]);
  });

  it("is left out of what the engines get: holosdb refuses the whole graph with one in it, and loads the rest", async () => {
    const quads = await quadsOf('ex:Parent a owl:Class ; rdfs:subClassOf [ a owl:Restriction ; owl:onProperty <hasChild> ; owl:someValuesFrom ex:Person ] .');
    expect(() => storeWithQuads(quads)).toThrow(/No scheme found/);
    const kept = withoutRelativeIris(quads);
    expect(kept).toHaveLength(quads.length - 1);
    expect(storeWithQuads(kept).size).toBe(kept.length);
  });
});

describe('the repository’s own ontologies', () => {
  const examples = path.resolve(__dirname, '../../examples');
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ttl')) files.push(full);
    }
  };
  walk(examples);

  it.each(files.map((f) => path.relative(examples, f)))('%s has none of the three defects', async (file) => {
    const parsed = await parseRdf(fs.readFileSync(path.join(examples, file), 'utf8'), 'turtle');
    expect(runMalformedChecks(parsed.quads as Quad[])).toEqual([]);
  });
});
