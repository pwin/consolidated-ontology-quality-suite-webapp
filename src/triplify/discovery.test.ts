import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { discoverJobs, findPair } from './discovery';

describe('discovery against examples/tutorial (csv/appointments.csv + queries/appointments.rq)', () => {
  const dir = path.resolve(__dirname, '../../examples/tutorial');

  it('discoverJobs pairs appointments.csv with appointments.rq by stem', () => {
    const { jobs, warnings } = discoverJobs(path.join(dir, 'csv'), path.join(dir, 'queries'));
    expect(warnings).toEqual([]);
    expect(jobs).toHaveLength(1);
    expect(path.basename(jobs[0].csvPath)).toBe('appointments.csv');
    expect(path.basename(jobs[0].queryPath)).toBe('appointments.rq');
  });

  it('findPair resolves the CSV from the query and vice versa', () => {
    const csvFromQuery = findPair(path.join(dir, 'queries/appointments.rq'));
    expect(csvFromQuery && path.basename(csvFromQuery)).toBe('appointments.csv');

    const queryFromCsv = findPair(path.join(dir, 'csv/appointments.csv'));
    expect(queryFromCsv && path.basename(queryFromCsv)).toBe('appointments.rq');
  });
});
