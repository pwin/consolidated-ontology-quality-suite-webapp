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

    const disjoint = rows.find((r) => r.checkId === 'REA-DISJOINT');
    expect(disjoint).toBeDefined();
    expect(disjoint!.focusNode).toBe(`${EX}rex`);
    expect(disjoint!.severity).toBe('Violation');

    const sameDiff = rows.find((r) => r.checkId === 'REA-SAMEDIFF');
    expect(sameDiff).toBeDefined();
    expect(sameDiff!.focusNode).toBe(`${EX}alice`);
  });

  it('finds no contradictions in a clean ontology (examples/ontology/domain.ttl)', async () => {
    const domainPath = path.resolve(__dirname, '../../examples/ontology/domain.ttl');
    const doc = parseTurtle(domainPath, fs.readFileSync(domainPath, 'utf8'));
    const rows = await runReasoningChecks(doc.quads, rulesPath);
    expect(rows).toEqual([]);
  });
});
