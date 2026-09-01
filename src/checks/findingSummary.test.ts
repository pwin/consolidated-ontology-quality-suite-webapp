import { describe, expect, it } from 'vitest';
import { dominantCheck } from './findingSummary';
import type { ResultRow } from '../types';

const row = (checkId: string | null): ResultRow => ({
  checkId,
  category: 'quality',
  title: null,
  severity: 'Warning',
  focusNode: `https://example.org/${Math.random()}`,
  path: null,
  value: null,
  message: '',
  remediation: null,
  sources: ['sparql'],
});

const rows = (...spec: [string | null, number][]) => spec.flatMap(([id, n]) => Array.from({ length: n }, () => row(id)));

describe('dominantCheck', () => {
  it('names the check that is most of the run', () => {
    // The case it exists for: QUA-009/QUA-010 on an ontology documented with
    // rdfs:label rather than SKOS.
    expect(dominantCheck(rows(['QUA-009', 27], ['STY-003', 4]), new Set())).toEqual({ checkId: 'QUA-009', count: 27 });
  });

  it('stays quiet when no single check dominates', () => {
    // Half the findings is what makes an id the story of the run, so a plurality
    // is not enough: 12 of 29 is the biggest share here and still not most of it.
    expect(dominantCheck(rows(['QUA-009', 12], ['STY-003', 12], ['STR-002', 5]), new Set())).toBeUndefined();
    // ...and a bare majority is.
    expect(dominantCheck(rows(['QUA-009', 12], ['STY-003', 13]), new Set())).toEqual({ checkId: 'STY-003', count: 13 });
  });

  it('stays quiet on a small run even when one check is all of it', () => {
    // Four findings, three of them one check, is true and not a reason to
    // change a setting.
    expect(dominantCheck(rows(['QUA-009', 3], ['STY-003', 1]), new Set())).toBeUndefined();
    expect(dominantCheck(rows(['QUA-009', 9]), new Set())).toBeUndefined();
    expect(dominantCheck(rows(['QUA-009', 10]), new Set())).toEqual({ checkId: 'QUA-009', count: 10 });
  });

  it('does not offer to disable what is already disabled', () => {
    const findings = rows(['QUA-009', 27], ['QUA-010', 25]);
    expect(dominantCheck(findings, new Set(['QUA-009']))).toEqual({ checkId: 'QUA-010', count: 25 });
    expect(dominantCheck(findings, new Set(['QUA-009', 'QUA-010']))).toBeUndefined();
  });

  it('ignores findings that resolved to no check id', () => {
    // Nothing to disable, and counting them would skew the share.
    expect(dominantCheck(rows([null, 30], ['STY-003', 2]), new Set())).toBeUndefined();
  });

  it('breaks a tie the same way every run', () => {
    // Otherwise the offer names whichever id the Map happened to yield first,
    // which is insertion order, which is finding order.
    const forwards = dominantCheck(rows(['QUA-010', 10], ['QUA-009', 10]), new Set());
    const backwards = dominantCheck(rows(['QUA-009', 10], ['QUA-010', 10]), new Set());
    expect(forwards).toEqual({ checkId: 'QUA-009', count: 10 });
    expect(forwards).toEqual(backwards);
  });

  it('handles a clean run', () => {
    expect(dominantCheck([], new Set())).toBeUndefined();
  });
});
