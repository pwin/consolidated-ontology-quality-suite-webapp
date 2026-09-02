import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseTurtle } from '../rdf/parseDocument';
import { loadRegistry } from './registryLoader';
import { runSparqlChecks } from './sparqlRunner';

/**
 * `CNF-003`/`CNF-004` read gist-style `domainIncludes`/`rangeIncludes`, not
 * only `rdfs:domain`/`rdfs:range`.
 *
 * gist deliberately prefers those annotations -- `rdfs:subPropertyOf
 * skos:scopeNote`, carrying no OWL entailment -- to `rdfs:domain`/`rdfs:range`
 * for shared properties, because a formal domain forces every use of a property
 * into one class and gist's whole shape is a small set of properties reused
 * widely. A domain check that understood only `rdfs:domain` would therefore not
 * be *less sensitive* on a gist ontology: it would be dead, silently, on
 * exactly the properties the data uses most. Silence is also what a correct
 * ontology looks like, which is why this needs a test rather than a reading.
 *
 * The two queries are this extension's own, and the reason for the asymmetry
 * `registryParity.test.ts` records: the Python suite implements CNF-003/004
 * natively because its pipeline holds the ontology and the data as separate
 * graphs, while *Run Local Checks* merges a document with its resolved imports
 * into one graph before anything runs. Same check, the only route each side
 * has. The upstream implementation had the `rdfs:domain`-only blind spot until
 * the two copies of the shared registry were diffed against each other; these
 * cases are the counterpart of the ones added there.
 */
const REGISTRY_DIR = path.resolve(__dirname, '../../resources/checks-registry');
const registry = loadRegistry(REGISTRY_DIR);
const EX = 'https://example.org/g/';

// gist has published under more than one namespace IRI over the years, which is
// why both queries match these two annotations by local name. The IRI here is a
// real one; the point is that it is not special.
const ONTOLOGY = `
  @prefix owl:  <http://www.w3.org/2002/07/owl#> .
  @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
  @prefix gist: <https://w3id.org/semanticarts/ns/ontology/gist/> .
  @prefix ex:   <https://example.org/g/> .

  ex:Road      a owl:Class .
  ex:Motorway  a owl:Class ; rdfs:subClassOf ex:Road .
  ex:Bridge    a owl:Class .
  ex:Person    a owl:Class .

  # The gist convention: soft annotations, no rdfs:domain/rdfs:range at all.
  ex:hasCarriageway a owl:ObjectProperty ;
    gist:domainIncludes ex:Road ;
    gist:rangeIncludes  ex:Bridge .

  # The classic convention, for contrast -- this one always worked.
  ex:hasOwner a owl:ObjectProperty ;
    rdfs:domain ex:Road ;
    rdfs:range  ex:Person .
`;

/** The check's focus nodes on the ontology plus `data`, deduped and sorted. */
function focusNodes(checkId: string, data: string): string[] {
  const { quads } = parseTurtle('file:///gist-conformance.ttl', ONTOLOGY + data);
  const rows = runSparqlChecks(quads, registry).filter((r) => r.checkId === checkId);
  return [...new Set(rows.map((r) => r.focusNode))].sort();
}

describe('CNF-003/CNF-004 against gist-style domain and range annotations', () => {
  it('reports a domainIncludes violation', () => {
    expect(focusNodes('CNF-003', `
      @prefix ex: <https://example.org/g/> .
      ex:p1 a ex:Person . ex:b1 a ex:Bridge .
      ex:p1 ex:hasCarriageway ex:b1 .
    `)).toEqual([`${EX}p1`]);
  });

  it('reports a rangeIncludes violation', () => {
    expect(focusNodes('CNF-004', `
      @prefix ex: <https://example.org/g/> .
      ex:r1 a ex:Road . ex:p1 a ex:Person .
      ex:r1 ex:hasCarriageway ex:p1 .
    `)).toEqual([`${EX}r1`]);
  });

  it('reports nothing on conforming gist data', () => {
    // The half that stops this being a check that simply always fires.
    const data = `
      @prefix ex: <https://example.org/g/> .
      ex:r1 a ex:Road . ex:b1 a ex:Bridge .
      ex:r1 ex:hasCarriageway ex:b1 .
    `;
    expect(focusNodes('CNF-003', data)).toEqual([]);
    expect(focusNodes('CNF-004', data)).toEqual([]);
  });

  it('accepts a subclass of an included domain', () => {
    // `domainIncludes` is read into the same rdfs:subClassOf* walk rdfs:domain
    // gets, rather than needing an exact type match -- which is the whole reason
    // gist can declare the domain once on a property reused across a hierarchy.
    expect(focusNodes('CNF-003', `
      @prefix ex: <https://example.org/g/> .
      ex:m1 a ex:Motorway . ex:b1 a ex:Bridge .
      ex:m1 ex:hasCarriageway ex:b1 .
    `)).toEqual([]);
  });

  it('still reports an rdfs:domain violation', () => {
    // The regression guard on the path that was never broken.
    expect(focusNodes('CNF-003', `
      @prefix ex: <https://example.org/g/> .
      ex:p1 a ex:Person . ex:p2 a ex:Person .
      ex:p1 ex:hasOwner ex:p2 .
    `)).toEqual([`${EX}p1`]);
  });

  it('does not treat an includes annotation as declaring the property', () => {
    // The deliberate asymmetry with rdfs:domain, which does declare one:
    // anything carrying an rdfs:domain is an rdf:Property by RDFS entailment.
    // `domainIncludes` is an annotation rdfs:subPropertyOf skos:scopeNote and
    // entails nothing whatever about its subject, so a property described only
    // by a scope note is still undeclared -- STR-002's business here, CNF-002's
    // upstream.
    const undeclared = `
      @prefix gist: <https://w3id.org/semanticarts/ns/ontology/gist/> .
      @prefix ex:   <https://example.org/g/> .
      ex:undeclared gist:domainIncludes ex:Road .
      ex:r1 a ex:Road ; ex:undeclared ex:r1 .
    `;
    const { quads } = parseTurtle('file:///gist-undeclared.ttl', ONTOLOGY + undeclared);
    const rows = runSparqlChecks(quads, registry).filter((r) => r.checkId === 'STR-002');
    expect(rows.map((r) => r.value)).toContain(`${EX}undeclared`);
  });
});
