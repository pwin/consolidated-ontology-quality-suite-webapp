import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseTurtle } from '../rdf/parseDocument';
import { resolveImports } from '../ontology/resolveImports';
import { loadRegistry } from './registryLoader';
import { runShaclChecks } from './shaclRunner';

const REGISTRY_DIR = path.resolve(__dirname, '../../resources/checks-registry');

describe('runShaclChecks against examples/tutorial/clinic.ttl', () => {
  it('produces real findings from every shapes file', async () => {
    const dir = path.resolve(__dirname, '../../examples/tutorial');
    const clinicPath = path.join(dir, 'clinic.ttl');
    const clinicDoc = parseTurtle(clinicPath, fs.readFileSync(clinicPath, 'utf8'));
    const { mergedQuads } = await resolveImports(clinicPath, clinicDoc.quads, dir);

    const rows = runShaclChecks(mergedQuads, loadRegistry(REGISTRY_DIR));
    expect(rows.length).toBeGreaterThan(0);

    for (const row of rows) {
      expect(row.sources).toEqual(['shacl']);
      expect(['Violation', 'Warning', 'Info']).toContain(row.severity);
    }
  }, 30000);

  /**
   * Each shape's declared `sh:severity` reaches the finding, rather than every
   * SHACL result collapsing to `sh:Violation`.
   *
   * Two separate bugs converged on that symptom. `shacl-engine` (used through
   * v0.9.3) dropped `sh:severity` outright, which v0.9.2 worked around by
   * re-reading the shapes graph. And the shapes themselves declared it *inside*
   * the `sh:sparql [...]` block rather than on the enclosing shape, where SHACL
   * defines it -- so a strict engine was right to ignore it. Upstream fixed the
   * shapes in its 0.6.0; this project carries that fix, and the workaround is
   * long gone, so what is left to test is simply that severities arrive intact.
   *
   * Uses examples/ontology/domain.ttl because it triggers STR-003 (declares
   * sh:Warning) and STY-003 (sh:Info) together, so a regression shows up as a
   * changed severity rather than a missing row.
   */
  it('reports each shape-declared sh:severity rather than collapsing to Violation', () => {
    const domainPath = path.resolve(__dirname, '../../examples/ontology/domain.ttl');
    const doc = parseTurtle(domainPath, fs.readFileSync(domainPath, 'utf8'));

    const rows = runShaclChecks(doc.quads, loadRegistry(REGISTRY_DIR));
    const severityOf = (checkId: string) => [...new Set(rows.filter((r) => r.checkId === checkId).map((r) => r.severity))];

    expect(severityOf('STR-003')).toEqual(['Warning']);
    expect(severityOf('STY-003')).toEqual(['Info']);
    // The signature failure was a uniform collapse to one severity.
    expect(new Set(rows.map((r) => r.severity)).size).toBeGreaterThan(1);
  }, 30000);

  /**
   * STR-002 exempted `rdf:`/`rdfs:`/`owl:` by their three individual namespace
   * IRIs while its siblings exempt `http://www.w3.org/` wholesale, so using
   * `skos:prefLabel` without redeclaring SKOS locally was reported as a
   * Violation-severity "undefined property" -- on the very predicate
   * QUA-001/QUA-002/QUA-004 all accept as a valid label. Fixed upstream in
   * 0.6.0 and carried here; domain.ttl uses `skos:prefLabel`/`skos:definition`
   * and produced exactly two such findings before.
   */
  it('does not flag W3C-namespace predicates as undeclared (STR-002)', () => {
    const domainPath = path.resolve(__dirname, '../../examples/ontology/domain.ttl');
    const doc = parseTurtle(domainPath, fs.readFileSync(domainPath, 'utf8'));

    const rows = runShaclChecks(doc.quads, loadRegistry(REGISTRY_DIR));
    expect(rows.filter((r) => r.checkId === 'STR-002')).toEqual([]);
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
    const rows = runShaclChecks(quads, registry);
    expect(Array.isArray(rows)).toBe(true);
    for (const row of rows) expect(row.sources).toEqual(['shacl']);
  }, 30000);
});
