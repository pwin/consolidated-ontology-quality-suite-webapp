// The whole DSL in one script: the ontology header, labels in two languages, property
// characteristics, an inverse and a chain, datatypes with facets, individuals and their facts,
// Manchester Syntax through mx, and the some-only and as-subclasses patterns. With it open, run
// "Ontology Suite: Run Ontology Script" to write zoo.ttl next to it.
import {
  ontology,
  defontology,
  defclass,
  defobjectproperty,
  defdatatypeproperty,
  defindividual,
  allDifferent,
  datatype,
  classRef,
  mx,
  someOnly,
  asSubclasses,
} from 'ontology-suite/dsl';

ontology('http://example.org/zoo#', 'zoo', { dcterms: 'http://purl.org/dc/terms/' });

defontology('http://example.org/zoo', {
  versionIRI: 'http://example.org/zoo/1.0.0',
  versionInfo: '1.0.0',
  label: 'Zoo',
  annotations: { 'dcterms:creator': 'The zoo team' },
});

// Classes. A keeper is a gist:Person, named with classRef rather than declared here.
const Animal = defclass('Animal', { label: [{ value: 'animal', language: 'en' }, { value: 'Tier', language: 'de' }] });
const Place = defclass('Place', { label: 'place' });
const Enclosure = defclass('Enclosure', { label: 'enclosure', subClassOf: [Place] });
const Keeper = defclass('Keeper', { label: 'keeper', subClassOf: [classRef('gist:Person')] });
const Food = defclass('Food', { label: 'food' });
const [Fish, , Plant] = asSubclasses(Food, [defclass('Fish'), defclass('Insect'), defclass('Plant')], { disjoint: true, cover: true });

// Properties: what each one is, and how they combine.
const livesIn = defobjectproperty('livesIn', { domain: Animal, range: Enclosure, characteristics: ['functional'] });
const partOf = defobjectproperty('partOf', { domain: Place, range: Place, characteristics: ['transitive'] });
// An animal is located in whatever its enclosure is part of.
defobjectproperty('locatedIn', { chain: [livesIn, partOf] });
const caresFor = defobjectproperty('caresFor', { domain: Keeper, range: Animal });
// A named inverse: Local Checks gives this an MDL-001 hint, after gist's convention.
const caredForBy = defobjectproperty('caredForBy', { inverseOf: caresFor });
const eats = defobjectproperty('eats', { domain: Animal, range: Food });
const name = defdatatypeproperty('name', { range: datatype('xsd:string', { minLength: 1 }) });
const age = defdatatypeproperty('age', { domain: Animal, range: datatype('xsd:integer', { minInclusive: 0, maxInclusive: 150 }), characteristics: ['functional'] });

// Restrictions: a pattern, and Manchester Syntax where text is quicker.
const Penguin = defclass('Penguin', { label: 'penguin', subClassOf: [Animal, ...someOnly(eats, Fish)] });
defclass('Herbivore', { equivalentClass: mx`Animal and ${eats} only ${Plant}` });
defclass('CaredForAnimal', { equivalentClass: mx`Animal and ${caredForBy} some Keeper` });

// Individuals, and what is known about them.
const coast = defindividual('coast', { types: [Place], facts: [[name, 'The coast']] });
const pool = defindividual('penguinPool', { types: [Enclosure], facts: [[partOf, coast], [name, 'Penguin pool']] });
const pingu = defindividual('pingu', { types: [Penguin], facts: [[livesIn, pool], [name, 'Pingu'], [age, 7]] });
const sam = defindividual('sam', { types: [Keeper], facts: [[caresFor, pingu], [name, 'Sam']] });
allDifferent(coast, pool, pingu, sam);
