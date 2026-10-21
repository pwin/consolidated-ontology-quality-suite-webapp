import * as fs from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import * as dsl from './dsl';

/**
 * What a script the type checker did not see -- run with tsx, or written in JavaScript -- gets for
 * each mistake of kind: an error naming the function, the argument and what arrived, never an
 * internal TypeError, and nothing written by the call that failed. The SemOps manual's claim C08.15
 * recorded the first case failing inside the DSL with "TypeError: Cannot convert undefined or null
 * to object".
 */
const wrong = (value: unknown) => value as any;

let Animal: dsl.ClassRef;
let livesIn: dsl.ObjectPropertyRef;
let age: dsl.DatatypePropertyRef;
let rex: dsl.IndividualRef;

const CLASS = 'a class (from defclass or classRef)';
const CLASS_OR_EXPR = 'a class or a class expression';
const OBJECT_PROPERTY = 'an object property (from defobjectproperty or objectPropertyRef)';
const PROPERTY_EXPR = 'a property, or inverse(property)';
const LITERAL = 'a literal: a string, number or boolean, or { value, language } or { value, datatype }';

const MISTAKES: [string, () => unknown, string][] = [
  [
    "C08.15: a datatype property's range as a bare string",
    () => dsl.defdatatypeproperty('hasEmployeeId', { domain: Animal, range: wrong('xsd:string') }),
    `defdatatypeproperty('hasEmployeeId'): range takes a datatype, made with datatype('xsd:string') say, and was given the string "xsd:string".`,
  ],
  ['ontology without a base IRI', () => dsl.ontology(wrong(undefined), 'zoo'), 'ontology: the base IRI takes a non-empty string, and was given undefined.'],
  ['an extra prefix that is not a namespace', () => dsl.ontology('http://example.org/zoo#', 'zoo', { dcterms: wrong(5) }), "ontology: the extra prefix 'dcterms' takes a non-empty string, and was given the number 5."],
  ['imports as one string', () => dsl.defontology('http://example.org/zoo', { imports: wrong('gist') }), 'defontology: imports takes a list of IRIs, and was given the string "gist".'],
  ['a label that is a number', () => dsl.defontology('http://example.org/zoo', { label: wrong(5) }), 'defontology: label takes text: a string, or { value, language }, and was given the number 5.'],
  ['defclass without a name', () => dsl.defclass(wrong(undefined)), 'defclass: the name takes a non-empty string, and was given undefined.'],
  ['options that are not an object', () => dsl.defclass('Dog', wrong(null)), "defclass('Dog') takes an options object, and was given null."],
  ['a parent class by name', () => dsl.defclass('Dog', { subClassOf: [wrong('Animal')] }), `defclass('Dog'): subClassOf[0] takes ${CLASS_OR_EXPR}, and was given the string "Animal".`],
  ['parents not in a list', () => dsl.defclass('Dog', { subClassOf: wrong(Animal) }), "defclass('Dog'): subClassOf takes a list of classes or class expressions, and was given a class, Animal."],
  ['a property where a disjoint class goes', () => dsl.defclass('Dog', { disjointWith: [wrong(livesIn)] }), `defclass('Dog'): disjointWith[0] takes ${CLASS}, and was given an object property, livesIn.`],
  ['an annotation with no value', () => dsl.defclass('Dog', { annotations: { 'skos:definition': wrong(undefined) } }), `defclass('Dog'): annotations['skos:definition'] takes ${LITERAL}, and was given undefined.`],
  ['a domain by name', () => dsl.defobjectproperty('eats', { domain: wrong('Animal') }), `defobjectproperty('eats'): domain takes ${CLASS}, and was given the string "Animal".`],
  ['a datatype as an object range', () => dsl.defobjectproperty('eats', { range: wrong(dsl.datatype('xsd:string')) }), `defobjectproperty('eats'): range takes ${CLASS}, and was given a datatype.`],
  ['a class as a datatype range', () => dsl.defdatatypeproperty('weight', { range: wrong(Animal) }), `defdatatypeproperty('weight'): range takes a datatype, made with datatype('xsd:string') say, and was given a class, Animal.`],
  ['datatype without a name', () => dsl.datatype(wrong(undefined)), 'datatype: the name takes a non-empty string, and was given undefined.'],
  ['a fact with no property', () => dsl.defindividual('fido', { facts: [wrong([undefined, 3])] }), "defindividual('fido'): facts[0][0] takes a property (from defobjectproperty or defdatatypeproperty), and was given undefined."],
  ['a fact that is not a pair', () => dsl.defindividual('fido', { facts: [wrong(livesIn)] }), "defindividual('fido'): facts[0] takes a fact: [property, value], and was given an object property, livesIn."],
  ['a fact with no value', () => dsl.defindividual('fido', { facts: [wrong([age, undefined])] }), `fido: the value of age takes ${LITERAL}, and was given undefined.`],
  ['an individual as a type', () => dsl.defindividual('fido', { types: [wrong(rex)] }), `defindividual('fido'): types[0] takes ${CLASS_OR_EXPR}, and was given an individual, rex.`],
  ['allDifferent given a name', () => dsl.allDifferent(rex, wrong('fido')), 'allDifferent: argument 2 takes an individual (from defindividual or individualRef), and was given the string "fido".'],
  ['classRef without a name', () => dsl.classRef(wrong(undefined)), 'classRef: the name takes a non-empty string, and was given undefined.'],
  ['objectPropertyRef given a number', () => dsl.objectPropertyRef(wrong(3)), 'objectPropertyRef: the name takes a non-empty string, and was given the number 3.'],
  ['datatypePropertyRef given a class', () => dsl.datatypePropertyRef(wrong(Animal)), 'datatypePropertyRef: the name takes a non-empty string, and was given a class, Animal.'],
  ['individualRef given null', () => dsl.individualRef(wrong(null)), 'individualRef: the name takes a non-empty string, and was given null.'],
  ['inverse of nothing', () => dsl.inverse(wrong(undefined)), `inverse takes ${OBJECT_PROPERTY}, and was given undefined.`],
  ['some without a property', () => dsl.some(wrong(undefined), Animal), `some: the property takes ${PROPERTY_EXPR}, and was given undefined.`],
  ['some with a class by name', () => dsl.some(livesIn, wrong('Animal')), `some: the filler takes ${CLASS_OR_EXPR}, and was given the string "Animal".`],
  ['only on a class', () => dsl.only(wrong(Animal), Animal), `only: the property takes ${PROPERTY_EXPR}, and was given a class, Animal.`],
  ['hasValue with no value', () => dsl.hasValue(age, wrong(undefined)), `hasValue: the value takes ${LITERAL}, and was given undefined.`],
  ['hasValue with a property as the value', () => dsl.hasValue(age, wrong(livesIn)), 'hasValue: the value takes an individual or a literal, and was given an object property, livesIn.'],
  ['a negative cardinality', () => dsl.minCardinality(livesIn, -1), 'minCardinality: the number takes a whole number, 0 or more, and was given the number -1.'],
  ['a cardinality as a string', () => dsl.maxCardinality(livesIn, wrong('2')), 'maxCardinality: the number takes a whole number, 0 or more, and was given the string "2".'],
  ['a cardinality filler by name', () => dsl.exactCardinality(livesIn, 2, wrong('Animal')), `exactCardinality: the filler takes ${CLASS_OR_EXPR}, and was given the string "Animal".`],
  ['and with a hole', () => dsl.and(Animal, wrong(undefined)), `and: argument 2 takes ${CLASS_OR_EXPR}, and was given undefined.`],
  ['or with an individual', () => dsl.or(Animal, wrong(rex)), `or: argument 2 takes ${CLASS_OR_EXPR}, and was given an individual, rex.`],
  ['not of a name', () => dsl.not(wrong('Animal')), `not takes ${CLASS_OR_EXPR}, and was given the string "Animal".`],
  ['mx called as a function', () => dsl.mx(wrong('livesIn some Enclosure')), 'mx is a tagged template: write mx`...`, not mx(...).'],
  ['mx given undefined', () => dsl.mx`${wrong(undefined)} some Enclosure`, `mx: \${...} 1 takes ${CLASS_OR_EXPR}, and was given undefined.`],
  ['someOnly with a filler by name', () => dsl.someOnly(livesIn, wrong('Fish')), `someOnly: filler 1 takes ${CLASS_OR_EXPR}, and was given the string "Fish".`],
  ['asSubclasses with a parent by name', () => dsl.asSubclasses(wrong('Animal'), [Animal]), `asSubclasses: the parent takes ${CLASS}, and was given the string "Animal".`],
  ['asSubclasses with one child, not a list', () => dsl.asSubclasses(Animal, wrong(Animal)), 'asSubclasses: the children takes a list of classes, and was given a class, Animal.'],
];

describe('a script the type checker did not see', () => {
  beforeEach(() => {
    dsl.ontology('http://example.org/zoo#', 'zoo');
    Animal = dsl.defclass('Animal');
    livesIn = dsl.defobjectproperty('livesIn');
    age = dsl.defdatatypeproperty('age');
    rex = dsl.defindividual('rex');
  });

  it.each(MISTAKES)('%s: gets an error naming what it wrote, and the call writes nothing', (_, call, message) => {
    const before = dsl.build().quads.length;
    let thrown: unknown;
    try {
      call();
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(TypeError);
    expect((thrown as Error).message).toBe(message);
    expect(dsl.build().quads.length).toBe(before);
  });

  it('covers every function the DSL exports', () => {
    // Read from this file's source: the test runner rewrites `dsl.x` inside the functions above.
    const source = fs.readFileSync(__filename, 'utf8');
    const covered = new Set([...source.matchAll(/\(\) => dsl\.(\w+)/g)].map((m) => m[1]));
    const exported = Object.entries(dsl).filter(([, value]) => typeof value === 'function').map(([name]) => name);
    expect(exported.filter((name) => name !== 'build' && !covered.has(name))).toEqual([]);
  });
});
