import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseTurtle } from '../rdf/parseDocument';
import { resolveImports } from '../ontology/resolveImports';
import { loadRegistry } from './registryLoader';
import { runShaclChecks } from './shaclRunner';

describe('runShaclChecks against examples/tutorial/clinic.ttl', () => {
  it('produces real findings from the shapes files that succeed, degrading gracefully for any that crash', async () => {
    const dir = path.resolve(__dirname, '../../examples/tutorial');
    const clinicPath = path.join(dir, 'clinic.ttl');
    const clinicDoc = parseTurtle(clinicPath, fs.readFileSync(clinicPath, 'utf8'));
    const { mergedQuads } = await resolveImports(clinicPath, clinicDoc.quads, dir);
    const registry = loadRegistry(path.resolve(__dirname, '../../resources/checks-registry'));

    // Must not throw even though some of the six shape files are known (see shaclRunner.ts's
    // module doc comment) to crash shacl-engine's SPARQL plugin on some graphs -- per-file
    // isolation means the run still completes and returns whatever succeeded.
    const rows = await runShaclChecks(mergedQuads, registry);
    expect(rows.length).toBeGreaterThan(0);

    for (const row of rows) {
      expect(row.sources).toEqual(['shacl']);
      expect(['Violation', 'Warning', 'Info']).toContain(row.severity);
    }
  }, 30000);
});
