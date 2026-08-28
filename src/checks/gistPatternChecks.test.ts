import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseTurtle } from '../rdf/parseDocument';
import { loadRegistry } from './registryLoader';
import { mergeResultRows } from './merge';
import { runSparqlChecks } from './sparqlRunner';
import { runShaclChecks } from './shaclRunner';
import type { ResultRow } from '../types';

/**
 * `QUA-009`, `QUA-010` and `DAT-004`, ported from
 * `consolidated_ontology_suite_python` 0.9.0 along with its
 * `examples/gist_patterns/` fixture, which seeds one case per check.
 *
 * The fixture is what makes this worth asserting as an exact set rather than a
 * count. This suite has four times shipped a check whose query quietly matched
 * nothing, which looks exactly like a clean graph -- and both of the negative
 * cases below (`ex:Bridge`, `exd:MagnitudeLinkLength`) are ones an over-eager
 * formulation would report.
 *
 * Each check has two independent formulations, a SPARQL CONSTRUCT and a SHACL
 * shape, run by different engines (Oxigraph and shacl-wasm). Comparing them is
 * the point: two copies of the same SPARQL agree even when both are wrong.
 */
const REGISTRY_DIR = path.resolve(__dirname, '../../resources/checks-registry');
const FIXTURE_DIR = path.resolve(__dirname, '../../examples/gist_patterns');
const EX = 'https://example.org/gistpatterns/';

function fixtureQuads() {
  return ['ontology.ttl', 'data.ttl'].flatMap((name) => {
    const file = path.join(FIXTURE_DIR, name);
    return parseTurtle(file, fs.readFileSync(file, 'utf8')).quads;
  });
}

const focusNodesFor = (rows: ResultRow[], checkId: string) =>
  [...new Set(rows.filter((r) => r.checkId === checkId).map((r) => r.focusNode))].sort();

describe('QUA-009 / QUA-010 / DAT-004 against examples/gist_patterns', () => {
  const registry = loadRegistry(REGISTRY_DIR);
  const quads = fixtureQuads();
  const sparqlRows = runSparqlChecks(quads, registry);
  const shaclRows = runShaclChecks(quads, registry);

  it('registers all three checks', () => {
    for (const id of ['QUA-009', 'QUA-010', 'DAT-004']) expect(registry.checksById.has(id)).toBe(true);
  });

  it('QUA-009 fires for a missing prefLabel and for two sharing one language, tagged or not', () => {
    const expected = [
      `${EX}Carriageway`, // no skos:prefLabel at all (it has an rdfs:label, which QUA-001/QUA-004 accept)
      `${EX}Verge`, // two untagged values -- sh:uniqueLang alone does not see these
      `${EX}hasCarriageway`, // two values both tagged @en
    ].sort();
    expect(focusNodesFor(sparqlRows, 'QUA-009')).toEqual(expected);
    expect(focusNodesFor(shaclRows, 'QUA-009')).toEqual(expected);
  });

  it('QUA-009 does not fire on two prefLabels in different languages', () => {
    // SKOS defines prefLabel as unique *per language*, so "Bridge"@en + "Pont"@cy
    // is correct. Flagging it would be wrong about SKOS rather than strict about
    // it -- and the earlier `sh:maxCount 1` formulation did exactly that.
    for (const rows of [sparqlRows, shaclRows]) {
      expect(focusNodesFor(rows, 'QUA-009')).not.toContain(`${EX}Bridge`);
    }
  });

  it('QUA-010 asks for prose, not axioms -- so it fires where STR-004 does not', () => {
    // ex:Motorway has an rdfs:subClassOf axiom, so it is formally defined and
    // STR-004 stays quiet; what it lacks is a skos:definition.
    expect(focusNodesFor(sparqlRows, 'QUA-010')).toEqual([`${EX}Motorway`]);
    expect(focusNodesFor(shaclRows, 'QUA-010')).toEqual([`${EX}Motorway`]);
    expect(focusNodesFor(sparqlRows, 'STR-004')).not.toContain(`${EX}Motorway`);
  });

  it('DAT-004 fires on a magnitude with no unit and on one whose unit is not a unit', () => {
    const expected = [`${EX}data/MagnitudeGradient`, `${EX}data/MagnitudeLaneCount`].sort();
    expect(focusNodesFor(sparqlRows, 'DAT-004')).toEqual(expected);
    expect(focusNodesFor(shaclRows, 'DAT-004')).toEqual(expected);
  });

  it('DAT-004 walks rdfs:subClassOf*, so a project subclass of gist:Magnitude is clean when it has a unit', () => {
    // exd:MagnitudeLinkLength is typed ex:LinkLength, a subclass of gist:Magnitude.
    // Without the subclass walk the check would miss every project-specific
    // magnitude, which in a real gist-based model is most of them.
    for (const rows of [sparqlRows, shaclRows]) {
      expect(focusNodesFor(rows, 'DAT-004')).not.toContain(`${EX}data/MagnitudeLinkLength`);
    }
  });

  it('merges the two engines\' copies of each finding into one row', () => {
    // Only true because both formulations report the same focus node, path and
    // value -- the property the dedup key in merge.ts rests on. Before the SHACL
    // side could resolve its check id (see shaclRunner.ts::nameNestedShapes) these
    // rows had a null id and could not merge with anything.
    const merged = mergeResultRows(sparqlRows, shaclRows);
    for (const id of ['QUA-009', 'QUA-010', 'DAT-004']) {
      const rows = merged.filter((r) => r.checkId === id);
      expect(rows.length, `${id} survived twice`).toBe(focusNodesFor(sparqlRows, id).length);
      for (const row of rows) expect(row.sources.sort()).toEqual(['shacl', 'sparql']);
    }
  });

  it('takes each severity from the registry rather than defaulting', () => {
    const merged = mergeResultRows(sparqlRows, shaclRows);
    const severityOf = (id: string) => [...new Set(merged.filter((r) => r.checkId === id).map((r) => r.severity))];

    expect(severityOf('QUA-009')).toEqual(['Warning']);
    expect(severityOf('QUA-010')).toEqual(['Warning']);
    expect(severityOf('DAT-004')).toEqual(['Violation']);
  });
});
