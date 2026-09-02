import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadRegistry } from './registryLoader';

/**
 * Which declared checks this extension can actually produce, pinned as an exact
 * set.
 *
 * The registry is shared data, and this project runs a subset of it in-process:
 * some checks need a full OWL2 DL reasoner, and some need a *two-graph* split
 * (data assessed against a separate ontology) that `runLocalChecks` does not have
 * — it merges the file and its imports into one graph before anything runs.
 *
 * Left implicit, that reads as a promise the UI does not keep: a reader who opens
 * `registry.json`, or points `ontologySuite.checksRegistryPath` at their own copy,
 * has no way to tell which of the entries can ever fire. Naming them here means
 * adding an implementation, or a check, makes this test fail and say so.
 */
const REGISTRY_DIR = path.resolve(__dirname, '../../resources/checks-registry');

/** Declared in the registry, but nothing in this extension can report them. */
const CLI_ONLY = [
  // A full OWL2 DL reasoner (HermiT/Pellet via owlready2). The in-process tier is
  // EYE over an OWL2-RL-subset ruleset: sound, not complete, and it cannot answer
  // "is this ontology consistent" or "is this class satisfiable" in general.
  'REA-020', 'REA-021',
  // "No external DL reasoner was available" -- a statement about the Python CLI's
  // environment. Nothing here has an external reasoner to miss.
  'REA-022',
  // OWL2 profile membership. This extension *computes* EL/QL/RL membership, in
  // rdf/expressivity.ts behind Show Metrics & DL Expressivity, but does not report
  // it as findings. Wiring that tier into the checks engine would retire these
  // three from this list.
  'REA-010', 'REA-011', 'REA-012',
  // A graph assessed against a *separate* ontology: "used here, not declared
  // there". runLocalChecks merges the document with its resolved imports, so there
  // is no "there" to be absent from. STR-001/STR-002 are the one-graph form of the
  // same question and do run; VOC-001 covers the axiom positions.
  'CNF-001', 'CNF-002',
  // Likewise two-graph: a declared class the assessed data never populates.
  'CNF-005',
];

describe('registry coverage', () => {
  const registry = loadRegistry(REGISTRY_DIR);

  /** Ids reachable through a query file, a shape, or native TypeScript. */
  function implementedIds(): Set<string> {
    const ids = new Set<string>();
    for (const file of registry.sparqlFiles) ids.add(path.basename(file, '.rq'));
    for (const file of registry.shaclFiles) {
      for (const m of fs.readFileSync(file, 'utf8').matchAll(/^oq:([A-Z]{3}-\d{3})/gm)) ids.add(m[1]);
    }
    // Native checks, each of which builds its ResultRow in TypeScript.
    for (const id of ['TQL-001', 'TQL-002', 'TQL-003', 'REA-001', 'REA-005', 'REA-006', 'VOC-001', 'DAT-001']) ids.add(id);
    return ids;
  }

  it('declares every check some tier can produce', () => {
    const unimplemented = [...registry.checksById.keys()].filter((id) => !implementedIds().has(id)).sort();
    expect(unimplemented).toEqual([...CLI_ONLY].sort());
  });

  it('produces no check the registry does not declare', () => {
    // The other direction, and the one that actually went wrong: the reasoning
    // tier emitted REA-DISJOINT/REA-SAMEDIFF/REA-CONTRADICTION and the vocabulary
    // tier VOC-001, none of which any entry declared.
    for (const id of ['REA-001', 'REA-005', 'REA-006', 'VOC-001', 'TQL-001', 'TQL-002', 'TQL-003']) {
      expect(registry.checksById.has(id), `${id} is emitted but not declared`).toBe(true);
    }
  });

  it('gives each CLI-only check a category that says which tier it belongs to', () => {
    for (const id of CLI_ONLY) {
      const check = registry.checksById.get(id);
      expect(check, `${id} is listed as CLI-only but is not in the registry at all`).toBeDefined();
      expect(['reasoning', 'conformance']).toContain(check?.category);
    }
  });
});
