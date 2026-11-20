import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseTurtle } from '../rdf/parseDocument';
import { loadRegistry } from './registryLoader';
import { runSparqlChecks } from './sparqlRunner';

/**
 * `LOG-002` counts values, not spellings.
 *
 * The check used to be a single filter comparing `STR(?o1)` with `STR(?o2)`,
 * which did two jobs with one expression -- order the pair so each is
 * reported once, and decide whether the two values differ -- and got the
 * second wrong, because `STR()` returns a lexical form and two lexical forms
 * are not two values. Three faults came out of that one line:
 *
 * - **owl:sameAs.** Two names for one individual were reported as two values.
 *   This is the defect that was reported from the field.
 * - **Value-equal literals.** `"80"` and `"80.0"^^xsd:decimal` are one value
 *   with two lexical forms. This one does not reproduce on HOLOS, which
 *   matches them as a single value before the filter is reached -- measured:
 *   the store holds two quads and the self-join yields one pair. Fixed
 *   anyway, because a check that is correct only because one engine is
 *   forgiving is not correct.
 * - **Blank nodes, the false negative.** SPARQL 1.1 17.4.2.5 defines `STR()`
 *   for literals and IRIs, so `STR()` of a blank node is a type error, an
 *   error inside a FILTER drops the row, and a functional property with two
 *   distinct blank-node values was reported as *clean*. That is the worse
 *   half: a false positive is an argument, a false negative is silence.
 *
 * Of the nine cases below the old filter was wrong on four.
 *
 * `LOG-002.rq` is shared data -- the same bytes ship in the Python suite --
 * so these cases are the counterpart of the ones added there, and neither
 * copy of the query is edited alone.
 */
const REGISTRY_DIR = path.resolve(__dirname, '../../resources/checks-registry');
const registry = loadRegistry(REGISTRY_DIR);

const HEADER = `
  @prefix owl:  <http://www.w3.org/2002/07/owl#> .
  @prefix rdf:  <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
  @prefix xsd:  <http://www.w3.org/2001/XMLSchema#> .
  @prefix ex:   <https://example.org/trail/> .
  ex:foundedBy a owl:FunctionalProperty .
`;

/**
 * How many distinct (focus node, path) pairs LOG-002 reports.
 *
 * The join is symmetric, so an offending pair matches once in each order and
 * the two rows agree on focus node, path and value; they collapse under the
 * merge's dedup key, and are counted the same way here.
 */
function findings(body: string): number {
  const { quads } = parseTurtle('file:///functional-identity.ttl', HEADER + body);
  const rows = runSparqlChecks(quads, registry).filter((r) => r.checkId === 'LOG-002');
  return new Set(rows.map((r) => `${r.focusNode}|${r.path ?? ''}`)).size;
}

describe('LOG-002 treats two names for one value as one value', () => {
  it('accepts two owl:sameAs names for one individual', () => {
    expect(findings(`
      @prefix owl: <http://www.w3.org/2002/07/owl#> .
      @prefix ex:  <https://example.org/trail/> .
      ex:abbey ex:foundedBy ex:aelfric , ex:aelfricOfEynsham .
      ex:aelfric owl:sameAs ex:aelfricOfEynsham .
    `)).toBe(0);
  });

  it('accepts owl:sameAs asserted the other way round', () => {
    // owl:sameAs is symmetric, and an ontology may assert either direction.
    expect(findings(`
      @prefix owl: <http://www.w3.org/2002/07/owl#> .
      @prefix ex:  <https://example.org/trail/> .
      ex:abbey ex:foundedBy ex:aelfric , ex:aelfricOfEynsham .
      ex:aelfricOfEynsham owl:sameAs ex:aelfric .
    `)).toBe(0);
  });

  it('follows an owl:sameAs chain', () => {
    // Transitive, so a two-hop chain still names one individual.
    expect(findings(`
      @prefix owl: <http://www.w3.org/2002/07/owl#> .
      @prefix ex:  <https://example.org/trail/> .
      ex:abbey ex:foundedBy ex:a , ex:c .
      ex:a owl:sameAs ex:b . ex:b owl:sameAs ex:c .
    `)).toBe(0);
  });

  it('accepts two lexical forms of one numeric value', () => {
    expect(findings(`
      @prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
      @prefix ex:  <https://example.org/trail/> .
      ex:abbey ex:foundedBy "80"^^xsd:decimal , "80.0"^^xsd:decimal .
    `)).toBe(0);
  });

  it('accepts one value', () => {
    expect(findings(`
      @prefix ex: <https://example.org/trail/> .
      ex:abbey ex:foundedBy ex:aelfric .
    `)).toBe(0);
  });
});

describe('LOG-002 still reports a real violation', () => {
  it('reports two different IRIs', () => {
    expect(findings(`
      @prefix ex: <https://example.org/trail/> .
      ex:abbey ex:foundedBy ex:trustA , ex:trustB .
    `)).toBe(1);
  });

  it('reports two different strings', () => {
    expect(findings(`
      @prefix ex: <https://example.org/trail/> .
      ex:abbey ex:foundedBy "Aelfric" , "Dunstan" .
    `)).toBe(1);
  });

  it('reports two distinct blank-node values, which used to be missed', () => {
    // The false negative. STR() of a blank node is a type error, so the old
    // filter dropped this row and called the graph clean.
    expect(findings(`
      @prefix ex: <https://example.org/trail/> .
      ex:abbey ex:foundedBy [ ex:name "A" ] , [ ex:name "B" ] .
    `)).toBe(1);
  });

  it('reports a genuine violation alongside a sameAs pair that is not one', () => {
    // Both in one graph: the fix must not be "report less".
    expect(findings(`
      @prefix owl: <http://www.w3.org/2002/07/owl#> .
      @prefix ex:  <https://example.org/trail/> .
      ex:custodian a owl:FunctionalProperty .
      ex:abbey ex:foundedBy ex:aelfric , ex:aelfricOfEynsham .
      ex:aelfric owl:sameAs ex:aelfricOfEynsham .
      ex:abbey ex:custodian ex:trustA , ex:trustB .
    `)).toBe(1);
  });
});
