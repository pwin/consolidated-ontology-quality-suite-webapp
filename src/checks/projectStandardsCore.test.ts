import { describe, expect, it } from 'vitest';
import { DEFAULT_PROJECT_STANDARDS, resolveStandardsIris } from './projectStandardsCore';

describe('resolveStandardsIris', () => {
  it('resolves a CURIE-shaped categoryClass against the standards\' own prefixes', () => {
    const resolved = resolveStandardsIris(DEFAULT_PROJECT_STANDARDS, {});
    expect(resolved.categoryClass).toBe('https://w3id.org/semanticarts/ns/ontology/gist/Category');
  });

  it('lets the target document\'s own prefixes override/extend the standards\' prefixes', () => {
    const standards = { ...DEFAULT_PROJECT_STANDARDS, categoryClass: 'ex:Classification' };
    const resolved = resolveStandardsIris(standards, { ex: 'http://example.org/clinic#' });
    expect(resolved.categoryClass).toBe('http://example.org/clinic#Classification');
  });

  it('passes an already-absolute IRI through unchanged', () => {
    const standards = { ...DEFAULT_PROJECT_STANDARDS, categoryClass: 'http://example.org/clinic#Classification' };
    const resolved = resolveStandardsIris(standards, {});
    expect(resolved.categoryClass).toBe('http://example.org/clinic#Classification');
  });

  it('passes defaultOntologyBaseIri through unresolved (it is always a full IRI, never a CURIE)', () => {
    const resolved = resolveStandardsIris(DEFAULT_PROJECT_STANDARDS, {});
    expect(resolved.defaultOntologyBaseIri).toBe(DEFAULT_PROJECT_STANDARDS.defaultOntologyBaseIri);
  });
});
