import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {discoverJobs, findPair, findOntologies, resolveOntologyPatterns } from './discovery';

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

describe('resolveOntologyPatterns', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ontglob-'));
    fs.mkdirSync(path.join(root, 'vocab'));
    fs.mkdirSync(path.join(root, 'vocab', 'nested'));
    fs.writeFileSync(path.join(root, 'core.ttl'), '');
    fs.writeFileSync(path.join(root, 'notes.md'), '');
    fs.writeFileSync(path.join(root, 'vocab', 'people_ontology.ttl'), '');
    fs.writeFileSync(path.join(root, 'vocab', 'places_ontology.ttl'), '');
    fs.writeFileSync(path.join(root, 'vocab', 'draft.ttl'), '');
    fs.writeFileSync(path.join(root, 'vocab', 'nested', 'deep_ontology.ttl'), '');
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  const names = (entries: string[]) => resolveOntologyPatterns(entries, root).map((f) => path.basename(f)).sort();

  it('expands a single-directory wildcard', () => {
    expect(names(['vocab/*_ontology.ttl'])).toEqual(['people_ontology.ttl', 'places_ontology.ttl']);
  });

  it('mixes literal paths and patterns in one list', () => {
    // The case that matters: pin the ontologies you author, sweep up the rest.
    expect(names(['core.ttl', 'vocab/*_ontology.ttl'])).toEqual(['core.ttl', 'people_ontology.ttl', 'places_ontology.ttl']);
  });

  it('accepts several patterns in one list', () => {
    expect(names(['vocab/*_ontology.ttl', 'vocab/draft.*'])).toEqual(['draft.ttl', 'people_ontology.ttl', 'places_ontology.ttl']);
  });

  it('descends directories only for **', () => {
    expect(names(['vocab/*.ttl'])).not.toContain('deep_ontology.ttl');
    expect(names(['vocab/**/*.ttl'])).toContain('deep_ontology.ttl');
  });

  it('matches ** against zero directories too', () => {
    // `vocab/**/*.ttl` should find vocab/draft.ttl, not only the nested one.
    expect(names(['vocab/**/*.ttl'])).toContain('draft.ttl');
  });

  it('supports ? as exactly one character', () => {
    expect(names(['vocab/place?_ontology.ttl'])).toEqual(['places_ontology.ttl']);
  });

  it('does not match files the pattern excludes', () => {
    expect(names(['*.ttl'])).toEqual(['core.ttl']);
  });

  it('passes a literal path through unchecked, so a typo surfaces as a read error', () => {
    // A pattern matching nothing is normal; a named file that is missing is a mistake
    // worth reporting, and it can only be reported if it survives to the read.
    const out = resolveOntologyPatterns(['does-not-exist.ttl'], root);
    expect(out).toEqual([path.join(root, 'does-not-exist.ttl')]);
  });

  it('yields nothing for a pattern that matches nothing, rather than throwing', () => {
    expect(resolveOntologyPatterns(['vocab/*.nope'], root)).toEqual([]);
  });

  it('deduplicates a file named by both a literal and a pattern', () => {
    expect(names(['vocab/draft.ttl', 'vocab/*.ttl']).filter((n) => n === 'draft.ttl')).toHaveLength(1);
  });

  it('accepts an absolute path or pattern unchanged by baseDir', () => {
    expect(names([path.join(root, 'vocab', '*_ontology.ttl')])).toEqual(['people_ontology.ttl', 'places_ontology.ttl']);
  });
});
