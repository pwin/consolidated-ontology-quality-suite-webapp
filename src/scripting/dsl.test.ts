import { describe, expect, it, beforeEach, vi } from 'vitest';
import { ontology, defclass, defobjectproperty, defdatatypeproperty, some, only, and, or, not, minCardinality, hasValue, build } from './dsl';

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
