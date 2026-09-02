import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseTurtle } from '../rdf/parseDocument';
import { loadRegistry } from './registryLoader';
import { runSparqlChecks } from './sparqlRunner';

/**
 * `CNF-004` accepts a literal whose datatype is *derived* from the declared
 * range, not only one that equals it.
 *
 * Exact equality alone reported `gist:numericValue 2` against
 * `rdfs:range xsd:decimal`, which is correct RDF: XSD derives `xsd:integer` from
 * `xsd:decimal`, and a Turtle `2` is an `xsd:integer`. Numeric ranges are most
 * ranges, so the omission was a false positive on the commonest data there is.
 * Found by running `consolidated_ontology_suite`'s own conformance stage over
 * `examples/gist_patterns` and diffing it against this project's -- the Python
 * side did not report it, which is what prompted looking.
 *
 * The rule is written against what the *store* reports rather than the XSD
 * hierarchy alone, which the first attempt got wrong. Measured here:
 *
 * | declared           | DATATYPE() reports |
 * |--------------------|--------------------|
 * | xsd:short/long/byte, nonNegativeInteger, unsignedByte, negativeInteger | **xsd:integer** |
 * | xsd:token, NCName, language, normalizedString | unchanged |
 * | xsd:dateTimeStamp  | **xsd:dateTime**   |
 * | decimal, double, float, date, boolean | unchanged |
 *
 * So the integer family has to be accepted in both directions -- a range of
 * `xsd:nonNegativeInteger` can only ever *see* `xsd:integer`, the store having
 * already discarded what would tell a conforming value from a violating one.
 * These tests pin that asymmetry, because it reads like a mistake otherwise.
 */
const REGISTRY_DIR = path.resolve(__dirname, '../../resources/checks-registry');
const EX = 'http://example.org/demo#';

function cnf004For(rangeDecl: string, literal: string): string[] {
  const ttl = `
    @prefix ex: <${EX}> .
    @prefix owl: <http://www.w3.org/2002/07/owl#> .
    @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
    @prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
    <http://example.org/demo> a owl:Ontology .
    ex:measure a owl:DatatypeProperty ; rdfs:range ${rangeDecl} .
    ex:thing ex:measure ${literal} .
  `;
  const { quads } = parseTurtle('file:///cnf004.ttl', ttl);
  return runSparqlChecks(quads, loadRegistry(REGISTRY_DIR))
    .filter((r) => r.checkId === 'CNF-004')
    .map((r) => r.focusNode);
}

describe('CNF-004 and the XSD datatype hierarchy', () => {
  it('accepts an integer where a decimal is declared', () => {
    // The case that started this: valid RDF, reported before the fix.
    expect(cnf004For('xsd:decimal', '2')).toEqual([]);
    expect(cnf004For('xsd:decimal', '"2"^^xsd:integer')).toEqual([]);
    expect(cnf004For('xsd:decimal', '"2"^^xsd:byte')).toEqual([]);
  });

  it('accepts an integer where any integer subtype is declared', () => {
    // Not XSD derivation -- the reverse of it. The store reports xsd:integer for
    // every one of these, so this is the only reading that does not fire on
    // every conforming value.
    expect(cnf004For('xsd:long', '"2"^^xsd:short')).toEqual([]);
    expect(cnf004For('xsd:nonNegativeInteger', '5')).toEqual([]);
    expect(cnf004For('xsd:unsignedByte', '"2"^^xsd:unsignedByte')).toEqual([]);
    expect(cnf004For('xsd:negativeInteger', '-2')).toEqual([]);
  });

  it('accepts a derived string type where a string type is declared', () => {
    // The string family survives the store intact, so this side is real XSD
    // derivation, read downward from the declared range.
    expect(cnf004For('xsd:string', '"a"^^xsd:token')).toEqual([]);
    expect(cnf004For('xsd:string', '"a"^^xsd:NCName')).toEqual([]);
    expect(cnf004For('xsd:token', '"en"^^xsd:language')).toEqual([]);
    expect(cnf004For('xsd:normalizedString', '"a"^^xsd:token')).toEqual([]);
  });

  it('accepts a dateTime where a dateTimeStamp is declared', () => {
    // Narrowed by the store, so the pair reads the opposite way to the strings.
    expect(cnf004For('xsd:dateTimeStamp', '"2020-01-10T00:00:00Z"^^xsd:dateTimeStamp')).toEqual([]);
  });

  it('accepts any literal where rdfs:Literal is declared', () => {
    // Matching rdfs:Literal by datatype equality accepted nothing at all.
    expect(cnf004For('rdfs:Literal', '2')).toEqual([]);
    expect(cnf004For('rdfs:Literal', '"a"')).toEqual([]);
    expect(cnf004For('rdfs:Literal', '"2020-01-10"^^xsd:date')).toEqual([]);
  });

  it('still reports a literal that is genuinely the wrong kind', () => {
    // The fix must not turn the check off. Nothing here is a widening of the
    // declared range: a decimal is not an integer, a string is not a number, and
    // a date is not either.
    expect(cnf004For('xsd:integer', '"2.5"^^xsd:decimal')).toEqual([`${EX}thing`]);
    expect(cnf004For('xsd:decimal', '"a"')).toEqual([`${EX}thing`]);
    expect(cnf004For('xsd:date', '2')).toEqual([`${EX}thing`]);
    expect(cnf004For('xsd:string', '2')).toEqual([`${EX}thing`]);
    expect(cnf004For('xsd:boolean', '"a"')).toEqual([`${EX}thing`]);
  });

  it('does not treat a language-tagged literal as an xsd:string', () => {
    // datatype() gives rdf:langString for these, which is a real mismatch rather
    // than a derivation -- a range of xsd:string does not accept "a"@en.
    expect(cnf004For('xsd:string', '"a"@en')).toEqual([`${EX}thing`]);
    // ...but an untagged literal *is* an xsd:string under RDF 1.1.
    expect(cnf004For('xsd:string', '"a"')).toEqual([]);
  });
});
