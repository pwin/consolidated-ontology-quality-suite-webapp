import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseCsv } from './csv';
import { profileCsv, draftFromProfile } from './csvProfiler';

describe('profileCsv against examples/tutorial/csv/appointments.csv', () => {
  const csvPath = path.resolve(__dirname, '../../examples/tutorial/csv/appointments.csv');
  const sample = parseCsv(fs.readFileSync(csvPath, 'utf8'), 10);
  const profile = profileCsv(sample);

  it('sniffs appointment_id as the key column and appointment_date as a date column', () => {
    expect(profile.keyColumn?.header).toBe('appointment_id');
    const dateCol = profile.columns.find((c) => c.header === 'appointment_date');
    expect(dateCol?.kind).toBe('date');
  });

  it('sniffs vet_name as a low-cardinality enum column (2 distinct vets across 3 rows)', () => {
    const vetCol = profile.columns.find((c) => c.header === 'vet_name');
    expect(vetCol?.kind).toBe('enum');
    expect(vetCol?.distinctValues.sort()).toEqual(['Dr Ito', 'Dr Patel']);
  });

  it('drafts an ontology fragment and CONSTRUCT query referencing every non-key column', () => {
    const draft = draftFromProfile(csvPath, profile);
    expect(draft.ontologyFragment).toContain('owl:Class');
    expect(draft.constructQuery).toContain('CONSTRUCT');
    for (const col of profile.columns) {
      if (col === profile.keyColumn) continue;
      expect(draft.constructQuery.toLowerCase()).toContain(col.header.toLowerCase().replace(/[^a-z0-9]/g, ''));
    }
  });
});
