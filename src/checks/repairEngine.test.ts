import * as path from 'node:path';
import { DataFactory } from 'n3';
import { describe, expect, it } from 'vitest';
import { buildRepairUpdate, computeRepair, hasRepairTemplate, humanizeLocalName } from './repairEngine';
import { DEFAULT_PROJECT_STANDARDS, ProjectStandards } from './projectStandardsCore';

const { namedNode, quad } = DataFactory;
const repairsRoot = path.resolve(__dirname, '../../resources/checks-registry/repairs');

const standards: ProjectStandards = DEFAULT_PROJECT_STANDARDS;

describe('humanizeLocalName', () => {
  it('splits camelCase local names into words', () => {
    expect(humanizeLocalName('http://ex/hasOwner')).toBe('has Owner');
  });
  it('splits snake_case/kebab-case local names into words', () => {
    expect(humanizeLocalName('http://ex/has_owner')).toBe('has owner');
    expect(humanizeLocalName('http://ex/has-owner')).toBe('has owner');
  });
});

describe('hasRepairTemplate', () => {
  it('is true for every check the manifest declares a template for', () => {
    for (const id of [
      'STR-001', 'STR-002', 'STR-005', 'STR-007', 'STR-008',
      'QUA-001', 'QUA-002', 'QUA-004', 'QUA-005', 'QUA-007',
      'LOG-003', 'MDL-001', 'MDL-002', 'MDL-003', 'STY-003', 'PRJ-REQUIRED',
    ]) {
      expect(hasRepairTemplate(repairsRoot, id)).toBe(true);
    }
  });
  it('is false for a check with no repair template (e.g. DAT-003, dropped as ambiguous)', () => {
    expect(hasRepairTemplate(repairsRoot, 'DAT-003')).toBe(false);
  });
});

