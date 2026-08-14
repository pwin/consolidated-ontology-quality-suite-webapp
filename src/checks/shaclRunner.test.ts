import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseTurtle } from '../rdf/parseDocument';
import { resolveImports } from '../ontology/resolveImports';
import { loadRegistry } from './registryLoader';
import { runShaclChecks } from './shaclRunner';

/** Stands in for the extension's install directory; the repo root is that directory in-tree. */
const EXTENSION_PATH = path.resolve(__dirname, '../..');
const REGISTRY_DIR = path.resolve(__dirname, '../../resources/checks-registry');

describe('runShaclChecks against examples/tutorial/clinic.ttl', () => {
  it('produces real findings from every shapes file', async () => {
    const dir = path.resolve(__dirname, '../../examples/tutorial');
    const clinicPath = path.join(dir, 'clinic.ttl');
    const clinicDoc = parseTurtle(clinicPath, fs.readFileSync(clinicPath, 'utf8'));
    const { mergedQuads } = await resolveImports(clinicPath, clinicDoc.quads, dir);

    const rows = runShaclChecks(mergedQuads, loadRegistry(REGISTRY_DIR), EXTENSION_PATH);
    expect(rows.length).toBeGreaterThan(0);

    for (const row of rows) {
      expect(row.sources).toEqual(['shacl']);
      expect(['Violation', 'Warning', 'Info']).toContain(row.severity);
    }
  }, 30000);

  /**
   * `sh:severity` declared inside an `sh:sparql` block. The previous engine
   * (`shacl-engine`) dropped it and reported everything as `sh:Violation`, which
   * v0.9.2 had to work around by reading the shapes graph directly; `shacl-wasm`
   * reports it itself, so this now tests the engine rather than a workaround.
   *
   * Uses examples/ontology/domain.ttl because it is the fixture that triggers
   * STR-003 (declares sh:Warning) and STY-003 (sh:Info) together, so a
   * regression shows up as a changed severity rather than a missing row.
   */
  it('honours the sh:severity a shape declares inside its sh:sparql block', () => {
    const domainPath = path.resolve(__dirname, '../../examples/ontology/domain.ttl');
    const doc = parseTurtle(domainPath, fs.readFileSync(domainPath, 'utf8'));

    const rows = runShaclChecks(doc.quads, loadRegistry(REGISTRY_DIR), EXTENSION_PATH);
    const severityOf = (checkId: string) => [...new Set(rows.filter((r) => r.checkId === checkId).map((r) => r.severity))];

    expect(severityOf('STR-003')).toEqual(['Warning']);
    expect(severityOf('STY-003')).toEqual(['Info']);
    expect(severityOf('STR-002')).toEqual(['Violation']);
    // The old engine's signature failure was a uniform collapse to Violation.
    expect(new Set(rows.map((r) => r.severity)).size).toBeGreaterThan(1);
  }, 30000);

  /**
   * `shapes/data.ttl` and `shapes/efficiency.ttl` threw `Tried to bind variable
   * ?this in a GROUP BY operator` under `shacl-engine`, taking out every check
   * in both files -- `DAT-001` and `EFF-002` could not fire through the SHACL
   * path at all. Compiling all six is the property that regressed silently
   * before, so it is asserted directly rather than inferred from a finding count.
   */
  it('compiles and runs every shapes file, including the two the previous engine crashed on', () => {
    const registry = loadRegistry(REGISTRY_DIR);
    expect(registry.shaclFiles.length).toBe(6);

    const ttl = `
      @prefix ex: <http://example.org/demo#> .
      @prefix owl: <http://www.w3.org/2002/07/owl#> .
      @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
      @prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
      ex:Thing a owl:Class ; rdfs:label "Thing" .
      ex:a ex:birthDate "not-a-date"^^xsd:date .
    `;
    const { quads } = parseTurtle('file:///f.ttl', ttl);

    // Any shapes file failing to compile is logged and skipped, so it would show
    // up here only as absent findings. Assert the run completes and produces rows.
    const rows = runShaclChecks(quads, registry, EXTENSION_PATH);
    expect(Array.isArray(rows)).toBe(true);
    for (const row of rows) expect(row.sources).toEqual(['shacl']);
  }, 30000);
});
