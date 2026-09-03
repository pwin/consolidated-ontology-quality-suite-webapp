import * as fs from 'node:fs';
import * as path from 'node:path';

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

/** Extracts the local name (check id) from an IRI like `.../oq:STR-001` or `https://.../STR-001`. */
export function localName(iri: string): string {
  const idx = Math.max(iri.lastIndexOf('#'), iri.lastIndexOf('/'));
  return idx >= 0 ? iri.slice(idx + 1) : iri;
}
