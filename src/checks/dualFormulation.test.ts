import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseTurtle } from '../rdf/parseDocument';
import { loadRegistry } from './registryLoader';
import { runSparqlChecks } from './sparqlRunner';
import { runShaclChecks } from './shaclRunner';
import { mergeResultRows } from './merge';

/**
 * One defect, one finding -- for every check that has *both* a SHACL shape and
 * a SPARQL twin.
 *
 * Both tiers run in the same *Run Local Checks* pass, so a check written twice
 * is a check that reports twice unless the two formulations agree on the whole
 * dedup key merge.ts uses: `(checkId, focusNode, path, value)`. A single field
 * differing in one of the two is enough, nothing throws, and the result looks
 * like an ontology with more wrong with it than it has. That has now happened
 * four separate times in this registry -- `STY-003` binding a label the twin
 * did not, `LOG-001` emitting a path the twin did not, every nested property
 * shape reporting a null check id, and `REA-001` under a second name -- and
 * each was found by hand, after shipping.
 *
 * `__fixtures__/dual-formulation.ttl` seeds a defect for each of them, so the
 * property is checked rather than reasoned about. Its Python counterpart,
 * `tests/test_engine_parity_stress.py`, asks the neighbouring question of the
 * same set: that pyshacl and the native Rust engine *agree* on the counts. It
 * pins exact numbers per check, which is a sharper instrument and a more
 * brittle one -- adding a defect to that fixture renumbers unrelated checks.
 * Presence and merging is what matters here, so this asserts those and stays
 * indifferent to how many of each the fixture happens to produce.
 */
const REGISTRY_DIR = path.resolve(__dirname, '../../resources/checks-registry');
const FIXTURE = path.join(__dirname, '__fixtures__/dual-formulation.ttl');

/**
 * The checks written twice, pinned as an exact set.
 *
 * The list is the point, not its length: a check that *grows* a second
 * formulation joins it silently, and until it is seeded into the fixture
 * nothing establishes that its two halves agree. Upstream had exactly that
 * happen -- its stress fixture's docstring claimed to cover "all 18", three
 * more checks became dual-formulation, and the sentence quietly became false
 * because prose cannot fail.
 */
const DUAL_FORMULATION = [
  'DAT-001', 'DAT-002', 'DAT-003', 'DAT-004',
  'EFF-001', 'EFF-002', 'EFF-003',
  'LOG-001', 'LOG-002', 'LOG-003',
  'QUA-001', 'QUA-002', 'QUA-003', 'QUA-009', 'QUA-010',
  'STR-001', 'STR-002', 'STR-003',
  'STY-001', 'STY-002', 'STY-003',
];

const registry = loadRegistry(REGISTRY_DIR);

function shapeIds(): Set<string> {
  const ids = new Set<string>();
  for (const file of registry.shaclFiles) {
    for (const m of fs.readFileSync(file, 'utf8').matchAll(/^oq:([A-Z]{3}-\d{3})/gm)) ids.add(m[1]);
  }
  return ids;
}

function runBothTiers() {
  const { quads } = parseTurtle(FIXTURE, fs.readFileSync(FIXTURE, 'utf8'));
  const sparql = runSparqlChecks(quads, registry);
  const shacl = runShaclChecks(quads, registry);
  return { sparql, shacl, merged: mergeResultRows([...sparql, ...shacl]) };
}

describe('checks written in both SHACL and SPARQL', () => {
  it('has exactly the dual-formulation set this fixture seeds', () => {
    const queryIds = new Set(registry.sparqlFiles.map((f) => path.basename(f, '.rq')));
    const dual = [...shapeIds()].filter((id) => queryIds.has(id)).sort();
    expect(dual).toEqual([...DUAL_FORMULATION].sort());
  });

  it('reports each of them from both tiers, as a single merged row', () => {
    const { sparql, shacl, merged } = runBothTiers();
    const sparqlIds = new Set(sparql.map((r) => r.checkId));
    const shaclIds = new Set(shacl.map((r) => r.checkId));

    for (const id of DUAL_FORMULATION) {
      // A check absent from one tier is not evidence of agreement -- it is the
      // fixture having stopped seeding it, which is the failure this catches.
      expect(sparqlIds.has(id), `${id} did not fire from the SPARQL tier`).toBe(true);
      expect(shaclIds.has(id), `${id} did not fire from the SHACL tier`).toBe(true);

      const rows = merged.filter((r) => r.checkId === id);
      const unmerged = rows.filter((r) => r.sources.length === 1);
      expect(
        unmerged.map((r) => `${r.sources[0]}: focus=${r.focusNode} path=${r.path} value=${r.value}`),
        `${id} reported the same defect twice -- the two formulations disagree on part of the dedup key`,
      ).toEqual([]);
      expect(rows.length).toBeGreaterThan(0);
    }
  });

  it('substitutes every message-template placeholder the shapes use', () => {
    // `sh:message` is a template. shacl-wasm returns it verbatim, so before
    // shaclRunner filled them in, seventeen of the twenty shape messages
    // reached the Problems panel with a literal "{$this}" standing exactly
    // where the name of the offending term should be.
    const { shacl } = runBothTiers();
    expect(shacl.length).toBeGreaterThan(0);
    const unfilled = shacl.filter((r) => /\{[$?]\w+\}/.test(r.message)).map((r) => `${r.checkId}: ${r.message}`);
    expect([...new Set(unfilled)]).toEqual([]);
  });

  it('renders a path expression rather than the engine\'s blank-node label', () => {
    // LOG-001 is the registry's only path that is not a plain IRI
    // (`sh:oneOrMorePath rdfs:subClassOf`). The engine reports it as `_:0_b0`,
    // its own private label for the node -- meaningless in the Problems panel,
    // different on every parse, and never equal to what the SPARQL twin binds,
    // so the two rows could not merge however correct both were.
    const { shacl } = runBothTiers();
    const rows = shacl.filter((r) => r.checkId === 'LOG-001');
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.path).toBe('(http://www.w3.org/2000/01/rdf-schema#subClassOf)+');
    }
  });

  it('leaves a path that is genuinely absent as null, not the string "undefined"', () => {
    // A node-shape constraint has no path at all. The engine returns `undefined`
    // where the row's type says `string | null`, which reached the panel as the
    // word "undefined" and would have been a distinct dedup key from the twin's
    // real null had merge.ts not coalesced both to ''.
    const { shacl } = runBothTiers();
    for (const row of shacl) {
      expect(row.path === null || typeof row.path === 'string').toBe(true);
      expect(row.path).not.toBe('undefined');
    }
  });
});
