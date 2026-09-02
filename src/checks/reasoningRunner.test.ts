import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseTurtle } from '../rdf/parseDocument';
import { runReasoningChecks } from './reasoningRunner';

const rulesPath = path.resolve(__dirname, '../../resources/reasoning/core-rules.n3');
const EX = 'http://example.org/clinic#';

describe('runReasoningChecks against examples/tutorial/reasoning-demo.ttl', () => {
  it('detects a disjointness contradiction that only appears after subclass-inferred typing', async () => {
    const fixturePath = path.resolve(__dirname, '../../examples/tutorial/reasoning-demo.ttl');
    const doc = parseTurtle(fixturePath, fs.readFileSync(fixturePath, 'utf8'));
    const rows = await runReasoningChecks(doc.quads, rulesPath);

    // Registry ids, not ids private to this runner: REA-001 is the entry whose
    // description is this exact check ("after closure, an individual is a member of
    // two classes declared owl:disjointWith"), and sharing it is what lets the
    // asserted case merge with sparql/reasoning/REA-001.rq instead of arriving twice.
    const disjoint = rows.find((r) => r.checkId === 'REA-001');
    expect(disjoint).toBeDefined();
    expect(disjoint!.focusNode).toBe(`${EX}rex`);
    expect(disjoint!.severity).toBe('Violation');
    // The value has to be what the .rq twin binds -- both classes, distinct, sorted,
    // joined with ", " -- or the two rows have different dedup keys and both survive.
    expect(disjoint!.value).toBe([`${EX}Cat`, `${EX}Dog`].sort().join(', '));

    const sameDiff = rows.find((r) => r.checkId === 'REA-005');
    expect(sameDiff).toBeDefined();
    expect(sameDiff!.focusNode).toBe(`${EX}alice`);
  });

  /**
   * Every id this runner emits is declared in registry.json.
   *
   * It used to emit REA-DISJOINT/REA-SAMEDIFF/REA-CONTRADICTION, which no entry
   * declared, while the registry declared REA-001..REA-004 this runner never
   * produced -- two vocabularies for one tier. A finding with an undeclared id still
   * renders (this runner sets its own title and remediation) but nothing can look it
   * up: not the run summary, not `disabledChecks` documentation, not a reader going
   * from the Problems panel to the registry.
   */
  it('reports only ids the registry declares', async () => {
    const registry = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, '../../resources/checks-registry/registry.json'), 'utf8'),
    ) as { checks: { id: string; title: string; default_severity: string }[] };
    const declared = new Map(registry.checks.map((c) => [c.id, c]));

    const fixturePath = path.resolve(__dirname, '../../examples/tutorial/reasoning-demo.ttl');
    const doc = parseTurtle(fixturePath, fs.readFileSync(fixturePath, 'utf8'));
    const rows = await runReasoningChecks(doc.quads, rulesPath);

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const entry = declared.get(row.checkId as string);
      expect(entry, `${row.checkId} is not in registry.json`).toBeDefined();
      // The title is duplicated into this runner rather than read from the registry,
      // which it has no handle on -- so it has to be kept in step, and this is what
      // notices when it is not.
      expect(row.title).toBe(entry?.title);
      expect(row.severity).toBe(entry?.default_severity);
    }
  });

  it('finds no contradictions in a clean ontology (examples/ontology/domain.ttl)', async () => {
    const domainPath = path.resolve(__dirname, '../../examples/ontology/domain.ttl');
    const doc = parseTurtle(domainPath, fs.readFileSync(domainPath, 'utf8'));
    const rows = await runReasoningChecks(doc.quads, rulesPath);
    expect(rows).toEqual([]);
  });
});
