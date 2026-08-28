import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseTurtle } from '../rdf/parseDocument';
import { loadRegistry } from './registryLoader';
import { mergeResultRows } from './merge';
import { runSparqlChecks } from './sparqlRunner';
import { runShaclChecks } from './shaclRunner';
import type { ResultRow } from '../types';

/**
 * `QUA-009` counts `skos:prefLabel` *per language*, not outright. Ported from
 * `consolidated_ontology_suite_python/tests/test_qua009_pref_label_cardinality.py`.
 *
 * The check was first written as "exactly one skos:prefLabel, full stop". That is
 * wrong about SKOS, which defines prefLabel as unique per language tag -- a
 * bilingual ontology carrying `"Road"@en` and `"Ffordd"@cy` is correct, and a
 * check flagging it would be enforcing a rule SKOS does not have.
 *
 * The subtlety worth its own module is the **untagged** case. SHACL's
 * `sh:uniqueLang` compares language tags, and two untagged literals do not share
 * a tag, so they pass it. But untagged is precisely how gist-based ontologies
 * label everything (`"Event"^^xsd:string`), so relying on `sh:uniqueLang` alone
 * would let the commonest form of the defect through in exactly the ontologies
 * this suite is aimed at. The shape pairs it with a qualified cardinality on
 * `xsd:string`; the `.rq` twin gets the same effect from `LANG()` returning `""`.
 *
 * Every assertion runs against both engines, because this is a case where they
 * could easily disagree: the constraint is SHACL core on one side and an
 * aggregate query on the other.
 */
const FIXTURE = `
@prefix owl:  <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix xsd:  <http://www.w3.org/2001/XMLSchema#> .
@prefix skos: <http://www.w3.org/2004/02/skos/core#> .
@prefix ex:   <https://example.org/langs/> .

<https://example.org/langs> a owl:Ontology ;
  owl:versionIRI <https://example.org/langs/1.0.0> ;
  rdfs:label "language fixture"@en ;
  skos:prefLabel "language fixture"@en .

# --- must NOT be reported -------------------------------------------------
ex:OneTagged   a owl:Class ; skos:prefLabel "One"@en .
ex:OneUntagged a owl:Class ; skos:prefLabel "One" .
ex:Bilingual   a owl:Class ; skos:prefLabel "Road"@en , "Ffordd"@cy .
ex:Trilingual  a owl:Class ; skos:prefLabel "Road"@en , "Ffordd"@cy , "Rathad"@gd .
ex:TaggedPlusPlain a owl:Class ; skos:prefLabel "Road"@en , "Road" .

# --- must be reported -----------------------------------------------------
ex:NoLabel       a owl:Class .
ex:TwoSameTag    a owl:Class ; skos:prefLabel "Road"@en , "Roadway"@en .
ex:TwoUntagged   a owl:Class ; skos:prefLabel "Road" , "Roadway" .
ex:ThreeUntagged a owl:Class ; skos:prefLabel "A" , "B" , "C" .
`;

const SHOULD_FIRE = ['NoLabel', 'ThreeUntagged', 'TwoSameTag', 'TwoUntagged'];
const SHOULD_PASS = ['Bilingual', 'OneTagged', 'OneUntagged', 'TaggedPlusPlain', 'Trilingual'];

const registry = loadRegistry(path.resolve(__dirname, '../../resources/checks-registry'));
const { quads } = parseTurtle('file:///langs.ttl', FIXTURE);
const ENGINES: [string, ResultRow[]][] = [
  ['sparql', runSparqlChecks(quads, registry)],
  ['shacl', runShaclChecks(quads, registry)],
];

const firedIn = (rows: ResultRow[]) =>
  [...new Set(rows.filter((r) => r.checkId === 'QUA-009').map((r) => r.focusNode.split('/').pop() as string))].sort();

describe('QUA-009 counts prefLabels per language', () => {
  it.each(ENGINES)('%s reports exactly the terms that break the rule', (_engine, rows) => {
    expect(firedIn(rows)).toEqual(SHOULD_FIRE);
  });

  it.each(ENGINES)('%s does not report a term that is correct SKOS', (_engine, rows) => {
    // SKOS permits one prefLabel per language, so a bilingual or trilingual term
    // is correct -- and so is one tagged label alongside one untagged.
    expect(firedIn(rows).filter((t) => SHOULD_PASS.includes(t))).toEqual([]);
  });

  it.each(ENGINES)('%s catches untagged duplicates, which sh:uniqueLang alone does not', (_engine, rows) => {
    // uniqueLang compares tags and neither value has one. gist labels every term
    // untagged, so this is the case that matters most in practice and the one a
    // naive shape misses.
    expect(firedIn(rows)).toContain('TwoUntagged');
    expect(firedIn(rows)).toContain('ThreeUntagged');
  });

  it('the two engines agree', () => {
    // SHACL core on one side, an aggregate query on the other, so agreement here
    // is a real signal rather than a tautology.
    expect(firedIn(ENGINES[0][1])).toEqual(firedIn(ENGINES[1][1]));
  });

  it('merges into one row per term rather than one per engine', () => {
    // Only true because both formulations bind the same sh:resultPath and no
    // sh:value -- the dedup key in merge.ts.
    const rows = mergeResultRows(ENGINES[0][1], ENGINES[1][1]).filter((r) => r.checkId === 'QUA-009');
    expect(rows.length).toBe(SHOULD_FIRE.length);
    for (const row of rows) {
      expect(row.sources.sort()).toEqual(['shacl', 'sparql']);
      expect(row.path).toBe('http://www.w3.org/2004/02/skos/core#prefLabel');
    }
  });

  it('says which of the two failures it found', () => {
    const rows = new Map(
      ENGINES[0][1].filter((r) => r.checkId === 'QUA-009').map((r) => [r.focusNode.split('/').pop() as string, r]),
    );
    expect(rows.get('NoLabel')?.message).toContain('no skos:prefLabel');
    expect(rows.get('TwoUntagged')?.message).toContain('untagged');
    expect(rows.get('TwoSameTag')?.message).toContain('@en');
  });
});
