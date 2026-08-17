import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {discoverJobs, findPair, findOntologies } from './discovery';

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

describe('findOntologies', () => {
  const tutorial = path.resolve(__dirname, '../../examples/tutorial');
  const examples = path.resolve(__dirname, '../../examples');

  it('finds the ontology one directory up -- examples/tutorial/queries/*.rq beside ../clinic.ttl', () => {
    // The layout the tutorial itself uses, and the one the old same-directory-only
    // lookup silently found nothing for, so conformance checking never ran.
    const found = findOntologies(path.join(tutorial, 'queries', 'appointments.rq'));
    expect(found.map((f) => path.basename(f)).sort()).toContain('clinic.ttl');
  });

  it('returns every ontology in the winning directory, not just the first', () => {
    // tutorial/ holds clinic.ttl, core.ttl, instances.ttl and reasoning-demo.ttl:
    // an extension ontology plus what it builds on is the normal case.
    const found = findOntologies(path.join(tutorial, 'queries', 'appointments.rq'));
    expect(found.length).toBeGreaterThan(1);
  });

  it('prefers the query own directory over the parent', () => {
    // examples/ontology/ holds its own .ttl files, so a query there must not
    // reach up to examples/.
    const found = findOntologies(path.join(examples, 'ontology', 'anything.rq'));
    expect(found.every((f) => path.dirname(f) === path.join(examples, 'ontology'))).toBe(true);
  });

  it('accepts a .tq query the same as a .rq one', () => {
    const fromTq = findOntologies(path.join(tutorial, 'queries', 'appointments.tq'));
    const fromRq = findOntologies(path.join(tutorial, 'queries', 'appointments.rq'));
    expect(fromTq).toEqual(fromRq);
  });

  it('returns nothing rather than throwing for a path that does not exist', () => {
    expect(findOntologies('C:/nope/does/not/exist/q.rq')).toEqual([]);
  });
});
