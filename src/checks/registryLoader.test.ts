import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadRegistry, localName } from './registryLoader';

describe('loadRegistry against the vendored resources/checks-registry', () => {
  const registry = loadRegistry(path.resolve(__dirname, '../../resources/checks-registry'));

  it('loads all 50 registry.json checks', () => {
    expect(registry.checksById.size).toBe(50);
    expect(registry.checksById.get('STR-001')?.category).toBe('structural');
  });

  it('finds sparql/**/*.rq and shapes/*.ttl files', () => {
    expect(registry.sparqlFiles.length).toBeGreaterThan(30);
    expect(registry.shaclFiles).toHaveLength(6);
  });
});

describe('localName', () => {
  it('extracts the local name after # or /', () => {
    expect(localName('https://semantechs.co.uk/ontology-quality/STR-001')).toBe('STR-001');
    expect(localName('http://example.org/ns#Foo')).toBe('Foo');
  });
});
