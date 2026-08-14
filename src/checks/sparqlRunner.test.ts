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

/**
 * Regression tests for three check-query bugs fixed upstream in
 * `consolidated_ontology_suite_python` and ported here. All three were confirmed to
 * reproduce under *this* project's own engine (Oxigraph) before porting -- not assumed
 * from the upstream report, which was driven by rdflib/pyshacl behavior.
 *
 * Two of them (DAT-001, EFF-002) are the same failure mode this project already hit
 * while writing CNF-003/004: a `UNION` whose branches contain only `FILTER`/`BIND` and
 * no triple pattern of their own silently matches nothing, so the check never fires at
 * all -- a false negative that looks exactly like "the graph is clean".
 */
const registryDir = path.resolve(__dirname, '../../resources/checks-registry');
const focusNodesFor = (rows: ReturnType<typeof runSparqlChecks>, checkId: string) =>
  [...new Set(rows.filter((r) => r.checkId === checkId).map((r) => r.focusNode))].sort();

describe('check-query regressions ported from consolidated_ontology_suite_python', () => {
  it('DAT-001 fires on literals whose lexical form contradicts their datatype', () => {
    const ttl = `
      @prefix ex: <http://example.org/demo#> .
      @prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
      ex:a ex:birthDate "not-a-date"^^xsd:date .
      ex:b ex:count "twelve"^^xsd:integer .
      ex:c ex:flag "maybe"^^xsd:boolean .
      ex:ok1 ex:birthDate "2020-01-10"^^xsd:date .
      ex:ok2 ex:count "12"^^xsd:integer .
    `;
    const { quads } = parseTurtle('file:///dat001.ttl', ttl);
    const rows = runSparqlChecks(quads, loadRegistry(registryDir));

    // Before the fix this was [] -- the UNION-of-bare-FILTER branches matched nothing.
    expect(focusNodesFor(rows, 'DAT-001')).toEqual([
      'http://example.org/demo#a',
      'http://example.org/demo#b',
      'http://example.org/demo#c',
    ]);
  });

  it('EFF-002 fires on a graph whose blank-node ratio exceeds the 20% threshold', () => {
    // 5 named subjects each pointing at their own blank node => 5/10 distinct nodes blank.
    let ttl = '@prefix ex: <http://example.org/demo#> .\n@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .\n';
    for (let i = 0; i < 5; i++) ttl += `ex:s${i} ex:has [ rdfs:label "b${i}" ] .\n`;
    const { quads } = parseTurtle('file:///eff002.ttl', ttl);
    const rows = runSparqlChecks(quads, loadRegistry(registryDir));

    // Before the fix this was [] at any ratio -- same UNION-of-bare-BIND problem.
    const eff = rows.filter((r) => r.checkId === 'EFF-002');
    expect(eff.length).toBe(1);
    expect(eff[0].message).toContain('50%');
  });

  it('STY-004 strips every non-alphanumeric from the URI, not just underscores, before comparing to the label', () => {
    const ttl = `
      @prefix ex: <http://example.org/demo#> .
      @prefix owl: <http://www.w3.org/2002/07/owl#> .
      @prefix skos: <http://www.w3.org/2004/02/skos/core#> .
      ex:has-name a owl:Class ; skos:prefLabel "has name" .
      ex:has_address a owl:Class ; skos:prefLabel "has address" .
      ex:widget a owl:Class ; skos:prefLabel "Completely Different" .
    `;
    const { quads } = parseTurtle('file:///sty004.ttl', ttl);
    const rows = runSparqlChecks(quads, loadRegistry(registryDir));

    // Before the fix `ex:has-name` was a false positive: the URI side stripped only `_`,
    // so its hyphen survived and never matched the fully-stripped label.
    expect(focusNodesFor(rows, 'STY-004')).toEqual(['http://example.org/demo#widget']);
  });
});
