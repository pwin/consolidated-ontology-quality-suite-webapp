// Simple example for TUTORIAL.md's scripting section. A plain .ts file --
// real IntelliSense/type-checking from VS Code's built-in TypeScript
// support, not a custom language. Run via "Ontology Suite: Run Ontology
// Script" with this file active; it creates pets.ttl alongside it (or lets
// you append/replace if pets.ttl already exists).
import { ontology, defclass, defobjectproperty } from 'ontology-suite/dsl';

ontology('http://example.org/pets#', 'pets');

const Animal = defclass('Animal', { label: 'Animal', comment: 'A living creature.' });
defclass('Dog', { label: 'Dog', subClassOf: [Animal] });
defclass('Cat', { label: 'Cat', subClassOf: [Animal] });

defobjectproperty('hasOwner', { label: 'has owner' });
