# ontology-suite

Write OWL ontologies as TypeScript. This is the scripting DSL of the [Ontology Development Suite](https://github.com/pwin/consolidated-ontology-quality-suite-webapp) VS Code extension, published on its own so that `import ... from 'ontology-suite/dsl'` resolves anywhere: in CI, in another editor, or in a script you run with Node.

```sh
npm install --save-dev ontology-suite
```

## Example

```typescript
import { ontology, defontology, defclass, defobjectproperty, defdatatypeproperty, defindividual, datatype, mx, build } from 'ontology-suite/dsl';

ontology('http://example.org/zoo#', 'zoo');
defontology('http://example.org/zoo', { versionIRI: 'http://example.org/zoo/1.0.0', label: 'Zoo' });

const Animal = defclass('Animal', { label: [{ value: 'animal', language: 'en' }, { value: 'Tier', language: 'de' }] });
const Enclosure = defclass('Enclosure');
const livesIn = defobjectproperty('livesIn', { domain: Animal, range: Enclosure, characteristics: ['functional'] });
const age = defdatatypeproperty('age', { range: datatype('xsd:integer', { minInclusive: 0, maxInclusive: 150 }) });

defclass('Resident', { equivalentClass: mx`Animal and ${livesIn} some Enclosure` });

const pool = defindividual('pool', { types: [Enclosure] });
defindividual('pingu', { types: [Animal], facts: [[livesIn, pool], [age, 7]] });

const { quads, prefixes } = build();
console.log(`${quads.length} triples`);
```

`build()` returns the ontology as [RDF/JS](https://rdf.js.org/) quads, with the prefixes it uses, ready for any RDF/JS serializer, such as [n3](https://www.npmjs.com/package/n3)'s Writer. The types catch a mistake before the script runs: a fact giving an object property a literal, say, or a datatype property in a property chain. Code the type checker never saw, run with `tsx` or written in JavaScript, gets the same mistake back as an error naming the function, the argument and what it was given.

## What the language has

- **Declarations:** `ontology`, `defontology` (version IRI, imports, annotations), `defclass`, `defobjectproperty` (characteristics, inverse, chain), `defdatatypeproperty` (datatype ranges with facets), `defindividual` (types and facts), `allDifferent`.
- **Class expressions:** `some`, `only`, `hasValue`, `minCardinality`, `maxCardinality`, `exactCardinality`, `and`, `or`, `not`, `inverse` for a restriction on the inverse of a property, and Manchester Syntax through `` mx`...` ``.
- **Patterns:** `someOnly` and `asSubclasses`, after Tawny-OWL.
- **References** to terms declared elsewhere: `classRef`, `objectPropertyRef`, `datatypePropertyRef`, `individualRef`.

Labels and comments take a language tag, and any declaration takes annotations. The extension's [tutorial](https://github.com/pwin/consolidated-ontology-quality-suite-webapp/blob/main/TUTORIAL.md#part-11-scripting-ontologies-with-typescript) walks through all of it.

## With the VS Code extension

You don't need this package to use the DSL in VS Code: the extension types `.ontology.ts` scripts and runs them (**Ontology Suite: Run Ontology Script**) without it. If the package is installed, the editor uses its types, and the extension still runs a script with its own copy of the DSL, so keep the two at the same version.

## License

MIT
