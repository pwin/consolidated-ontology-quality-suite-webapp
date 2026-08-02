import { describe, expect, it } from 'vitest';
import { mergeResultRows } from './merge';
import type { ResultRow } from '../types';

function row(overrides: Partial<ResultRow>): ResultRow {
  return {
    checkId: 'STR-001',
    category: 'structural',
    title: 'Undefined class used as rdf:type',
    severity: 'Violation',
    focusNode: 'http://example.org/a',
    path: null,
    value: 'http://example.org/b',
    message: 'msg',
    remediation: null,
    sources: ['sparql'],
    ...overrides,
  };
}

describe('mergeResultRows', () => {
  it('dedupes identical findings from two engines, recording both sources', () => {
    const sparqlRows = [row({ sources: ['sparql'] })];
    const shaclRows = [row({ sources: ['shacl'] })];
    const merged = mergeResultRows(sparqlRows, shaclRows);
    expect(merged).toHaveLength(1);
    expect(merged[0].sources).toEqual(['shacl', 'sparql']);
  });

  it('keeps distinct findings (different focus node) separate', () => {
    const rows = [row({ focusNode: 'http://example.org/a' }), row({ focusNode: 'http://example.org/c' })];
    expect(mergeResultRows(rows)).toHaveLength(2);
  });

  it('sorts by severity, then category, then check id, then focus node', () => {
    const merged = mergeResultRows([
      row({ checkId: 'STY-001', category: 'style', severity: 'Info', focusNode: 'http://example.org/z' }),
      row({ checkId: 'STR-001', category: 'structural', severity: 'Violation', focusNode: 'http://example.org/a' }),
      row({ checkId: 'QUA-001', category: 'quality', severity: 'Warning', focusNode: 'http://example.org/m' }),
    ]);
    expect(merged.map((r) => r.severity)).toEqual(['Violation', 'Warning', 'Info']);
  });
});
