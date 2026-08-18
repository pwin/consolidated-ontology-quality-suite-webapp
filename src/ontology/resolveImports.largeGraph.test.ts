import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parseTurtle } from '../rdf/parseDocument';
import { resolveImports } from './resolveImports';

/**
 * Regression test for `RangeError: Maximum call stack size exceeded`, reported
 * from `provideHover` against the installed 0.11.2 build.
 *
 * The cause was `target.push(...sourceArray)` on arrays whose length is set by
 * the input: every element becomes a *function argument*, and this runtime
 * throws at ~125,546 of them. Any single ontology or data file above that many
 * quads therefore crashed hover, the checks run and the graph view -- and the
 * failure surfaced as a stack-overflow far from its cause, with nothing in the
 * message naming the file.
 *
 * The guard is behavioural rather than a source grep: this builds a graph past
 * the threshold and asserts the merge completes with every quad present. It is
 * slower than a unit test (a few seconds to parse) but it is the only kind that
 * actually fails when the pattern comes back.
 */
const QUAD_COUNT = 130_000; // comfortably past the ~125.5k argument limit

describe('resolveImports with a graph larger than the spread-argument limit', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'largegraph-'));
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it(`merges an imported ontology of ${QUAD_COUNT.toLocaleString()} quads without overflowing the stack`, async () => {
    const lines = ['@prefix ex: <http://example.org/big#> .', '<http://example.org/big> a <http://www.w3.org/2002/07/owl#Ontology> .'];
    for (let i = 0; i < QUAD_COUNT; i++) lines.push(`ex:s${i} ex:p ex:o${i} .`);
    const bigPath = path.join(dir, 'big.ttl');
    fs.writeFileSync(bigPath, lines.join('\n'));

    const entryPath = path.join(dir, 'entry.ttl');
    fs.writeFileSync(
      entryPath,
      `<http://example.org/entry> a <http://www.w3.org/2002/07/owl#Ontology> ;\n  <http://www.w3.org/2002/07/owl#imports> <http://example.org/big> .\n`,
    );

    const entry = parseTurtle(entryPath, fs.readFileSync(entryPath, 'utf8'));
    const { mergedQuads, report } = await resolveImports(entryPath, entry.quads, dir);

    expect(report.resolved).toEqual(['http://example.org/big']);
    // Every quad from both files, not a truncated or partially-merged graph.
    expect(mergedQuads.length).toBe(entry.quads.length + QUAD_COUNT + 1);
  }, 120_000);
});
