import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseResultsCsv } from './resultsCsv';

/**
 * The fixture is real `full_results.csv` output, captured by running
 *
 *     ontology-quality-suite run --ontology examples/tutorial/clinic.ttl --out-dir …
 *
 * — the exact argv `OntologySuiteClient.runChecks` builds — against
 * `consolidated_ontology_suite` 0.12.0, and trimmed to one row per interesting
 * shape. Not hand-written: this is the only place the two projects meet at
 * runtime, and a fixture invented here could agree with the parser while both
 * disagreed with the CLI.
 */
const FIXTURE = fs.readFileSync(path.resolve(__dirname, '__fixtures__/full_results.csv'), 'utf8');

describe('parseResultsCsv against real CLI output', () => {
  const rows = parseResultsCsv(FIXTURE);

  it('reads every row, with the columns the CLI actually writes', () => {
    expect(rows.length).toBe(6);
    for (const row of rows) {
      expect(row.checkId).toMatch(/^[A-Z]{3}-\d{3}$/);
      expect(['Violation', 'Warning', 'Info']).toContain(row.severity);
      expect(row.focusNode.length).toBeGreaterThan(0);
      expect(row.message.length).toBeGreaterThan(0);
      expect(row.sources.length).toBeGreaterThan(0);
    }
  });

  it('splits the sources column the way merge.ts joins it', () => {
    // The CLI writes the engines that agreed on a finding as `shacl+sparql`,
    // which has to arrive as two sources, not one string, or a CLI-backed row
    // renders differently from the identical in-process one.
    const merged = rows.find((r) => r.checkId === 'QUA-001');
    expect(merged?.sources).toEqual(['shacl', 'sparql']);
    expect(rows.find((r) => r.checkId === 'QUA-008')?.sources).toEqual(['sparql']);
    expect(rows.find((r) => r.checkId === 'REA-022')?.sources).toEqual(['external-reasoner']);
  });

  it('turns an empty path or value into null rather than an empty string', () => {
    // `path` and `value` are part of the dedup key in merge.ts, where '' and null
    // are different keys -- so an empty column arriving as '' would stop a
    // CLI-backed row merging with the in-process row for the same finding.
    const reasoner = rows.find((r) => r.checkId === 'REA-022');
    expect(reasoner?.path).toBeNull();
    expect(reasoner?.value).toBeNull();

    const withBoth = rows.find((r) => r.checkId === 'QUA-009');
    expect(withBoth?.path).toBe('http://www.w3.org/2004/02/skos/core#prefLabel');
    expect(withBoth?.value).toBe('http://example.org/clinic#Animal');
  });

  it('keeps a message whose own text contains newlines, quotes and commas', () => {
    // REA-022 quotes a Java stack trace, so its cell carries an embedded newline
    // and doubled quotes -- the case a naive split-on-comma parser corrupts, and
    // the reason this fixture is real output rather than an approximation.
    const reasoner = rows.find((r) => r.checkId === 'REA-022');
    expect(reasoner?.message).toContain('\n');
    expect(reasoner?.message).toContain('"main"');
    expect(reasoner?.message).toContain('could not be run');
    // ...and the columns after it still line up, which is what corruption breaks.
    expect(reasoner?.remediation).toContain('reasoner');
    expect(reasoner?.sources).toEqual(['external-reasoner']);
  });

  it('carries no declared severity, the CLI having had no policy to apply', () => {
    expect(rows.filter((r) => r.declaredSeverity !== undefined)).toEqual([]);
  });
});

/**
 * The same command against `consolidated_ontology_suite` 0.25.0, with
 *
 *     --severity-policy severities.json --stringency release
 *
 * and a policy whose `draft` stage sets QUA-009 and STY-003 to Info and whose `release` stage
 * extends it, setting STR-003 to Violation and QUA-004 to off. Trimmed the same way. That CLI
 * writes thirteen columns, not ten: `declared_severity` after `severity`, and `source_file` and
 * `line` (0.17) after `sources` -- in the middle of the row, which is what a by-position read
 * would get wrong.
 */
const FIXTURE_0_25 = fs.readFileSync(path.resolve(__dirname, '__fixtures__/full_results-0.25.0.csv'), 'utf8');

describe('parseResultsCsv against CLI 0.25.0 output with a severity policy', () => {
  const rows = parseResultsCsv(FIXTURE_0_25);
  const byId = (id: string) => rows.find((r) => r.checkId === id);

  it('reads every row, every column landing where it belongs', () => {
    expect(rows.map((r) => r.checkId)).toEqual(['REA-022', 'QUA-001', 'QUA-008', 'QUA-009', 'STR-003', 'STY-003']);
    expect(byId('QUA-001')?.focusNode).toBe('http://example.org/clinic#Vaccination');
    expect(byId('QUA-001')?.sources).toEqual(['shacl', 'sparql']);
    expect(byId('QUA-009')?.path).toBe('http://www.w3.org/2004/02/skos/core#prefLabel');
    expect(byId('REA-022')?.message).toContain('"main"');
    expect(byId('REA-022')?.sources).toEqual(['external-reasoner']);
  });

  it('keeps what the check declared on a re-mapped row, either way', () => {
    expect(byId('STR-003')).toMatchObject({ severity: 'Violation', declaredSeverity: 'Warning' });
    expect(byId('QUA-009')).toMatchObject({ severity: 'Info', declaredSeverity: 'Warning' });
  });

  it('leaves it unset on a row the policy did not move, named in it or not', () => {
    // STY-003 is in the policy as Info and declared Info: listed, not moved.
    expect(byId('STY-003')?.severity).toBe('Info');
    expect(byId('STY-003')).not.toHaveProperty('declaredSeverity');
    expect(byId('QUA-001')).not.toHaveProperty('declaredSeverity');
  });
});
