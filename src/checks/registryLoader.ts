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
  sparqlFiles: string[];
  shaclFiles: string[];
}

/**
 * Loads registry.json + sparql/**\/*.rq + shapes/*.ttl -- vendored from
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

  return {
    namespace: raw.namespace,
    checksById,
    sparqlFiles: walk(path.join(rootDir, 'sparql'), '.rq'),
    shaclFiles: walk(path.join(rootDir, 'shapes'), '.ttl'),
  };
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
    if (entry.isDirectory()) out.push(...walk(full, ext));
    else if (entry.name.endsWith(ext)) out.push(full);
  }
  return out;
}

/** Extracts the local name (check id) from an IRI like `.../oq:STR-001` or `https://.../STR-001`. */
export function localName(iri: string): string {
  const idx = Math.max(iri.lastIndexOf('#'), iri.lastIndexOf('/'));
  return idx >= 0 ? iri.slice(idx + 1) : iri;
}
