import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseTurtle } from '../rdf/parseDocument';
import { resolveImports } from '../ontology/resolveImports';
import { loadRegistry } from './registryLoader';
import { runSparqlChecks } from './sparqlRunner';

describe('runSparqlChecks against examples/tutorial/clinic.ttl', () => {
  it('finds real findings with correctly-resolved check metadata', async () => {
    const dir = path.resolve(__dirname, '../../examples/tutorial');
    const clinicPath = path.join(dir, 'clinic.ttl');
    const clinicDoc = parseTurtle(clinicPath, fs.readFileSync(clinicPath, 'utf8'));
    const { mergedQuads } = await resolveImports(clinicPath, clinicDoc.quads, dir);
    const registry = loadRegistry(path.resolve(__dirname, '../../resources/checks-registry'));

    const rows = runSparqlChecks(mergedQuads, registry);
    expect(rows.length).toBeGreaterThan(0);

    for (const row of rows) {
      expect(row.checkId).toMatch(/^[A-Z]{3}-\d{3}$/);
      expect(row.category).not.toBeNull();
      expect(['Violation', 'Warning', 'Info']).toContain(row.severity);
      expect(row.focusNode.length).toBeGreaterThan(0);
      expect(row.sources).toEqual(['sparql']);
    }
  });

  it('flags a graph with no owl:Ontology declaration at all (QUA-005) -- that absence is itself a real finding', () => {
    const registry = loadRegistry(path.resolve(__dirname, '../../resources/checks-registry'));
    const rows = runSparqlChecks([], registry);
    expect(rows.map((r) => r.checkId)).toEqual(['QUA-005']);
  });
});
