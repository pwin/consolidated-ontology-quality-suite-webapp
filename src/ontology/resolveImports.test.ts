import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, afterEach } from 'vitest';
import { parseTurtle } from '../rdf/parseDocument';
import { resolveImports } from './resolveImports';

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const OWL_CLASS = 'http://www.w3.org/2002/07/owl#Class';
const RDFS_SUBCLASS_OF = 'http://www.w3.org/2000/01/rdf-schema#subClassOf';

describe('resolveImports against examples/tutorial (clinic.ttl imports core.ttl)', () => {
  const dir = path.resolve(__dirname, '../../examples/tutorial');

  it('resolves the import and merges core.ttl\'s classes in', async () => {
    const clinicPath = path.join(dir, 'clinic.ttl');
    const clinicDoc = parseTurtle(clinicPath, fs.readFileSync(clinicPath, 'utf8'));
    const { mergedQuads, report, resolvedFilePaths } = await resolveImports(clinicPath, clinicDoc.quads, dir);

    expect(report.resolved).toEqual(['http://example.org/clinic/core']);
    expect(report.unresolved).toEqual([]);
    expect(mergedQuads.length).toBeGreaterThan(clinicDoc.quads.length);
    expect(mergedQuads.some((q) => q.subject.value === 'http://example.org/clinic#Animal' && q.predicate.value === RDF_TYPE && q.object.value === OWL_CLASS)).toBe(true);
    expect(resolvedFilePaths).toEqual([path.join(dir, 'core.ttl')]);
  });
});

describe('resolveImports: real gist11 -> gist14.1.0 namespace-migration scenario (examples/gist)', () => {
  const gistDir = path.resolve(__dirname, '../../examples/gist');
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const d of tempDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  it('fleet-vehicle-gist11.ttl resolves against gist11.0.0, not gist14.1.0, even with both present', async () => {
    const fleetPath = path.join(gistDir, 'fleet-vehicle-gist11.ttl');
    const fleetDoc = parseTurtle(fleetPath, fs.readFileSync(fleetPath, 'utf8'));
    const { report, mergedQuads } = await resolveImports(fleetPath, fleetDoc.quads, gistDir);

    expect(report.resolved).toEqual(['https://ontologies.semanticarts.com/o/gistCore11.0.0']);
    expect(report.unresolved).toEqual([]);
    // gist11.0.0 is ~3200 triples; merging the wrong (14.1.0, ~2500 triple) version would be a different count.
    expect(mergedQuads.length).toBeGreaterThan(3000);
  });

  it('fleet-vehicle-gist14.ttl resolves against gist14.1.0, both present', async () => {
    const fleetPath = path.join(gistDir, 'fleet-vehicle-gist14.ttl');
    const fleetDoc = parseTurtle(fleetPath, fs.readFileSync(fleetPath, 'utf8'));
    const { report } = await resolveImports(fleetPath, fleetDoc.quads, gistDir);

    expect(report.resolved).toEqual(['https://w3id.org/semanticarts/ontology/gistCore14.1.0']);
    expect(report.unresolved).toEqual([]);
  });

  it('DRIFT: fleet-vehicle-gist11.ttl fails to resolve in a workspace upgraded to gist14.1.0 only, leaving its superclass references dangling', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gist-drift-'));
    tempDirs.push(tempDir);
    fs.copyFileSync(path.join(gistDir, 'gistCore14.1.0.ttl'), path.join(tempDir, 'gistCore14.1.0.ttl'));

    const fleetPath = path.join(gistDir, 'fleet-vehicle-gist11.ttl');
    const fleetDoc = parseTurtle(fleetPath, fs.readFileSync(fleetPath, 'utf8'));
    const { report, mergedQuads } = await resolveImports(fleetPath, fleetDoc.quads, tempDir);

    expect(report.resolved).toEqual([]);
    expect(report.unresolved).toEqual(['https://ontologies.semanticarts.com/o/gistCore11.0.0']);

    const declaredClasses = new Set(mergedQuads.filter((q) => q.predicate.value === RDF_TYPE && q.object.value === OWL_CLASS).map((q) => q.subject.value));
    const superclassTargets = fleetDoc.quads.filter((q) => q.predicate.value === RDFS_SUBCLASS_OF).map((q) => q.object.value);
    expect(superclassTargets.length).toBeGreaterThan(0);
    for (const target of superclassTargets) expect(declaredClasses.has(target)).toBe(false);
  });

  it('FIX: fleet-vehicle-gist14.ttl resolves cleanly in that same gist14.1.0-only workspace, with superclasses correctly declared', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gist-fixed-'));
    tempDirs.push(tempDir);
    fs.copyFileSync(path.join(gistDir, 'gistCore14.1.0.ttl'), path.join(tempDir, 'gistCore14.1.0.ttl'));

    const fleetPath = path.join(gistDir, 'fleet-vehicle-gist14.ttl');
    const fleetDoc = parseTurtle(fleetPath, fs.readFileSync(fleetPath, 'utf8'));
    const { report, mergedQuads } = await resolveImports(fleetPath, fleetDoc.quads, tempDir);

    expect(report.unresolved).toEqual([]);
    const declaredClasses = new Set(mergedQuads.filter((q) => q.predicate.value === RDF_TYPE && q.object.value === OWL_CLASS).map((q) => q.subject.value));
    const superclassTargets = fleetDoc.quads.filter((q) => q.predicate.value === RDFS_SUBCLASS_OF).map((q) => q.object.value);
    expect(superclassTargets.length).toBeGreaterThan(0);
    for (const target of superclassTargets) expect(declaredClasses.has(target)).toBe(true);
  });
});
