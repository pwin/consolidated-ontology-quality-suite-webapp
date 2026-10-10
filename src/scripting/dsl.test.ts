import { describe, expect, it, beforeEach, vi } from 'vitest';
import type { Literal, Quad } from 'n3';
import { ontology, defontology, defclass, defobjectproperty, defdatatypeproperty, some, only, and, or, not, minCardinality, hasValue, mx, someOnly, asSubclasses, build } from './dsl';

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const OWL_CLASS = 'http://www.w3.org/2002/07/owl#Class';
const RDFS_SUBCLASS_OF = 'http://www.w3.org/2000/01/rdf-schema#subClassOf';
const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';

describe('ontology-suite/dsl', () => {
  beforeEach(() => {
    // dsl.ts's `current` builder is module-level state (matching how a real script would call
    // ontology() exactly once at the top) -- reset it before each test by starting a fresh one.
    ontology('http://example.org/test#', 'ex');
  });

  it('defclass emits a owl:Class + rdfs:label', () => {
    defclass('Animal', { label: 'Animal' });
    const { quads } = build();
    expect(quads.some((q) => q.subject.value === 'http://example.org/test#Animal' && q.predicate.value === RDF_TYPE && q.object.value === OWL_CLASS)).toBe(true);
    expect(quads.some((q) => q.predicate.value === RDFS_LABEL && q.object.value === 'Animal')).toBe(true);
  });

  it('defclass with subClassOf referencing another ClassRef emits rdfs:subClassOf', () => {
    const Animal = defclass('Animal');
    defclass('Dog', { subClassOf: [Animal] });
    const { quads } = build();
    expect(quads.some((q) => q.subject.value === 'http://example.org/test#Dog' && q.predicate.value === RDFS_SUBCLASS_OF && q.object.value === 'http://example.org/test#Animal')).toBe(true);
  });

  it('a real function/loop generates a family of related classes (the core Tawny-OWL-style benefit)', () => {
    const Animal = defclass('Animal');
    for (const name of ['Dog', 'Cat', 'Bird']) {
      defclass(name, { subClassOf: [Animal] });
    }
    const { quads } = build();
    const subclassCount = quads.filter((q) => q.predicate.value === RDFS_SUBCLASS_OF && q.object.value === 'http://example.org/test#Animal').length;
    expect(subclassCount).toBe(3);
  });

  it('defobjectproperty emits domain/range when given', () => {
    const Person = defclass('Person');
    const hasChild = defobjectproperty('hasChild', { label: 'has child', domain: Person, range: Person });
    expect(hasChild.kind).toBe('objectProperty');
    const { quads } = build();
    expect(quads.some((q) => q.predicate.value === 'http://www.w3.org/2000/01/rdf-schema#domain' && q.object.value === 'http://example.org/test#Person')).toBe(true);
    expect(quads.some((q) => q.predicate.value === 'http://www.w3.org/2000/01/rdf-schema#range' && q.object.value === 'http://example.org/test#Person')).toBe(true);
  });

  it('defdatatypeproperty emits owl:DatatypeProperty', () => {
    const hasAge = defdatatypeproperty('hasAge', { label: 'has age' });
    expect(hasAge.kind).toBe('datatypeProperty');
    const { quads } = build();
    expect(quads.some((q) => q.subject.value === hasAge.iri && q.object.value === 'http://www.w3.org/2002/07/owl#DatatypeProperty')).toBe(true);
  });

  it('some() produces a real owl:Restriction/someValuesFrom, reusing classExprToRdf', () => {
    const Person = defclass('Person');
    const hasChild = defobjectproperty('hasChild');
    defclass('Parent', { subClassOf: [some(hasChild, Person)] });
    const { quads } = build();
    expect(quads.some((q) => q.predicate.value === 'http://www.w3.org/2002/07/owl#onProperty' && q.object.value === hasChild.iri)).toBe(true);
    expect(quads.some((q) => q.predicate.value === 'http://www.w3.org/2002/07/owl#someValuesFrom' && q.object.value === Person.iri)).toBe(true);
  });

  it('only(), and(), or(), not(), minCardinality(), hasValue() all produce well-formed expressions without throwing', () => {
    const Person = defclass('Person');
    const Animal = defclass('Animal');
    const hasChild = defobjectproperty('hasChild');
    defclass('C1', { subClassOf: [only(hasChild, Person)] });
    defclass('C2', { subClassOf: [and(Person, Animal)] });
    defclass('C3', { subClassOf: [or(Person, Animal)] });
    defclass('C4', { subClassOf: [not(Person)] });
    defclass('C5', { subClassOf: [minCardinality(hasChild, 1, Person)] });
    defclass('C6', { subClassOf: [hasValue(hasChild, 'literal text')] });
    const { quads } = build();
    // 6 classes * (1 type + 1 subClassOf) = 12, plus each restriction's own blank-node quads.
    expect(quads.length).toBeGreaterThan(12);
  });

  it('disjointWith emits owl:disjointWith between the two classes', () => {
    const Dog = defclass('Dog');
    const Cat = defclass('Cat', { disjointWith: [Dog] });
    const { quads } = build();
    expect(quads.some((q) => q.subject.value === Cat.iri && q.predicate.value === 'http://www.w3.org/2002/07/owl#disjointWith' && q.object.value === Dog.iri)).toBe(true);
  });

  it('equivalentClass emits owl:equivalentClass, not rdfs:subClassOf', () => {
    const Person = defclass('Person');
    const hasChild = defobjectproperty('hasChild');
    defclass('Parent', { equivalentClass: and(Person, some(hasChild, Person)) });
    const { quads } = build();
    expect(quads.some((q) => q.predicate.value === 'http://www.w3.org/2002/07/owl#equivalentClass')).toBe(true);
  });

  it('throws a clear error if defclass is called before ontology()', async () => {
    // A fresh module instance is needed here specifically -- every other test relies on
    // beforeEach's ontology() call having already set the module-level `current` builder, so
    // this is the one case that needs an un-initialized copy to test against.
    vi.resetModules();
    const fresh = await import('./dsl.js');
    expect(() => fresh.defclass('X')).toThrow(/Call ontology\(/);
  });
});

describe('defontology', () => {
  const OWL = 'http://www.w3.org/2002/07/owl#';
  const DCTERMS = 'http://purl.org/dc/terms/';
  const objectsOf = (quads: Quad[], predicate: string) => quads.filter((q) => q.predicate.value === predicate).map((q) => q.object);

  beforeEach(() => {
    ontology('http://example.org/zoo#', 'zoo', { dcterms: DCTERMS });
  });

  it('writes the header first, whenever it is called', () => {
    defclass('Animal');
    defontology('http://example.org/zoo', { versionIRI: 'http://example.org/zoo/1.2.0', versionInfo: '1.2.0', priorVersion: 'http://example.org/zoo/1.1.0' });
    const { quads } = build();
    expect(quads.slice(0, 4).map((q) => [q.subject.value, q.predicate.value, q.object.value])).toEqual([
      ['http://example.org/zoo', RDF_TYPE, `${OWL}Ontology`],
      ['http://example.org/zoo', `${OWL}versionIRI`, 'http://example.org/zoo/1.2.0'],
      ['http://example.org/zoo', `${OWL}versionInfo`, '1.2.0'],
      ['http://example.org/zoo', `${OWL}priorVersion`, 'http://example.org/zoo/1.1.0'],
    ]);
    expect(quads[4].subject.value).toBe('http://example.org/zoo#Animal');
  });

  it('writes one owl:imports per import, taking full IRIs and CURIEs', () => {
    defontology('http://example.org/zoo', { imports: ['https://w3id.org/semanticarts/ontology/gistCore', 'urn:example:shared', 'gist:'] });
    expect(objectsOf(build().quads, `${OWL}imports`).map((o) => o.value)).toEqual([
      'https://w3id.org/semanticarts/ontology/gistCore',
      'urn:example:shared',
      'https://w3id.org/semanticarts/ns/ontology/gist/',
    ]);
  });

  it('writes annotations as plain, language-tagged, typed or IRI values, several to a property', () => {
    defontology('http://example.org/zoo', {
      label: 'Zoo ontology',
      annotations: {
        'dcterms:title': [{ value: 'Zoo', language: 'en' }, { value: 'Zoo', language: 'de' }],
        'dcterms:created': { value: '2026-10-09', datatype: 'xsd:date' },
        'dcterms:license': { iri: 'https://creativecommons.org/licenses/by/4.0/' },
        [`${DCTERMS}creator`]: 'Pedro',
      },
    });
    const { quads } = build();
    expect(objectsOf(quads, `${DCTERMS}title`).map((o) => [o.value, (o as Literal).language])).toEqual([
      ['Zoo', 'en'],
      ['Zoo', 'de'],
    ]);
    expect((objectsOf(quads, `${DCTERMS}created`)[0] as Literal).datatype.value).toBe('http://www.w3.org/2001/XMLSchema#date');
    expect(objectsOf(quads, `${DCTERMS}license`)[0].termType).toBe('NamedNode');
    expect(objectsOf(quads, `${DCTERMS}creator`)[0].value).toBe('Pedro');
    expect(objectsOf(quads, RDFS_LABEL)[0].value).toBe('Zoo ontology');
  });

  it('refuses a CURIE whose prefix it does not know, rather than writing it as an IRI', () => {
    expect(() => defontology('http://example.org/zoo', { annotations: { 'foaf:maker': 'Pedro' } })).toThrow(/"foaf:maker".*ontology\(\)'s third argument/);
  });

  it('refuses a second header', () => {
    defontology('http://example.org/zoo');
    expect(() => defontology('http://example.org/zoo')).toThrow(/already called/);
  });
});

describe('labels, comments and annotations on classes and properties', () => {
  const ZOO = 'http://example.org/zoo#';
  const RDFS = 'http://www.w3.org/2000/01/rdf-schema#';
  const SKOS = 'http://www.w3.org/2004/02/skos/core#';
  const about = (quads: Quad[], subject: string, predicate: string) =>
    quads.filter((q) => q.subject.value === `${ZOO}${subject}` && q.predicate.value === predicate).map((q) => q.object as Literal);

  beforeEach(() => {
    ontology(ZOO, 'zoo');
  });

  it('takes a label per language, and keeps a plain one plain', () => {
    defclass('Animal', { label: [{ value: 'animal', language: 'en' }, { value: 'Tier', language: 'de' }], comment: 'A living creature.' });
    const { quads } = build();
    expect(about(quads, 'Animal', RDFS_LABEL).map((l) => [l.value, l.language])).toEqual([
      ['animal', 'en'],
      ['Tier', 'de'],
    ]);
    const [comment] = about(quads, 'Animal', `${RDFS}comment`);
    expect([comment.value, comment.language, comment.datatype.value]).toEqual(['A living creature.', '', 'http://www.w3.org/2001/XMLSchema#string']);
  });

  it('writes any other annotation on a class or a property', () => {
    defclass('Animal', {
      annotations: { 'skos:definition': { value: 'A living creature.', language: 'en' }, 'rdfs:seeAlso': { iri: 'https://en.wikipedia.org/wiki/Animal' } },
    });
    defobjectproperty('livesIn', { label: 'lives in', annotations: { 'skos:altLabel': ['resides in', 'is housed in'] } });
    const { quads } = build();
    expect(about(quads, 'Animal', `${SKOS}definition`)[0].language).toBe('en');
    expect(about(quads, 'Animal', `${RDFS}seeAlso`)[0].termType).toBe('NamedNode');
    expect(about(quads, 'livesIn', `${SKOS}altLabel`).map((l) => l.value)).toEqual(['resides in', 'is housed in']);
  });

  it('leaves out an empty label, as before', () => {
    defclass('Animal', { label: '' });
    expect(about(build().quads, 'Animal', RDFS_LABEL)).toEqual([]);
  });
});

describe('patterns: someOnly and asSubclasses', () => {
  const ZOO = 'http://example.org/zoo#';
  const OWL = 'http://www.w3.org/2002/07/owl#';
  const named = (quads: Quad[], predicate: string) =>
    quads.filter((q) => q.predicate.value === predicate && q.object.termType === 'NamedNode').map((q) => [q.subject.value.replace(ZOO, ''), q.object.value.replace(ZOO, '')]);

  beforeEach(() => {
    ontology(ZOO, 'zoo');
  });

  it('someOnly: some of each filler, and only their union', () => {
    const hasTopping = defobjectproperty('hasTopping');
    const Mozzarella = defclass('Mozzarella');
    const Tomato = defclass('Tomato');
    expect(someOnly(hasTopping, Mozzarella, Tomato)).toEqual([some(hasTopping, Mozzarella), some(hasTopping, Tomato), only(hasTopping, or(Mozzarella, Tomato))]);
    expect(someOnly(hasTopping, Tomato)).toEqual([some(hasTopping, Tomato), only(hasTopping, Tomato)]);
    expect(() => someOnly(hasTopping)).toThrow('someOnly() needs at least one filler.');
  });

  it('asSubclasses: each child under the parent, pairwise disjoint, and covering it', () => {
    const Animal = defclass('Animal');
    const children = [defclass('Mammal'), defclass('Bird'), defclass('Reptile')];
    expect(asSubclasses(Animal, children, { disjoint: true, cover: true })).toBe(children);
    const { quads } = build();
    expect(named(quads, RDFS_SUBCLASS_OF)).toEqual([
      ['Mammal', 'Animal'],
      ['Bird', 'Animal'],
      ['Reptile', 'Animal'],
    ]);
    expect(named(quads, `${OWL}disjointWith`)).toEqual([
      ['Mammal', 'Bird'],
      ['Mammal', 'Reptile'],
      ['Bird', 'Reptile'],
    ]);
    const cover = quads.find((q) => q.subject.value === `${ZOO}Animal` && q.predicate.value === RDFS_SUBCLASS_OF)!;
    expect(cover.object.termType).toBe('BlankNode');
    expect(quads.some((q) => q.subject.equals(cover.object) && q.predicate.value === `${OWL}unionOf`)).toBe(true);
  });

  it('asSubclasses writes nothing more than asked for', () => {
    const Animal = defclass('Animal');
    asSubclasses(Animal, [defclass('Mammal'), defclass('Bird')]);
    const { quads } = build();
    expect(named(quads, `${OWL}disjointWith`)).toEqual([]);
    expect(quads.some((q) => q.subject.value === `${ZOO}Animal` && q.predicate.value === RDFS_SUBCLASS_OF)).toBe(false);
  });

  it('build writes a triple stated twice once, and keeps restrictions that look alike', () => {
    const Animal = defclass('Animal');
    const livesIn = defobjectproperty('livesIn');
    const Dog = defclass('Dog', { subClassOf: [Animal, some(livesIn, Animal), some(livesIn, Animal)] });
    asSubclasses(Animal, [Dog]);
    const { quads } = build();
    expect(named(quads, RDFS_SUBCLASS_OF)).toEqual([['Dog', 'Animal']]);
    expect(quads.filter((q) => q.predicate.value === `${OWL}someValuesFrom`)).toHaveLength(2);
  });
});

describe('mx', () => {
  const ZOO = 'http://example.org/zoo#';
  const GIST = 'https://w3id.org/semanticarts/ns/ontology/gist/';
  const cls = (local: string, ns = ZOO) => ({ kind: 'class', iri: `${ns}${local}` });

  beforeEach(() => {
    ontology(ZOO, 'zoo');
  });

  it('reads a bare name as a term of this ontology, and a CURIE over its prefixes', () => {
    expect(mx`livesIn some (Aquarium or gist:Place)`).toEqual({
      kind: 'restriction',
      property: `${ZOO}livesIn`,
      type: 'some',
      filler: { kind: 'or', operands: [cls('Aquarium'), cls('Place', GIST)] },
    });
  });

  it('takes interpolated classes, properties, numbers, strings and class expressions, as the builders do', () => {
    const Animal = defclass('Animal');
    const hasMember = defobjectproperty('hasMember');
    const status = defdatatypeproperty('status');
    expect(mx`${hasMember} min ${3} ${Animal}`).toEqual(minCardinality(hasMember, 3, Animal));
    expect(mx`${Animal} and ${some(hasMember, Animal)}`).toEqual(and(Animal, some(hasMember, Animal)));
    expect(mx`${status} value ${'on the "red" list'}`).toEqual(hasValue(status, 'on the "red" list'));
  });

  it('covers what the builders cannot: oneOf and Self', () => {
    expect(mx`{red, green}`).toEqual({ kind: 'oneOf', individuals: [`${ZOO}red`, `${ZOO}green`] });
    expect(mx`grooms Self`).toEqual({ kind: 'restriction', property: `${ZOO}grooms`, type: 'self' });
    defclass('Colour', { equivalentClass: mx`{red, green}` });
    expect(build().quads.some((q) => q.predicate.value === 'http://www.w3.org/2002/07/owl#oneOf')).toBe(true);
  });

  it('refuses a class used as a property, and a property used as a class', () => {
    const Animal = defclass('Animal');
    const eats = defobjectproperty('eats');
    expect(() => mx`${Animal} some ${eats}`).toThrow('mx: Animal is a class, used here as a property.');
    expect(() => mx`eats some ${eats}`).toThrow('mx: eats is a property, used here as a class.');
  });

  it('says where a syntax error is', () => {
    expect(() => mx`livesIn soem Aquarium`).toThrow(/^mx: Unexpected 'soem' after a complete class expression\.\n {2}livesIn soem Aquarium\n {10}\^$/);
  });

  it('refuses an unknown prefix, and a cardinality that is not a whole number', () => {
    const p = defobjectproperty('p');
    expect(() => mx`foaf:knows some Person`).toThrow(/"foaf:knows" is neither a full IRI nor a CURIE/);
    expect(() => mx`${p} min ${1.5}`).toThrow('mx: 1.5 is not a cardinality');
  });
});
