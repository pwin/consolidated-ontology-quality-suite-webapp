import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseCsv } from './csv';
import { evaluatePreview } from './previewEvaluator';

describe('evaluatePreview: appointments.rq against appointments.csv', () => {
  const dir = path.resolve(__dirname, '../../examples/tutorial');
  const queryText = fs.readFileSync(path.join(dir, 'queries/appointments.rq'), 'utf8');
  const csvText = fs.readFileSync(path.join(dir, 'csv/appointments.csv'), 'utf8');

  it('triplifies all three CSV rows into typed, IRI-minted triples with zero error', () => {
    const sample = parseCsv(csvText, 10);
    const result = evaluatePreview(queryText, sample, []);

    expect(result.error).toBeUndefined();
    expect(result.rowsUsed).toBe(3);
    expect(result.turtle).toContain('<http://example.org/clinic#appointment-1>');
    expect(result.turtle).toContain('<http://example.org/clinic#appointment-2>');
    expect(result.turtle).toContain('<http://example.org/clinic#appointment-3>');
    expect(result.turtle).toContain('"2026-01-14"^^<http://www.w3.org/2001/XMLSchema#date>');
    // ENCODE_FOR_URI must percent-encode the space in "Dr Patel".
    expect(result.turtle).toContain('vet-Dr%20Patel');
  });

  it('reports a clear error for a query with no WHERE clause', () => {
    const result = evaluatePreview('CONSTRUCT { ?s ?p ?o }', { headers: [], rows: [] }, []);
    expect(result.error).toMatch(/WHERE/);
  });
});
