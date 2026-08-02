import * as fs from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import * as path from 'node:path';
import { Quad } from 'n3';
import { readOntologyDocument } from '../rdf/parseDocument';
import { OWL_IMPORTS, OWL_ONTOLOGY, OWL_VERSION_IRI, RDF_TYPE } from '../rdf/vocab';
import type { ImportResolution } from '../types';

const DEFAULT_IMPORT_GLOB_EXTENSIONS = ['.ttl', '.trig', '.nt', '.nq', '.turtle', '.owl', '.rdf', '.omn'];

interface CandidateFile {
  filePath: string;
  quads: Quad[];
  declaredIris: Set<string>;
}

/**
 * Ports ontology_evaluation.py::resolve_imports: local-first, transitive,
 * and matching an import target against both an ontology's own identity
 * IRI *and* its owl:versionIRI -- files commonly `owl:imports` a specific
 * version IRI while the imported file's own subject is the unversioned
 * base IRI, so matching identity alone leaves real, present-on-disk
 * imports unresolved. Candidate files are read via the format-aware
 * `readOntologyDocument` (v0.2.0) so an imported ontology can be in any
 * supported serialization, not just Turtle.
 */
export async function resolveImports(
  entryFilePath: string,
  entryQuads: Quad[],
  searchDir: string,
): Promise<{ mergedQuads: Quad[]; report: ImportResolution }> {
  const candidates = await scanCandidates(searchDir);
  const merged: Quad[] = [...entryQuads];
  const resolved: string[] = [];
  const excluded: string[] = [];
  const seenFiles = new Set<string>([path.resolve(entryFilePath)]);

  const pending = new Set<string>(declaredImportIris(entryQuads));
  const visited = new Set<string>();

  while (pending.size > 0) {
    const iri = pending.values().next().value as string;
    pending.delete(iri);
    if (visited.has(iri)) continue;
    visited.add(iri);

    const match = candidates.find((c) => c.declaredIris.has(iri) && !seenFiles.has(c.filePath));
    if (!match) {
      excluded.push(iri);
      continue;
    }
    seenFiles.add(match.filePath);
    resolved.push(iri);
    merged.push(...match.quads);
    for (const nested of declaredImportIris(match.quads)) {
      if (!visited.has(nested)) pending.add(nested);
    }
  }

  return {
    mergedQuads: merged,
    report: { resolved, unresolved: excluded, excluded: [], networkAllowed: false },
  };
}

function declaredImportIris(quads: Quad[]): string[] {
  return quads
    .filter((q) => q.predicate.value === OWL_IMPORTS && q.object.termType === 'NamedNode')
    .map((q) => q.object.value);
}

/** Matches candidate files against both their `a owl:Ontology` subject IRI and any `owl:versionIRI`. */
async function scanCandidates(dir: string): Promise<CandidateFile[]> {
  const out: CandidateFile[] = [];
  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      out.push(...(await scanCandidates(path.join(dir, entry.name))));
      continue;
    }
    const ext = path.extname(entry.name).toLowerCase();
    if (!DEFAULT_IMPORT_GLOB_EXTENSIONS.includes(ext)) continue;

    const filePath = path.join(dir, entry.name);
    let text: string;
    try {
      text = await fs.readFile(filePath, 'utf8');
    } catch {
      continue;
    }
    const { quads } = await readOntologyDocument(filePath, text);
    const declaredIris = new Set<string>();
    for (const q of quads) {
      if (q.predicate.value === RDF_TYPE && q.object.value === OWL_ONTOLOGY && q.subject.termType === 'NamedNode') {
        declaredIris.add(q.subject.value);
      }
      if (q.predicate.value === OWL_VERSION_IRI && q.object.termType === 'NamedNode') {
        declaredIris.add(q.object.value);
      }
    }
    if (declaredIris.size > 0) {
      out.push({ filePath, quads, declaredIris });
    }
  }
  return out;
}
