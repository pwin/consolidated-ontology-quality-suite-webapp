import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The registry under `resources/checks-registry/` is a **copy**. The original
 * lives in `consolidated_ontology_suite_python/ontology_suite/resources/`, the
 * `ontologySuite.checksRegistryPath` setting can point this extension straight
 * at that checkout instead, and both copies are editable. So there are two
 * sources of truth for the same data and, until this was written, nothing that
 * noticed when they stopped agreeing.
 *
 * They had. The two copies differed in five registry fields and three whole
 * entries, none of it deliberate. The consequential one was CNF-003/CNF-004:
 * this copy's queries read gist-style `domainIncludes`, the Python suite's
 * native implementation read only `rdfs:domain`, and the descriptions had
 * drifted to match their own side. A gist ontology checked here produced
 * findings; the same ontology through the CLI produced silence.
 *
 * `registryCoverage.test.ts` is the other half of this: it pins which declared
 * checks *this* tier can produce. This one pins that the declaration itself is
 * the same document on both sides.
 *
 * Skipped when the Python checkout is not on this machine, which makes it a
 * test for whoever has both -- which is exactly who breaks it. Line endings
 * are excluded and only line endings: neither repo has a `.gitattributes`, so
 * `core.autocrlf` decides them per checkout, and that is git's business rather
 * than the registry's.
 */
const HERE = path.resolve(__dirname, '../../resources/checks-registry');

/** Query files this extension carries and the Python suite deliberately does not. */
const EXTENSION_ONLY_QUERIES = ['conformance/CNF-003.rq', 'conformance/CNF-004.rq'];

function findPythonResources(): string | undefined {
  const configured = process.env.ONTOLOGY_SUITE_PYTHON;
  const candidates = [
    ...(configured ? [path.join(configured, 'ontology_suite', 'resources')] : []),
    path.resolve(__dirname, '../../../consolidated_ontology_suite_python/ontology_suite/resources'),
  ];
  return candidates.find((dir) => fs.existsSync(path.join(dir, 'registry.json')));
}

/** Content with line endings normalised -- see the block comment above. */
function read(file: string): string {
  return fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
}

function tree(root: string, ext: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (ext === '*' || entry.name.endsWith(ext)) {
        out.set(path.relative(root, full).split(path.sep).join('/'), full);
      }
    }
  };
  if (fs.existsSync(root)) walk(root);
  return out;
}

const PYTHON = findPythonResources();

describe.skipIf(PYTHON === undefined)('shared registry parity with the Python suite', () => {
  const theirs = PYTHON as string;

  it('carries the same registry.json', () => {
    expect(read(path.join(HERE, 'registry.json'))).toBe(read(path.join(theirs, 'registry.json')));
  });

  it('carries the same shapes', () => {
    const ours = tree(path.join(HERE, 'shapes'), '.ttl');
    const other = tree(path.join(theirs, 'shapes'), '.ttl');
    expect([...ours.keys()].sort()).toEqual([...other.keys()].sort());
    for (const [name, file] of ours) expect(read(file), `shapes/${name} has drifted`).toBe(read(other.get(name) as string));
  });

  it('carries the same queries, bar the two conformance ones only this side has', () => {
    const ours = tree(path.join(HERE, 'sparql'), '.rq');
    const other = tree(path.join(theirs, 'sparql'), '.rq');

    // CNF-003/CNF-004 compare a data graph against a *separate* ontology. The
    // Python suite does that natively, having both graphs; this extension
    // merges a document with its imports into one graph before anything runs,
    // so it expresses the same two checks as single-graph CONSTRUCTs. They must
    // not be copied upstream: that suite runs every .rq in the tree against one
    // merged graph, where they would fire on the ontology's own axioms.
    expect([...ours.keys()].filter((k) => !other.has(k)).sort()).toEqual([...EXTENSION_ONLY_QUERIES].sort());
    expect([...other.keys()].filter((k) => !ours.has(k))).toEqual([]);

    for (const [name, file] of ours) {
      if (!other.has(name)) continue;
      expect(read(file), `sparql/${name} has drifted`).toBe(read(other.get(name) as string));
    }
  });

  it('carries the same repair templates', () => {
    // A repair whose template drifted rewrites the user's file differently
    // depending on which copy answered -- the one kind of drift here that
    // edits somebody's ontology.
    const ours = tree(path.join(HERE, 'repairs'), '*');
    const other = tree(path.join(theirs, 'repairs'), '*');
    expect([...ours.keys()].sort()).toEqual([...other.keys()].sort());
    for (const [name, file] of ours) expect(read(file), `repairs/${name} has drifted`).toBe(read(other.get(name) as string));
  });
});
