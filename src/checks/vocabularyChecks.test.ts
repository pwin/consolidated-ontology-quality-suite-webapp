import * as fs from 'node:fs';
import * as path from 'node:path';
import { DataFactory } from 'n3';
import { describe, expect, it } from 'vitest';
import { parseTurtle } from '../rdf/parseDocument';
import { resolveImports } from '../ontology/resolveImports';
import { runVocabularyChecks } from './vocabularyChecks';

const { namedNode, quad } = DataFactory;
const EX = 'http://example.org/clinic#';
const RDFS_SUBCLASS_OF = 'http://www.w3.org/2000/01/rdf-schema#subClassOf';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

async function loadClinicQuads() {
  const dir = path.resolve(__dirname, '../../examples/tutorial');
  const clinicPath = path.join(dir, 'clinic.ttl');
  const clinicDoc = parseTurtle(clinicPath, fs.readFileSync(clinicPath, 'utf8'));
  return (await resolveImports(clinicPath, clinicDoc.quads, dir)).mergedQuads;
}

describe('runVocabularyChecks', () => {
  it('produces zero findings against a real, valid, imports-resolved ontology', async () => {
    const mergedQuads = await loadClinicQuads();
    expect(runVocabularyChecks(mergedQuads)).toEqual([]);
  });

  it('flags a typo in an object-position term reference (rdfs:subClassOf) against a namespace it has closed-world knowledge of', async () => {
    const mergedQuads = await loadClinicQuads();
    const withTypo = [...mergedQuads, quad(namedNode(`${EX}Dog`), namedNode(RDFS_SUBCLASS_OF), namedNode(`${EX}Mammall`))];

    const rows = runVocabularyChecks(withTypo);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ checkId: 'VOC-001', focusNode: `${EX}Dog`, path: RDFS_SUBCLASS_OF, value: `${EX}Mammall` });
  });

  /**
   * The predicate position is STR-002's and the rdf:type object is STR-001's.
   *
   * Both were reported here too, so an undeclared predicate arrived as STR-002 *and*
   * VOC-001, and an undeclared type as STR-001 *and* VOC-001 -- with, in the type
   * case, an identical focus node and value, so the two rows differed only by id.
   * Neither of those checks applies the namespace guard below, so they were already
   * reporting a superset of what this could: nothing is lost by standing down, and a
   * duplicate per defect is gone.
   */
  it('leaves the predicate position to STR-002', async () => {
    const mergedQuads = await loadClinicQuads();
    const withTypo = [...mergedQuads, quad(namedNode(`${EX}Dog`), namedNode(`${EX}hasOwnerx`), namedNode(`${EX}Owner`))];

    expect(runVocabularyChecks(withTypo)).toEqual([]);
  });

  it('leaves the rdf:type object to STR-001', async () => {
    const mergedQuads = await loadClinicQuads();
    const withTypo = [...mergedQuads, quad(namedNode(`${EX}rex`), namedNode(RDF_TYPE), namedNode(`${EX}Dogg`))];

    expect(runVocabularyChecks(withTypo)).toEqual([]);
  });

  it('does not flag a namespace with zero closed-world knowledge (never imported/declared here)', async () => {
    const mergedQuads = await loadClinicQuads();
    const withExternalRef = [...mergedQuads, quad(namedNode(`${EX}Dog`), namedNode('http://purl.org/dc/terms/creator'), namedNode('http://example.org/people#alice'))];

    expect(runVocabularyChecks(withExternalRef)).toEqual([]);
  });

  it('does not flag standard rdf/rdfs/owl/xsd vocabulary usage', () => {
    const quads = [
      quad(namedNode(`${EX}Widget`), namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#type'), namedNode('http://www.w3.org/2002/07/owl#Class')),
      quad(namedNode(`${EX}hasCount`), namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#type'), namedNode('http://www.w3.org/2002/07/owl#DatatypeProperty')),
      quad(namedNode(`${EX}hasCount`), namedNode('http://www.w3.org/2000/01/rdf-schema#range'), namedNode('http://www.w3.org/2001/XMLSchema#integer')),
    ];
    expect(runVocabularyChecks(quads)).toEqual([]);
  });

  it('dedupes repeated occurrences of the same (subject, predicate, undeclared term) triple', async () => {
    const mergedQuads = await loadClinicQuads();
    const sameTypoTwice = [
      ...mergedQuads,
      quad(namedNode(`${EX}Dog`), namedNode(RDFS_SUBCLASS_OF), namedNode(`${EX}Mammall`)),
      quad(namedNode(`${EX}Dog`), namedNode(RDFS_SUBCLASS_OF), namedNode(`${EX}Mammall`)),
    ];
    expect(runVocabularyChecks(sameTypoTwice)).toHaveLength(1);
  });

  it('is severity Warning, not Violation/Hint -- a strong-but-not-certain signal', async () => {
    const mergedQuads = await loadClinicQuads();
    const withTypo = [...mergedQuads, quad(namedNode(`${EX}Dog`), namedNode(RDFS_SUBCLASS_OF), namedNode(`${EX}Mammall`))];
    expect(runVocabularyChecks(withTypo)[0].severity).toBe('Warning');
  });
});
