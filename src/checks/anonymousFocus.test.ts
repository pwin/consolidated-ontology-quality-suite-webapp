/**
 * A finding whose focus node is anonymous, across both formulations.
 *
 * The extension runs the portable `.rq` checks through oxigraph and the shapes
 * through shacl-wasm, then merges. Both engines relabel blank nodes when they
 * parse -- labels in a document are document-scoped and an engine may rename
 * them -- and they do not agree: for one anonymous restriction, shacl-wasm says
 * `_:1_b4` where the SPARQL arm says n3's `n3-0`.
 *
 * Two defects followed from that, both measured here before they were fixed:
 *
 *   1. The dedup key included the label, so the two arms never matched and one
 *      finding was reported twice. Two findings came out as three rows.
 *   2. `sh:message` is a template and `{$this}` is SHACL's own substitution, so
 *      the shape's message read "A label on _:1_b4 has no language tag." -- an
 *      internal identifier that names nothing a reader can look up and differs
 *      on every run.
 *
 * The `.rq` twins were fixed in the query itself, with
 * `IF(isBlank(?e), "[a blank node]", STR(?e))`. A shape cannot do that, so it is
 * handled in `shaclRunner.fillMessageTemplate` for every shape at once. The
 * Python suite carries the same pair of fixes -- `merge._anonymous_key` and
 * `merge.substitute_message_placeholders` -- and the text has to stay identical
 * in both or the two arms of one check say different things and stop merging.
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseTurtle } from '../rdf/parseDocument';
import { loadRegistry } from './registryLoader';
import { runShaclChecks } from './shaclRunner';
import { runSparqlChecks } from './sparqlRunner';
import { mergeResultRows } from './merge';

const REGISTRY_DIR = path.resolve(__dirname, '../../resources/checks-registry');

/** One untagged label on an anonymous restriction, one on a named class. */
const TTL = `
@prefix owl:  <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix ex:   <https://example.org/anon#> .
ex:Car a owl:Class ; rdfs:subClassOf [ a owl:Restriction ; rdfs:label "has a wheel" ] .
ex:Chassis a owl:Class ; rdfs:label "Chassis" .
`;

/** Anything that looks like an engine's internal handle for an anonymous node. */
const INTERNAL_HANDLE = /_:\S+|\bn3-\d+\b|\b[0-9a-f]{24,}\b/;

function styRows() {
  const doc = parseTurtle(path.join(REGISTRY_DIR, 'anon-fixture.ttl'), TTL);
  const registry = loadRegistry(REGISTRY_DIR);
  const merged = mergeResultRows(
    runSparqlChecks(doc.quads, registry, new Set()),
    runShaclChecks(doc.quads, registry),
    [], [], [], [],
  );
  return merged.filter((row) => row.checkId === 'STY-003');
}

describe('a finding with an anonymous focus node', () => {
  it('is reported once, not once per formulation', () => {
    const rows = styRows();
    expect(rows).toHaveLength(2);
    const anonymous = rows.filter((row) => row.focusIsBlank);
    expect(anonymous).toHaveLength(1);
  });

  it('is found by both formulations and merges', () => {
    // The point of running both: agreement is the signal. If this drops to one
    // source the arms have drifted, which is what the duplicate row was hiding.
    for (const row of styRows()) {
      expect(row.sources.sort()).toEqual(['shacl', 'sparql']);
    }
  });

  it('never names an internal identifier in its message', () => {
    for (const row of styRows()) {
      expect(row.message).not.toMatch(INTERNAL_HANDLE);
    }
  });

  it('says what it cannot name, in the same words the queries use', () => {
    const anonymous = styRows().find((row) => row.focusIsBlank);
    expect(anonymous?.message).toContain('[a blank node]');
  });

  it('still names a focus node that has an IRI', () => {
    const named = styRows().find((row) => !row.focusIsBlank);
    expect(named?.message).toContain('https://example.org/anon#Chassis');
  });

  it('carries a message at all, from whichever arm supplied it', () => {
    // A CONSTRUCT template drops a triple whose variable is unbound, so an
    // expression that errors for some rows removes the message for exactly
    // those rows and leaves the rest looking healthy.
    for (const row of styRows()) {
      expect(row.message.trim()).not.toBe('');
    }
  });
});