describe('computeRepair', () => {
  it('STR-001: declares an undeclared class referenced via rdf:type (insert-only)', () => {
    const quads = [quad(namedNode('http://ex/Rex'), namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#type'), namedNode('http://ex/Dog'))];
    const row = { checkId: 'STR-001', focusNode: 'http://ex/Rex', path: null, value: 'http://ex/Dog' };
    const outcome = computeRepair(repairsRoot, row, quads, {}, standards);
    expect(outcome?.kind).toBe('insert');
    expect(outcome?.addedQuads).toHaveLength(1);
    expect(outcome?.addedQuads[0].subject.value).toBe('http://ex/Dog');
    expect(outcome?.addedQuads[0].predicate.value).toBe('http://www.w3.org/1999/02/22-rdf-syntax-ns#type');
    expect(outcome?.addedQuads[0].object.value).toBe('http://www.w3.org/2002/07/owl#Class');
  });

  it('QUA-001: adds a label derived from the local name, tagged with the project language', () => {
    const quads = [quad(namedNode('http://ex/hasOwner'), namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#type'), namedNode('http://www.w3.org/2002/07/owl#ObjectProperty'))];
    const row = { checkId: 'QUA-001', focusNode: 'http://ex/hasOwner', path: null, value: null };
    const outcome = computeRepair(repairsRoot, row, quads, {}, standards);
    expect(outcome?.addedQuads).toHaveLength(1);
    const [added] = outcome!.addedQuads;
    expect(added.object.value).toBe('has Owner');
    expect((added.object as import('n3').Literal).language).toBe('en');
  });

  it('MDL-003: replaces owl:Class with the project-standard category class (replace-kind, project standards complete the repair)', () => {
    const quads = [quad(namedNode('http://ex/AppointmentType'), namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#type'), namedNode('http://www.w3.org/2002/07/owl#Class'))];
    const row = { checkId: 'MDL-003', focusNode: 'http://ex/AppointmentType', path: null, value: null };
    const projectStandards: ProjectStandards = { ...standards, categoryClass: 'http://ex/local#Category' };
    const outcome = computeRepair(repairsRoot, row, quads, {}, projectStandards);
    expect(outcome?.kind).toBe('replace');
    expect(outcome?.removedQuads).toHaveLength(1);
    expect(outcome?.addedQuads).toHaveLength(1);
    expect(outcome?.addedQuads[0].object.value).toBe('http://ex/local#Category');
    expect(outcome?.resultQuads).toHaveLength(1);
  });

  it('MDL-002: policy-driven template selection picks subClassOf vs closeMatch per project standards', () => {
    const quads = [quad(namedNode('http://ex/A'), namedNode('http://www.w3.org/2002/07/owl#equivalentClass'), namedNode('http://ex/B'))];
    const row = { checkId: 'MDL-002', focusNode: 'http://ex/A', path: null, value: 'http://ex/B' };

    const subClassOf = computeRepair(repairsRoot, row, quads, {}, { ...standards, equivalentClassPolicy: 'subClassOf' });
    expect(subClassOf?.addedQuads[0].predicate.value).toBe('http://www.w3.org/2000/01/rdf-schema#subClassOf');

    const closeMatch = computeRepair(repairsRoot, row, quads, {}, { ...standards, equivalentClassPolicy: 'closeMatch' });
    expect(closeMatch?.addedQuads[0].predicate.value).toBe('http://www.w3.org/2004/02/skos/core#closeMatch');
  });

  it('LOG-003: policy-driven deletion keeps whichever axiom the project standards say to keep', () => {
    const quads = [
      quad(namedNode('http://ex/A'), namedNode('http://www.w3.org/2000/01/rdf-schema#subClassOf'), namedNode('http://ex/B')),
      quad(namedNode('http://ex/A'), namedNode('http://www.w3.org/2002/07/owl#equivalentClass'), namedNode('http://ex/B')),
    ];
    const row = { checkId: 'LOG-003', focusNode: 'http://ex/A', path: null, value: 'http://ex/B' };

    const keepEquivalentClass = computeRepair(repairsRoot, row, quads, {}, { ...standards, redundantEquivalencePolicy: 'keepEquivalentClass' });
    expect(keepEquivalentClass?.removedQuads).toHaveLength(1);
    expect(keepEquivalentClass?.removedQuads[0].predicate.value).toBe('http://www.w3.org/2000/01/rdf-schema#subClassOf');

    const keepSubClassOf = computeRepair(repairsRoot, row, quads, {}, { ...standards, redundantEquivalencePolicy: 'keepSubClassOf' });
    expect(keepSubClassOf?.removedQuads).toHaveLength(1);
    expect(keepSubClassOf?.removedQuads[0].predicate.value).toBe('http://www.w3.org/2002/07/owl#equivalentClass');
  });

  it('STY-003: retags an untagged rdfs:label with the project default language, leaving other labels untouched', () => {
    const quads = [
      quad(namedNode('http://ex/Dog'), namedNode('http://www.w3.org/2000/01/rdf-schema#label'), DataFactory.literal('Dog')),
      quad(namedNode('http://ex/Dog'), namedNode('http://www.w3.org/2000/01/rdf-schema#label'), DataFactory.literal('Chien', 'fr')),
    ];
    const row = { checkId: 'STY-003', focusNode: 'http://ex/Dog', path: null, value: null };
    const outcome = computeRepair(repairsRoot, row, quads, {}, standards);
    expect(outcome?.removedQuads).toHaveLength(1);
    expect((outcome!.removedQuads[0].object as import('n3').Literal).language).toBe('');
    expect(outcome?.addedQuads).toHaveLength(1);
    const added = outcome!.addedQuads[0].object as import('n3').Literal;
    expect(added.value).toBe('Dog');
    expect(added.language).toBe('en');
    // The already-tagged French label must survive untouched.
    expect(outcome?.resultQuads.some((q) => (q.object as import('n3').Literal).language === 'fr')).toBe(true);
  });

  it('PRJ-REQUIRED: only auto-fixes label-like predicates, leaving structural ones (e.g. rdfs:domain) unfixed', () => {
    const quads = [quad(namedNode('http://ex/Cat'), namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#type'), namedNode('http://www.w3.org/2002/07/owl#Class'))];

    const labelRow = { checkId: 'PRJ-REQUIRED', focusNode: 'http://ex/Cat', path: 'http://www.w3.org/2000/01/rdf-schema#label', value: null };
    const labelOutcome = computeRepair(repairsRoot, labelRow, quads, {}, standards);
    expect(labelOutcome?.addedQuads).toHaveLength(1);

    const domainRow = { checkId: 'PRJ-REQUIRED', focusNode: 'http://ex/Cat', path: 'http://www.w3.org/2000/01/rdf-schema#domain', value: null };
    const domainOutcome = computeRepair(repairsRoot, domainRow, quads, {}, standards);
    expect(domainOutcome?.addedQuads).toHaveLength(0);
    expect(domainOutcome?.removedQuads).toHaveLength(0);
  });

  it('returns undefined for a checkId with no repair template', () => {
    const quads = [quad(namedNode('http://ex/A'), namedNode('http://ex/p'), namedNode('http://ex/B'))];
    const row = { checkId: 'DAT-003', focusNode: 'http://ex/A', path: null, value: null };
    expect(computeRepair(repairsRoot, row, quads, {}, standards)).toBeUndefined();
  });

  it('is a safe no-op when the target triple is not present in the given document quads (e.g. declared only in an imported file)', () => {
    const quads: import('n3').Quad[] = [];
    const row = { checkId: 'MDL-001', focusNode: 'http://ex/isOwnerOf', path: null, value: 'http://ex/hasOwner' };
    const outcome = computeRepair(repairsRoot, row, quads, {}, standards);
    expect(outcome?.removedQuads).toHaveLength(0);
    expect(outcome?.addedQuads).toHaveLength(0);
  });
});

/**
 * `focusNode`/`path`/`value` are not always IRIs: `path` can be a SHACL
 * property-path expression (`(rdfs:subClassOf)+` for LOG-001) and `value` can
 * be several values joined for one finding (LOG-004's two inverses) -- both
 * introduced in 0.11.0 by sparqlRunner.ts. buildRepairUpdate binds every
 * variable in one VALUES row whether the template uses it or not, so a term
 * wrapped naively in angle brackets makes the whole update unparseable and
 * breaks repairs that never referenced it.
 */
describe('buildRepairUpdate with non-IRI path/value terms', () => {
  const template = 'PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>\nDELETE { ?focusNode a ?x } WHERE { ?focusNode a ?x }';

  const undefFor = (row: { focusNode: string; path: string | null; value: string | null }) =>
    buildRepairUpdate(template, row, standards, {});

  it('emits UNDEF rather than a malformed IRI for a property-path expression', () => {
    const out = undefFor({ focusNode: 'http://example.org/a', path: '(rdfs:subClassOf)+', value: null });
    expect(out).not.toContain('<(rdfs:subClassOf)+>');
    expect(out).toContain('UNDEF');
  });

  it('emits UNDEF rather than a malformed IRI for a joined multi-value', () => {
    const out = undefFor({ focusNode: 'http://example.org/a', path: null, value: 'http://example.org/p1, http://example.org/p2' });
    expect(out).not.toContain('<http://example.org/p1, http://example.org/p2>');
    expect(out).toContain('UNDEF');
  });

  it('still emits a real single absolute IRI', () => {
    const out = undefFor({ focusNode: 'http://example.org/a', path: 'http://example.org/p', value: null });
    expect(out).toContain('<http://example.org/a>');
    expect(out).toContain('<http://example.org/p>');
  });
});
