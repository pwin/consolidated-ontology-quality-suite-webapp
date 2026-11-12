import * as fs from 'node:fs';
import * as path from 'node:path';
import { Parser } from 'n3';

export interface CheckDef {
  id: string;
  category: string;
  title: string;
  default_severity: 'Violation' | 'Warning' | 'Info';
  description: string;
  remediation: string;
}

export interface Registry {
  namespace: string;
  checksById: Map<string, CheckDef>;
  /** Queries that read an ontology or data graph -- everything this extension can run. */
  sparqlFiles: string[];
  /** Queries that read a graph this extension does not build; see SUBJECT_SPECIFIC_DIRS. */
  subjectSpecificSparqlFiles: string[];
  shaclFiles: string[];
}

/**
 * Query subdirectories whose checks read a graph that is not an ontology or a
 * data graph, and which this extension therefore cannot run.
 *
 * `sparql/tarql/` holds checks over the Python suite's BIND *facts* graph --
 * one node per `BIND` statement carrying its target, expression, skeleton,
 * file and line, built by `sketch/bind_analysis.py::bind_report_to_graph`.
 * Nothing here builds that graph, so those queries would parse, run against
 * the document, and match nothing.
 *
 * Excluded by name rather than left to match nothing anyway. A check that
 * runs everywhere and is silent everywhere is indistinguishable from one that
 * has quietly stopped working, and counting it as "implemented" would make
 * `registryCoverage.test.ts` assert something false: the id would look
 * runnable here when it can only ever come from the CLI.
 */
export const SUBJECT_SPECIFIC_DIRS = ['tarql'];

/**
 * Loads registry.json + sparql/**\/*.rq + shapes/*.ttl -- copied from
 * consolidated_ontology_suite under resources/checks-registry by default,
 * or a user-configured checkout (ontologySuite.checksRegistryPath) so a
 * newer/local registry can be picked up without repackaging the extension.
 */
export function loadRegistry(rootDir: string): Registry {
  const registryJsonPath = path.join(rootDir, 'registry.json');
  const raw = JSON.parse(fs.readFileSync(registryJsonPath, 'utf8')) as {
    namespace: string;
    checks: CheckDef[];
  };
  const checksById = new Map<string, CheckDef>();
  for (const check of raw.checks) checksById.set(check.id, check);

  const sparqlRoot = path.join(rootDir, 'sparql');
  const allSparql = walk(sparqlRoot, '.rq');

  return {
    namespace: raw.namespace,
    checksById,
    sparqlFiles: allSparql.filter((f) => !isSubjectSpecific(sparqlRoot, f)),
    subjectSpecificSparqlFiles: allSparql.filter((f) => isSubjectSpecific(sparqlRoot, f)),
    shaclFiles: walk(path.join(rootDir, 'shapes'), '.ttl'),
  };
}

function isSubjectSpecific(sparqlRoot: string, file: string): boolean {
  const parts = path.relative(sparqlRoot, file).split(path.sep).slice(0, -1);
  return parts.some((p) => SUBJECT_SPECIFIC_DIRS.includes(p));
}

function walk(dir: string, ext: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) for (const f of walk(full, ext)) out.push(f);
    else if (entry.name.endsWith(ext)) out.push(full);
  }
  return out;
}

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const SHAPE_TYPES = new Set(['http://www.w3.org/ns/shacl#NodeShape', 'http://www.w3.org/ns/shacl#PropertyShape']);

/**
 * The distinct check ids a registry's shapes declare, counted as the Python suite's
 * `declared_check_ids` counts them: a named shape's id is its local name, unless it carries an
 * `oq:checkId` annotation naming the check it belongs to. The annotation is what makes
 * `STY-002-data` and `STY-002-obj` one check rather than two. Deliberately not filtered by
 * registry.json, since a project's own shapes name ids the bundled registry has never heard of.
 */
export function shapeCheckIds(registry: Registry): Set<string> {
  const ids = new Set<string>();
  for (const file of registry.shaclFiles) {
    let quads;
    try {
      quads = new Parser().parse(fs.readFileSync(file, 'utf8'));
    } catch {
      continue; // a file that does not parse runs nothing; the SHACL tier reports it when it runs
    }
    const shapes = new Set<string>();
    const annotated = new Map<string, string>();
    for (const q of quads) {
      if (q.subject.termType !== 'NamedNode') continue;
      if (q.predicate.value === RDF_TYPE && SHAPE_TYPES.has(q.object.value)) shapes.add(q.subject.value);
      // By local name, as shaclRunner.ts matches it: the shapes and registry.json have disagreed
      // about which namespace `oq:` is.
      if (localName(q.predicate.value) === 'checkId' && q.object.termType === 'Literal') annotated.set(q.subject.value, q.object.value);
    }
    for (const shape of shapes) ids.add(annotated.get(shape) ?? localName(shape));
  }
  return ids;
}

/** The check ids a registry has a query or a shape for here: what *Run Local Checks* runs from it. */
export function runnableCheckIds(registry: Registry): Set<string> {
  return new Set([...registry.sparqlFiles.map((f) => path.basename(f, '.rq')), ...shapeCheckIds(registry)]);
}

/**
 * The checks `bundled` runs that `configured` does not, sorted.
 *
 * `ontologySuite.checksRegistryPath` replaces the bundled registry, queries and shapes as one set
 * rather than adding to them, so a directory holding only a project's own checks stops every
 * shipped check -- and says nothing, and the next run reports clean. The Python suite found the
 * same failure in its `--sparql` (a CI gate running 8 of 61 checks) and then its `--shapes` (1
 * finding where there were 37). This is what the warning about it counts.
 */
export function checksNotIn(bundled: Registry, configured: Registry): string[] {
  const kept = runnableCheckIds(configured);
  return [...runnableCheckIds(bundled)].filter((id) => !kept.has(id)).sort();
}

/** Extracts the local name (check id) from an IRI like `.../oq:STR-001` or `https://.../STR-001`. */
export function localName(iri: string): string {
  const idx = Math.max(iri.lastIndexOf('#'), iri.lastIndexOf('/'));
  return idx >= 0 ? iri.slice(idx + 1) : iri;
}
