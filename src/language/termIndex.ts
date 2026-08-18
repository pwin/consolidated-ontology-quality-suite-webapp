import * as vscode from 'vscode';
import { parseTurtle, parseSparqlPrefixes } from '../rdf/parseDocument';
import { buildOntologyModel, TermInfo } from '../rdf/ontologyModel';
import { expand } from '../rdf/vocab';
import { findStatementLineRange } from './statementRange';
import type { Quad } from 'n3';

export interface TermOccurrence {
  uri: vscode.Uri;
  range: vscode.Range;
  iri: string;
  /** True if this occurrence looks like a declaration (subject of `a owl:Class`/etc.), not just a usage. */
  isDeclaration: boolean;
}

const CURIE_TOKEN = /(^|[\s(),;.[\]{}])((?:[A-Za-z][\w-]*)?):([A-Za-z_][\w-]*)/g;

/**
 * Workspace-wide index of ontology-term occurrences across `.ttl` and
 * `.rq`/`.sparql` files, built by a text scan (N3 doesn't report source
 * positions for parsed quads) cross-referenced against each file's own
 * prefix map. Backs completion, hover, go-to-definition, find-references,
 * and rename -- kept as one in-process module (see the plan's judgment
 * call to skip a separate LSP process for v1) rather than four
 * independent implementations.
 */
export class TermIndex {
  private byIri = new Map<string, TermOccurrence[]>();
  private mergedQuads: Quad[] = [];
  private mergedModel = buildOntologyModel([]);
  private building: Promise<void> | undefined;

  async ensureBuilt(): Promise<void> {
    // A failed build must not be cached. `building` holds the in-flight promise so
    // concurrent callers share one rebuild, but if it rejects and that rejection stays
    // memoised, *every* later hover, completion and go-to-definition re-throws the same
    // stale error until the next save happens to invalidate it -- which is how one bad
    // file turns into an editor that looks permanently broken. Clearing it lets the next
    // caller retry; rethrowing keeps the failure visible rather than silently serving an
    // empty index.
    if (!this.building) {
      this.building = this.rebuild().catch((err) => {
        this.building = undefined;
        throw err;
      });
    }
    return this.building;
  }

  invalidate(): void {
    this.building = undefined;
  }

  getOccurrences(iri: string): TermOccurrence[] {
    return this.byIri.get(iri) ?? [];
  }

  getModel() {
    return this.mergedModel;
  }

  private async rebuild(): Promise<void> {
    const byIri = new Map<string, TermOccurrence[]>();
    const allQuads: Quad[] = [];

    const ttlFiles = await vscode.workspace.findFiles('**/*.{ttl,owl}', '**/node_modules/**', 2000);
    const rqFiles = await vscode.workspace.findFiles('**/*.{rq,sparql}', '**/node_modules/**', 2000);

    for (const uri of ttlFiles) {
      const text = await readText(uri);
      if (text === undefined) continue;
      const parsed = parseTurtle(uri.toString(), text);
      for (const q of parsed.quads) allQuads.push(q);
      const declaredSubjects = new Set(parsed.quads.filter((q) => q.subject.termType === 'NamedNode').map((q) => q.subject.value));
      scanFileForCuries(uri, text, parsed.prefixes, byIri, declaredSubjects);
    }
    for (const uri of rqFiles) {
      const text = await readText(uri);
      if (text === undefined) continue;
      const prefixes = parseSparqlPrefixes(text);
      scanFileForCuries(uri, text, prefixes, byIri, new Set());
    }

    this.byIri = byIri;
    this.mergedQuads = allQuads;
    this.mergedModel = buildOntologyModel(allQuads);
  }

  getMergedQuads(): Quad[] {
    return this.mergedQuads;
  }

  lookupTerm(iri: string): TermInfo | undefined {
    return this.mergedModel.terms.get(iri);
  }
}

/**
 * vscode.Range-returning wrapper around language/statementRange.ts's pure line-range finder --
 * see that module for the algorithm and its documented limitations.
 */
export function findStatementRange(text: string, startLine: number): vscode.Range {
  const r = findStatementLineRange(text, startLine);
  return new vscode.Range(r.startLine, 0, r.endLine, r.endCol);
}

async function readText(uri: vscode.Uri): Promise<string | undefined> {
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    return new TextDecoder('utf-8').decode(bytes);
  } catch {
    return undefined;
  }
}

function scanFileForCuries(
  uri: vscode.Uri,
  text: string,
  prefixes: Record<string, string>,
  byIri: Map<string, TermOccurrence[]>,
  declarationSubjectIris: Set<string>,
): void {
  const lines = text.split(/\r?\n/);
  for (let lineNo = 0; lineNo < lines.length; lineNo++) {
    const line = lines[lineNo];
    if (line.trimStart().startsWith('#')) continue;
    CURIE_TOKEN.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = CURIE_TOKEN.exec(line))) {
      const leading = m[1];
      const prefix = m[2];
      const local = m[3];
      const curie = `${prefix}:${local}`;
      const iri = expand(curie, prefixes);
      if (!iri) continue;
      const startCol = m.index + leading.length;
      const endCol = startCol + curie.length;
      const range = new vscode.Range(lineNo, startCol, lineNo, endCol);
      const isDeclaration = declarationSubjectIris.has(iri) && startCol === line.search(/\S/);

      const list = byIri.get(iri) ?? [];
      list.push({ uri, range, iri, isDeclaration });
      byIri.set(iri, list);
    }
  }
}
