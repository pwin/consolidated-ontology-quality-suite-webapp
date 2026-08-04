// Complex example for TUTORIAL.md's scripting section -- run against the
// same pets.ttl the simple example (pets.ontology.ts) created, using
// "Append" when prompted. Demonstrates the actual Tawny-OWL-style
// benefit (a real loop generating a whole family of related classes from
// a data table -- no GUI lets you do this in one step), owl:disjointWith
// (for the reasoner demo in Part 11), and a Manchester-style restriction
// via some() -- the exact same classExprToRdf engine the Outline's "Add
// Subclass" restriction option and .omn files both already use.
import { ontology, defclass, defobjectproperty, some } from 'ontology-suite/dsl';

ontology('http://example.org/pets#', 'pets');

const Animal = defclass('Animal');
const Dog = defclass('Dog');
const Cat = defclass('Cat', { disjointWith: [Dog] });
const Person = defclass('Person', { label: 'Person' });
const hasOwner = defobjectproperty('hasOwner', { label: 'has owner', domain: Animal, range: Person });

// A real function/loop generating a whole family of related classes from a data table --
// deliberately no label on each breed here, so Part 11 has something real for
// "Run Local Checks" (QUA-001) and Quick Fix to catch afterwards.
const breeds = [
  { name: 'Labrador', species: Dog },
  { name: 'Poodle', species: Dog },
  { name: 'Siamese', species: Cat },
];
for (const breed of breeds) {
  defclass(breed.name, { subClassOf: [breed.species] });
}

// A Manchester-style restriction -- same engine, same AST, as the Outline's "Add Subclass"
// restriction option and .omn files.
defclass('OwnedAnimal', {
  label: 'Owned Animal',
  subClassOf: [Animal, some(hasOwner, Person)],
});
