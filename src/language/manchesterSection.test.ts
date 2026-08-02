import { describe, expect, it } from 'vitest';
import { detectSection } from './manchesterSection';

const doc = `Prefix: ex: <http://example.org/demo#>

Class: ex:Dog
    SubClassOf: ex:Mammal
    Annotations: rdfs:label "Dog"

ObjectProperty: ex:hasOwner
    Domain: ex:Dog
    Range: ex:Person

Class: ex:OwnedDog
    SubClassOf: ex:hasOwner some ex:
`;

describe('detectSection', () => {
  it.each<[string, number, ReturnType<typeof detectSection>]>([
    ['right after "SubClassOf: " in the first Class frame', doc.indexOf('SubClassOf: ex:Mammal') + 'SubClassOf: '.length, { section: 'SubClassOf', frameKind: undefined }],
    ['right after "Class: " frame header, before naming the class', doc.indexOf('Class: ex:Dog') + 'Class: '.length, { section: 'frame-header', frameKind: 'Class' }],
    ['right after "ObjectProperty: " frame header', doc.indexOf('ObjectProperty: ex:hasOwner') + 'ObjectProperty: '.length, { section: 'frame-header', frameKind: 'ObjectProperty' }],
    ['right after "Domain: "', doc.indexOf('Domain: ex:Dog') + 'Domain: '.length, { section: 'Domain', frameKind: undefined }],
    ['right after "Range: "', doc.indexOf('Range: ex:Person') + 'Range: '.length, { section: 'Range', frameKind: undefined }],
    ['mid-expression in the second Class frame -- finds the *nearest* SubClassOf, not the first', doc.length - 1, { section: 'SubClassOf', frameKind: undefined }],
  ])('%s', (_label, offset, expected) => {
    expect(detectSection(doc, offset)).toEqual(expected);
  });
});
