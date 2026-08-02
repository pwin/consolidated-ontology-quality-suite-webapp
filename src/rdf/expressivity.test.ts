import { describe, expect, it } from 'vitest';
import { Parser } from 'n3';
import { analyzeExpressivity } from './expressivity';

function quadsFor(ttl: string) {
  return new Parser().parse(
    `@prefix ex: <http://example.org/> .\n@prefix owl: <http://www.w3.org/2002/07/owl#> .\n@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .\n@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .\n${ttl}`,
  );
}

describe('analyzeExpressivity', () => {
  it('labels a plain class/datatype-property ontology as AL(D)', () => {
    const quads = quadsFor(`
      ex:Dog a owl:Class .
      ex:hasName a owl:DatatypeProperty ; rdfs:range xsd:string .
    `);
    const result = analyzeExpressivity(quads);
    expect(result.dlExpressivity).toBe('AL(D)');
    expect(result.profileMembership).toEqual({ EL: true, QL: true, RL: true });
  });

  it('owl:unionOf pushes expressivity to ALC and drops EL/QL/RL membership', () => {
    const quads = quadsFor(`
      ex:AnimalOrPlant a owl:Class ;
        owl:unionOf ( ex:Animal ex:Plant ) .
    `);
    const result = analyzeExpressivity(quads);
    expect(result.dlExpressivity).toContain('ALC');
    expect(result.profileMembership.EL).toBe(false);
    expect(result.profileMembership.QL).toBe(false);
    expect(result.profileMembership.RL).toBe(false);
  });

  it('owl:inverseOf disqualifies EL specifically', () => {
    const quads = quadsFor(`
      ex:hasOwner a owl:ObjectProperty .
      ex:isOwnedBy a owl:ObjectProperty ; owl:inverseOf ex:hasOwner .
    `);
    const result = analyzeExpressivity(quads);
    expect(result.flags.inverseRoles).toBe(true);
    expect(result.profileMembership.EL).toBe(false);
    expect(result.dlExpressivity).toContain('I');
  });

  it('a qualified cardinality restriction is flagged and labeled with Q', () => {
    const quads = quadsFor(`
      ex:Dog a owl:Class ;
        rdfs:subClassOf [
          a owl:Restriction ;
          owl:onProperty ex:hasOwner ;
          owl:onClass ex:Person ;
          owl:qualifiedCardinality "1"^^xsd:nonNegativeInteger ;
        ] .
    `);
    const result = analyzeExpressivity(quads);
    expect(result.flags.qualifiedCardinality).toBe(true);
    expect(result.dlExpressivity).toContain('Q');
  });
});
