import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseTurtle } from './parseDocument';
import { buildOntologyModel } from './ontologyModel';
import { buildHierarchyIndex } from './hierarchy';

const domainPath = path.resolve(__dirname, '../../examples/ontology/domain.ttl');
const doc = parseTurtle(domainPath, fs.readFileSync(domainPath, 'utf8'));
const model = buildOntologyModel(doc.quads);

const EX = 'http://example.org/demo#';

describe('buildHierarchyIndex against examples/ontology/domain.ttl (Mammal -> {Cat, Dog -> Puppy})', () => {
  it('finds Mammal as the sole class root', () => {
    const { roots } = buildHierarchyIndex(model, 'class');
    expect(roots.map((t) => t.iri)).toEqual([`${EX}Mammal`]);
  });

  it('nests Cat and Dog directly under Mammal, and Puppy under Dog', () => {
    const { childrenOf } = buildHierarchyIndex(model, 'class');
    const mammalChildren = (childrenOf.get(`${EX}Mammal`) ?? []).map((t) => t.iri).sort();
    expect(mammalChildren).toEqual([`${EX}Cat`, `${EX}Dog`].sort());

    const dogChildren = (childrenOf.get(`${EX}Dog`) ?? []).map((t) => t.iri);
    expect(dogChildren).toEqual([`${EX}Puppy`]);
  });

  it('nests hasPrimaryOwner under hasOwner via rdfs:subPropertyOf', () => {
    const { roots, childrenOf } = buildHierarchyIndex(model, 'objectProperty');
    expect(roots.map((t) => t.iri)).toEqual([`${EX}hasOwner`]);
    expect((childrenOf.get(`${EX}hasOwner`) ?? []).map((t) => t.iri)).toEqual([`${EX}hasPrimaryOwner`]);
  });

  it('datatype properties with no subPropertyOf are all roots with no children', () => {
    const { roots, childrenOf } = buildHierarchyIndex(model, 'datatypeProperty');
    expect(roots.map((t) => t.iri).sort()).toEqual([`${EX}hasBirthDate`, `${EX}hasName`].sort());
    expect(childrenOf.size).toBe(0);
  });
});
