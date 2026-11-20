import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseTurtle } from '../rdf/parseDocument';
import { loadRegistry } from './registryLoader';
import { runSparqlChecks } from './sparqlRunner';

/**
 * `CNF-003`/`CNF-004` accept a domain or range declared as an `owl:unionOf`.
 *
 * A union is an anonymous class node:
 *
 *     ex:locatedIn rdfs:domain [ a owl:Class ; owl:unionOf ( ex:Site ex:Region ) ] .
 *
 * and both queries decided whether a subject or value satisfied a declared
 * class by walking `?matchType rdfs:subClassOf* ?dc`. No asserted type can
 * reach a blank node that way, so the `FILTER NOT EXISTS` always succeeded
 * and *every* use of a union-domained property was reported as a violation,
 * every value of a union-ranged one likewise.
 *
 * This is not a corner case. gist declares 13 anonymous domains and ranges
 * and every one is a union; so are all three in the W3C org vocabulary
 * (`org:reportsTo`, `org:role`). The defect was reported from a project whose
 * `locatedIn` and `founded` are declared exactly this way.
 *
 * The fix is one property path -- `owl:unionOf`, then the list, repeated zero
 * or more times -- which steps from the declared class expression into its
 * union members: zero steps leaves a named class alone, one reaches each
 * member, more handle a union nested inside a union. (Written out rather than
 * quoted here because the path contains the two characters that close a block
 * comment.)
 *
 * The third and fourth cases are the ones that matter most. A fix that simply
 * stopped reporting would be worse than the bug, because a clean report and a
 * correct ontology look identical -- so data matching *no* member must still
 * be caught, on both sides.
 */
const REGISTRY_DIR = path.resolve(__dirname, '../../resources/checks-registry');
const registry = loadRegistry(REGISTRY_DIR);
const EX = 'https://example.org/trail/';

const ONTOLOGY = `
  @prefix owl:  <http://www.w3.org/2002/07/owl#> .
  @prefix rdf:  <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
  @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
  @prefix gist: <https://w3id.org/semanticarts/ns/ontology/gist/> .
  @prefix ex:   <https://example.org/trail/> .

  ex:Site   a owl:Class .
  ex:Region a owl:Class .
  ex:Era    a owl:Class .
  ex:Person a owl:Class .
  ex:Priory a owl:Class ; rdfs:subClassOf ex:Site .

  # A union on both sides -- the org:reportsTo pattern.
  ex:locatedIn a owl:ObjectProperty ;
    rdfs:domain [ a owl:Class ; owl:unionOf ( ex:Site ex:Region ) ] ;
    rdfs:range  [ a owl:Class ; owl:unionOf ( ex:Region ex:Era ) ] .

  # A union nested in a union, to pin that the path recurses rather than
  # expanding one level and leaving a blank node behind.
  ex:founded a owl:ObjectProperty ;
    rdfs:domain [ a owl:Class ; owl:unionOf ( ex:Site [ a owl:Class ; owl:unionOf ( ex:Region ex:Era ) ] ) ] ;
    rdfs:range  ex:Era .

  # A plain named domain and range, which always worked and must keep working.
  ex:custodian a owl:ObjectProperty ;
    rdfs:domain ex:Site ;
    rdfs:range  ex:Person .

  # The gist convention, which may carry a union too.
  ex:sitedIn a owl:ObjectProperty ;
    gist:domainIncludes [ a owl:Class ; owl:unionOf ( ex:Site ex:Region ) ] .
`;

function focusNodes(checkId: string, data: string): string[] {
  const { quads } = parseTurtle('file:///union-conformance.ttl', ONTOLOGY + data);
  const rows = runSparqlChecks(quads, registry).filter((r) => r.checkId === checkId);
  return [...new Set(rows.map((r) => r.focusNode))].sort();
}

describe('CNF-003/CNF-004 against a union domain or range', () => {
  it('reports nothing when the subject and value are each in one union member', () => {
    const data = `
      @prefix ex: <https://example.org/trail/> .
      ex:abbey     a ex:Site   ; ex:locatedIn ex:northVale .
      ex:northVale a ex:Region ; ex:locatedIn ex:medieval .
      ex:medieval  a ex:Era .
    `;
    expect(focusNodes('CNF-003', data)).toEqual([]);
    expect(focusNodes('CNF-004', data)).toEqual([]);
  });

  it('reports nothing for a subclass of a union member', () => {
    // The union is expanded before the subclass walk, not instead of it.
    const data = `
      @prefix ex: <https://example.org/trail/> .
      ex:abbey     a ex:Priory ; ex:locatedIn ex:northVale .
      ex:northVale a ex:Region .
    `;
    expect(focusNodes('CNF-003', data)).toEqual([]);
  });

  it('still reports a subject in no union member', () => {
    expect(focusNodes('CNF-003', `
      @prefix ex: <https://example.org/trail/> .
      ex:ada a ex:Person ; ex:locatedIn ex:northVale .
      ex:northVale a ex:Region .
    `)).toEqual([`${EX}ada`]);
  });

  it('still reports a value in no union member', () => {
    // CNF-004's focus node is the subject carrying the offending value, with
    // the value itself on sh:value -- see registryParity.test.ts for why this
    // differs from the Python suite's choice of focus.
    expect(focusNodes('CNF-004', `
      @prefix ex: <https://example.org/trail/> .
      ex:abbey a ex:Site ; ex:locatedIn ex:ada .
      ex:ada   a ex:Person .
    `)).toEqual([`${EX}abbey`]);
  });

  it('expands a union nested inside a union', () => {
    expect(focusNodes('CNF-003', `
      @prefix ex: <https://example.org/trail/> .
      ex:northVale a ex:Region ; ex:founded ex:medieval .
      ex:medieval  a ex:Era .
    `)).toEqual([]);
  });

  it('leaves a plain named domain and range behaving as before', () => {
    const conforming = `
      @prefix ex: <https://example.org/trail/> .
      ex:abbey a ex:Site ; ex:custodian ex:ada .
      ex:ada   a ex:Person .
    `;
    expect(focusNodes('CNF-003', conforming)).toEqual([]);
    expect(focusNodes('CNF-004', conforming)).toEqual([]);

    expect(focusNodes('CNF-003', `
      @prefix ex: <https://example.org/trail/> .
      ex:ada a ex:Person ; ex:custodian ex:bob .
      ex:bob a ex:Person .
    `)).toEqual([`${EX}ada`]);
  });

  it('expands a union carried by a gist domainIncludes annotation', () => {
    expect(focusNodes('CNF-003', `
      @prefix ex: <https://example.org/trail/> .
      ex:abbey a ex:Site ; ex:sitedIn ex:northVale .
      ex:northVale a ex:Region .
    `)).toEqual([]);
  });
});
