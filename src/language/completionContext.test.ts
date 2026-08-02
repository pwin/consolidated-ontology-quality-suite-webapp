import { describe, expect, it } from 'vitest';
import { detectPosition, expectedKinds } from './completionContext';

const prefixes = { ex: 'http://example.org/demo#', rdfs: 'http://www.w3.org/2000/01/rdf-schema#' };

describe('detectPosition', () => {
  it.each<[string, string, ReturnType<typeof detectPosition>]>([
    ['typing a bare subject at the very start of the document', 'ex:', { slot: 'subject' }],
    ['object of `a`', 'ex:Dog a ex:', { slot: 'object', governingPredicate: 'a' }],
    ['predicate slot after ;', 'ex:Dog a ex:Mammal ;\n  ex:', { slot: 'predicate' }],
    ['subject of a new statement after .', 'ex:Dog a ex:Mammal .\nex:', { slot: 'subject' }],
    ['object of `a` in a second statement (proves `.` boundary detection)', 'ex:Dog a ex:Mammal .\nex:Cat a ex:', { slot: 'object', governingPredicate: 'a' }],
  ])('%s', (_label, text, expected) => {
    expect(detectPosition(text)).toEqual(expected);
  });

  it('recovers the governing predicate from the first comma-part when typing a later object', () => {
    const ctx = detectPosition('ex:Dog a ex:Mammal ;\n  ex:hasOwner ex:alice, ex:');
    expect(ctx).toEqual({ slot: 'object', governingPredicate: 'ex:hasOwner' });
  });
});

describe('expectedKinds', () => {
  it('restricts predicate slot to property kinds', () => {
    expect(expectedKinds({ slot: 'predicate' }, prefixes)).toEqual(['objectProperty', 'datatypeProperty', 'annotationProperty']);
  });

  it('restricts object-of-`a` to classes', () => {
    expect(expectedKinds({ slot: 'object', governingPredicate: 'a' }, prefixes)).toEqual(['class']);
  });

  it('restricts object-of-rdfs:subClassOf to classes', () => {
    expect(expectedKinds({ slot: 'object', governingPredicate: 'rdfs:subClassOf' }, prefixes)).toEqual(['class']);
  });

  it('restricts object-of-rdfs:subPropertyOf to property kinds', () => {
    expect(expectedKinds({ slot: 'object', governingPredicate: 'rdfs:subPropertyOf' }, prefixes)).toEqual(['objectProperty', 'datatypeProperty', 'annotationProperty']);
  });

  it('fails open (null = unfiltered) for an unresolvable or custom-property object slot', () => {
    expect(expectedKinds({ slot: 'object', governingPredicate: 'ex:hasOwner' }, prefixes)).toBeNull();
    expect(expectedKinds({ slot: 'subject' }, prefixes)).toBeNull();
    expect(expectedKinds({ slot: 'unknown' }, prefixes)).toBeNull();
  });
});
