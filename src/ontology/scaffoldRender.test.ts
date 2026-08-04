import { describe, expect, it } from 'vitest';
import { parseClassExpression } from '../rdf/formats/classExpression';
import {
  renderAddClassTurtle,
  renderAddPropertyTurtle,
  renderAddClassWithParentsTurtle,
  renderAddSubPropertyTurtle,
  humanize,
} from './scaffoldRender';

const prefixes = { ex: 'http://example.org/clinic#', rdfs: 'http://www.w3.org/2000/01/rdf-schema#', owl: 'http://www.w3.org/2002/07/owl#' };

describe('renderAddClassTurtle', () => {
  it('renders a plain owl:Class', () => {
    const turtle = renderAddClassTurtle({ className: 'Vet', label: 'Vet', asCategory: false, prefix: 'ex' });
    expect(turtle).toContain('ex:Vet');
    expect(turtle).toContain('a owl:Class');
  });

  it('renders a gist:Category when asCategory is true', () => {
    const turtle = renderAddClassTurtle({ className: 'AppointmentType', label: 'Appointment Type', asCategory: true, prefix: 'ex' });
    expect(turtle).toContain('a gist:Category');
  });
});

describe('renderAddPropertyTurtle', () => {
  it('renders domain/range when given, omits them when not', () => {
    const withBoth = renderAddPropertyTurtle({ propertyName: 'hasOwner', label: 'has owner', kind: 'ObjectProperty', domain: 'ex:Animal', range: 'ex:Person', prefix: 'ex' });
    expect(withBoth).toContain('rdfs:domain ex:Animal');
    expect(withBoth).toContain('rdfs:range ex:Person');

    const withNeither = renderAddPropertyTurtle({ propertyName: 'hasOwner', label: 'has owner', kind: 'ObjectProperty', prefix: 'ex' });
    expect(withNeither).not.toContain('rdfs:domain');
    expect(withNeither).not.toContain('rdfs:range');
  });
});

describe('renderAddClassWithParentsTurtle', () => {
  it('renders a subclass of one named parent, no @prefix lines (those already exist in the target file)', async () => {
    const turtle = await renderAddClassWithParentsTurtle(
      { className: 'Dog', label: 'Dog', prefix: 'ex', parentIris: ['http://example.org/clinic#Mammal'] },
      prefixes,
    );
    expect(turtle).toContain('ex:Dog');
    expect(turtle).toContain('a owl:Class');
    expect(turtle).toContain('rdfs:subClassOf ex:Mammal');
    expect(turtle).not.toContain('@prefix');
  });

  it('renders multiple named parents (sibling-class case: same parents as the sibling)', async () => {
    const turtle = await renderAddClassWithParentsTurtle(
      { className: 'Cat', label: 'Cat', prefix: 'ex', parentIris: ['http://example.org/clinic#Mammal', 'http://example.org/clinic#Pet'] },
      prefixes,
    );
    expect(turtle).toContain('rdfs:subClassOf');
    expect(turtle).toMatch(/ex:Mammal/);
    expect(turtle).toMatch(/ex:Pet/);
  });

  it('renders no rdfs:subClassOf at all when parentIris is empty (top-level sibling of a root class)', async () => {
    const turtle = await renderAddClassWithParentsTurtle({ className: 'Widget', label: 'Widget', prefix: 'ex', parentIris: [] }, prefixes);
    expect(turtle).not.toContain('rdfs:subClassOf');
  });

  it('renders an additional Manchester-expression restriction as a second rdfs:subClassOf, round-tripped through the real parser', async () => {
    const expr = parseClassExpression('ex:hasChild some ex:Person');
    expect(expr).toBeDefined();
    const turtle = await renderAddClassWithParentsTurtle(
      { className: 'Parent', label: 'Parent', prefix: 'ex', parentIris: ['http://example.org/clinic#Person'], restrictionExpr: expr },
      prefixes,
    );
    // Two independent rdfs:subClassOf assertions: the atomic named parent (keeps the Outline's
    // hierarchy working, since only named-node subClassOf targets are indexed) and the
    // restriction (a blank node, so it doesn't affect the tree).
    const matches = turtle.match(/rdfs:subClassOf/g) ?? [];
    expect(matches.length).toBe(2);
    expect(turtle).toContain('owl:Restriction');
    expect(turtle).toContain('owl:onProperty ex:hasChild');
    expect(turtle).toContain('owl:someValuesFrom ex:Person');
  });
});

describe('renderAddSubPropertyTurtle', () => {
  it('renders rdfs:subPropertyOf the given parent property', () => {
    const turtle = renderAddSubPropertyTurtle(
      { propertyName: 'hasPrimaryOwner', label: 'has primary owner', kind: 'ObjectProperty', prefix: 'ex', parentIri: 'http://example.org/clinic#hasOwner' },
      { ...prefixes, ex: 'http://example.org/clinic#' },
    );
    expect(turtle).toContain('ex:hasPrimaryOwner');
    expect(turtle).toContain('a owl:ObjectProperty');
    expect(turtle).toContain('rdfs:subPropertyOf ex:hasOwner');
  });

  it('renders a DatatypeProperty kind correctly', () => {
    const turtle = renderAddSubPropertyTurtle(
      { propertyName: 'hasNickname', label: 'has nickname', kind: 'DatatypeProperty', prefix: 'ex', parentIri: 'http://example.org/clinic#hasName' },
      { ex: 'http://example.org/clinic#' },
    );
    expect(turtle).toContain('a owl:DatatypeProperty');
  });

  it('still abbreviates rdf:/rdfs:/owl: correctly even when the target document never explicitly declares them (common -- `a` needs no prefix at all in real Turtle)', () => {
    // Regression test: shrink() against only the caller-supplied prefixes silently produces an
    // ugly full IRI instead of a CURIE when rdf:/rdfs:/owl: aren't declared -- this is exactly
    // what a real .ttl file with no `@prefix rdf:`/`@prefix owl:` line looks like.
    const turtle = renderAddSubPropertyTurtle(
      { propertyName: 'hasVet', label: 'has vet', kind: 'ObjectProperty', prefix: 'ex', parentIri: 'http://example.org/clinic#hasCarer' },
      { ex: 'http://example.org/clinic#' },
    );
    expect(turtle).not.toContain('22-rdf-syntax-ns');
    expect(turtle).not.toContain('2000/01/rdf-schema');
    expect(turtle).toContain('a owl:ObjectProperty');
    expect(turtle).toContain('rdfs:subPropertyOf ex:hasCarer');
  });
});

describe('humanize', () => {
  it('splits camelCase and capitalizes the first letter', () => {
    expect(humanize('hasOwner')).toBe('Has Owner');
  });
});
