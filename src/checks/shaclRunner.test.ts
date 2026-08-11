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

  /**
   * Regression test for the dropped-`sh:severity` bug (see extractDeclaredSeverities in
   * shaclRunner.ts): `shacl-engine` reports every `sh:sparql`-constraint result as
   * `sh:Violation`, ignoring the `sh:severity` the shape declares inside that block. Before the
   * fix, all 11 findings here came back `Violation` and 8 of them survived the merge into the
   * Problems panel as red errors that the registry says are Info/Warning.
   *
   * Uses examples/ontology/domain.ttl (not clinic.ttl) because it's the fixture that actually
   * triggers STR-003 (declares sh:Warning) and STY-003 (declares sh:Info) together, so a
   * regression would show up as a real severity change rather than only as a missing row.
   */
  it('honors the sh:severity a shape declares inside its sh:sparql block, which the engine itself drops', async () => {
    const domainPath = path.resolve(__dirname, '../../examples/ontology/domain.ttl');
    const doc = parseTurtle(domainPath, fs.readFileSync(domainPath, 'utf8'));
    const registry = loadRegistry(path.resolve(__dirname, '../../resources/checks-registry'));

    const rows = await runShaclChecks(doc.quads, registry);
    const severityOf = (checkId: string) => [...new Set(rows.filter((r) => r.checkId === checkId).map((r) => r.severity))];

    expect(severityOf('STR-003')).toEqual(['Warning']);
    expect(severityOf('STY-003')).toEqual(['Info']);
    expect(severityOf('STR-002')).toEqual(['Violation']);
    // The bug's signature was a uniform collapse to Violation -- assert the spread survives.
    expect(new Set(rows.map((r) => r.severity)).size).toBeGreaterThan(1);
  }, 30000);
});
