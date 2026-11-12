import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { checksNotIn, loadRegistry, localName, runnableCheckIds, shapeCheckIds } from './registryLoader';

describe('loadRegistry against the copied-in resources/checks-registry', () => {
  const registry = loadRegistry(path.resolve(__dirname, '../../resources/checks-registry'));

  it('loads all 61 registry.json checks', () => {
    expect(registry.checksById.size).toBe(61);
    expect(registry.checksById.get('STR-001')?.category).toBe('structural');
    // TQL-001..003 are native (checks/../triplify/bindAnalysis.ts) and have no
    // sparql/shapes file of their own, but they are registry entries like any
    // other -- their rows resolve title/severity/remediation the same way.
    expect(registry.checksById.get('TQL-001')?.category).toBe('tarql');
    // REA-005/REA-006 and VOC-001 are likewise native, and likewise declared here:
    // an id a tier emits without a registry entry is one nothing can look up.
    // checks/registryCoverage.test.ts pins both directions of that.
    expect(registry.checksById.get('VOC-001')?.category).toBe('vocabulary');
  });

  it('finds sparql/**/*.rq and shapes/*.ttl files', () => {
    expect(registry.sparqlFiles.length).toBeGreaterThan(30);
    expect(registry.shaclFiles).toHaveLength(6);
  });

  it('keeps queries over a graph this extension does not build out of the runner', () => {
    // sparql/tarql/ reads the Python suite's BIND facts graph. Loading it into
    // `sparqlFiles` would run it against every ontology document, where it
    // matches nothing -- and would count it as an implementation this
    // extension does not have.
    expect(registry.subjectSpecificSparqlFiles.map((f) => path.basename(f)).sort())
      .toEqual(['TQL-004.rq', 'TQL-005.rq']);
    expect(registry.sparqlFiles.some((f) => f.includes('TQL-00'))).toBe(false);
  });
});

describe('localName', () => {
  it('extracts the local name after # or /', () => {
    expect(localName('https://semantechs.co.uk/ontology-quality/STR-001')).toBe('STR-001');
    expect(localName('http://example.org/ns#Foo')).toBe('Foo');
  });
});

/**
 * What a configured registry leaves out. `ontologySuite.checksRegistryPath` replaces the bundled
 * registry, queries and shapes as one set, so a directory of a project's own checks stops every
 * shipped one -- the failure the Python suite found in its `--sparql` and then its `--shapes`.
 */
describe('checks a configured registry leaves out', () => {
  const bundled = loadRegistry(path.resolve(__dirname, '../../resources/checks-registry'));

  /** A registry directory in the temp folder, from relative path -> content. */
  function tree(files: Record<string, string>): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ontology-suite-registry-'));
    for (const [rel, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), content);
    }
    return root;
  }
  const HOUSE_REGISTRY = JSON.stringify({
    namespace: bundled.namespace,
    checks: [{ id: 'LIB-001', category: 'house', title: 'House rule', default_severity: 'Violation', description: 'd', remediation: 'r' }],
  });
  const HOUSE_SHAPE = [
    `@prefix oq: <${bundled.namespace}> .`,
    '@prefix sh: <http://www.w3.org/ns/shacl#> .',
    '@prefix owl: <http://www.w3.org/2002/07/owl#> .',
    'oq:LIB-001-a a sh:NodeShape ; oq:checkId "LIB-001" ; sh:targetClass owl:Class .',
    'oq:LIB-001-b a sh:NodeShape ; oq:checkId "LIB-001" ; sh:targetClass owl:ObjectProperty .',
  ].join('\n');

  it("counts the bundled shapes' checks as the Python suite does: 21, split shapes once", () => {
    // The same 21 ids as that suite's `declared_check_ids` over the same files (registryParity
    // keeps them the same files). STY-002 is two shapes annotated with one oq:checkId.
    const ids = [...shapeCheckIds(bundled)].sort();
    expect(ids).toHaveLength(21);
    expect(ids).toContain('STY-002');
    expect(ids.filter((id) => id.startsWith('STY-002-'))).toEqual([]);
  });

  it('runs a check here when the registry has a query or a shape for it', () => {
    const runnable = runnableCheckIds(bundled);
    for (const file of bundled.sparqlFiles) expect(runnable.has(path.basename(file, '.rq'))).toBe(true);
    for (const id of shapeCheckIds(bundled)) expect(runnable.has(id)).toBe(true);
    expect(checksNotIn(bundled, bundled)).toEqual([]);
  });

  it('names every bundled check a directory of house checks leaves out', () => {
    const root = tree({
      'registry.json': HOUSE_REGISTRY,
      'sparql/house/LIB-001.rq': 'CONSTRUCT { } WHERE { }',
      'shapes/house.ttl': HOUSE_SHAPE,
    });
    try {
      const house = loadRegistry(root);
      expect([...runnableCheckIds(house)]).toEqual(['LIB-001']);
      expect(checksNotIn(bundled, house)).toEqual([...runnableCheckIds(bundled)].sort());
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('names nothing when the house checks were added to a copy of the bundled ones', () => {
    const files: Record<string, string> = { 'shapes/house.ttl': HOUSE_SHAPE, 'sparql/house/LIB-001.rq': 'CONSTRUCT { } WHERE { }' };
    const bundledRoot = path.resolve(__dirname, '../../resources/checks-registry');
    for (const file of [...bundled.sparqlFiles, ...bundled.subjectSpecificSparqlFiles, ...bundled.shaclFiles, path.join(bundledRoot, 'registry.json')]) {
      files[path.relative(bundledRoot, file)] = fs.readFileSync(file, 'utf8');
    }
    const root = tree(files);
    try {
      const merged = loadRegistry(root);
      expect(checksNotIn(bundled, merged)).toEqual([]);
      expect(runnableCheckIds(merged).has('LIB-001')).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('runs nothing from a shapes file that does not parse, rather than failing the count', () => {
    const root = tree({ 'registry.json': HOUSE_REGISTRY, 'shapes/broken.ttl': 'oq:LIB-001 a' });
    try {
      expect(shapeCheckIds(loadRegistry(root)).size).toBe(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
