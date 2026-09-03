import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadRegistry, localName } from './registryLoader';

describe('loadRegistry against the copied-in resources/checks-registry', () => {
  const registry = loadRegistry(path.resolve(__dirname, '../../resources/checks-registry'));

  it('loads all 61 registry.json checks', () => {
    expect(registry.checksById.size).toBe(61);
    expect(registry.checksById.get('STR-001')?.category).toBe('structural');
    // TQL-001..003 are native (checks/../triplify/bindAnalysis.ts) and have no
    // sparql/shapes file of their own, but they are registry entries like any
    // other -- their rows resolve title/severity/remediation the same way.
    expect(registry.checksById.get('TQL-001')?.category).toBe('tarql');
    // REA-005/REA-006 and VOC-001 are likewise native, and likewise declared here:
    // an id a tier emits without a registry entry is one nothing can look up.
    // checks/registryCoverage.test.ts pins both directions of that.
    expect(registry.checksById.get('VOC-001')?.category).toBe('vocabulary');
  });

  it('finds sparql/**/*.rq and shapes/*.ttl files', () => {
    expect(registry.sparqlFiles.length).toBeGreaterThan(30);
    expect(registry.shaclFiles).toHaveLength(6);
  });

  it('keeps queries over a graph this extension does not build out of the runner', () => {
    // sparql/tarql/ reads the Python suite's BIND facts graph. Loading it into
    // `sparqlFiles` would run it against every ontology document, where it
    // matches nothing -- and would count it as an implementation this
    // extension does not have.
    expect(registry.subjectSpecificSparqlFiles.map((f) => path.basename(f)).sort())
      .toEqual(['TQL-004.rq', 'TQL-005.rq']);
    expect(registry.sparqlFiles.some((f) => f.includes('TQL-00'))).toBe(false);
  });
});

describe('localName', () => {
  it('extracts the local name after # or /', () => {
    expect(localName('https://semantechs.co.uk/ontology-quality/STR-001')).toBe('STR-001');
    expect(localName('http://example.org/ns#Foo')).toBe('Foo');
  });
});
