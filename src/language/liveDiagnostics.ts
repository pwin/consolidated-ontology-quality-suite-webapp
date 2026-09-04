import * as path from 'node:path';
import * as vscode from 'vscode';
import { parseN3Family } from '../rdf/formats/n3Family';
import { resolveImports } from '../ontology/resolveImports';
import { unresolvedImportMessage } from '../ontology/importDiagnostics';
import { stripComments } from '../triplify/bindAnalysis';
import { expand } from '../rdf/vocab';

const CURIE_TOKEN = /(^|[\s(),;.[\]{}])([A-Za-z][\w-]*):([A-Za-z_][\w-]*)/g;
const DEBOUNCE_MS = 600;

/**
 * Lightweight, always-on diagnostics for `.ttl` documents: syntax errors,
 * undeclared prefixes, and unresolved `owl:imports` -- fast enough to run
 * on every debounced edit, unlike the local checks engine (command-
 * triggered, see checks/runLocalChecks.ts) which spins up Oxigraph/
 * shacl-engine/EYE and is meant for an explicit "Run Local Checks".
 */
export class LiveDiagnosticsProvider implements vscode.Disposable {
  private readonly diagnostics = vscode.languages.createDiagnosticCollection('ontology-suite-live');
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor() {
    this.disposables.push(
      vscode.workspace.onDidOpenTextDocument((doc) => this.scheduleValidate(doc)),
      vscode.workspace.onDidChangeTextDocument((e) => this.scheduleValidate(e.document)),
      vscode.workspace.onDidCloseTextDocument((doc) => this.diagnostics.delete(doc.uri)),
    );
    for (const doc of vscode.workspace.textDocuments) this.scheduleValidate(doc, 0);
  }

  /** Drops every live diagnostic. Used by the Reset Index command, so a stale or
   *  wrong squiggle can be cleared without reloading the window. */
  clear(): void {
    this.diagnostics.clear();
  }

  dispose(): void {
    this.diagnostics.dispose();
    for (const d of this.disposables) d.dispose();
    for (const t of this.timers.values()) clearTimeout(t);
  }

  private scheduleValidate(document: vscode.TextDocument, delay = DEBOUNCE_MS): void {
    // Scoped to Turtle/TriG -- both parse synchronously/fast via N3, so live
    // per-edit diagnostics stay cheap. N-Triples/N-Quads have no @prefix/
    // owl:imports to check; RDF/XML and Manchester Syntax are rarely
    // hand-edited and go through the (async) universal reader elsewhere
    // (Run Local Checks, Show Metrics, Convert, Graph View, Query Workbench).
    if (document.languageId !== 'turtle' && document.languageId !== 'trig') return;
    const key = document.uri.toString();
    const existing = this.timers.get(key);
    if (existing) clearTimeout(existing);
    this.timers.set(
      key,
      setTimeout(() => void this.validate(document), delay),
    );
  }

  private async validate(document: vscode.TextDocument): Promise<void> {
    const text = document.getText();
    const format = document.languageId === 'trig' ? 'trig' : 'turtle';
    const parsed = parseN3Family(text, format);
    const diagnostics: vscode.Diagnostic[] = [];

    for (const err of parsed.errors) {
      const line = Math.min(err.line, document.lineCount - 1);
      const range = new vscode.Range(line, 0, line, document.lineAt(line).text.length);
      diagnostics.push(new vscode.Diagnostic(range, err.message, vscode.DiagnosticSeverity.Error));
    }

    if (document.uri.scheme === 'file') {
      const { report } = await resolveImports(document.uri.fsPath, parsed.quads, path.dirname(document.uri.fsPath));
      for (const unresolved of report.unresolved) {
        const line = findImportLine(text, unresolved);
        const range = new vscode.Range(line, 0, line, document.lineAt(line).text.length);
        diagnostics.push(
          new vscode.Diagnostic(range, unresolvedImportMessage(unresolved, report), vscode.DiagnosticSeverity.Warning),
        );
      }
    }

    for (const d of findUndeclaredPrefixUsages(document, text, parsed.prefixes)) diagnostics.push(d);

    this.diagnostics.set(document.uri, diagnostics);
  }
}

function findImportLine(text: string, iri: string): number {
  const lines = text.split(/\r?\n/);
  const idx = lines.findIndex((l) => l.includes(iri));
  return idx >= 0 ? idx : 0;
}

function findUndeclaredPrefixUsages(document: vscode.TextDocument, text: string, prefixes: Record<string, string>): vscode.Diagnostic[] {
  const diagnostics: vscode.Diagnostic[] = [];
  // Comments blanked, not dropped, so every column below still indexes the real
  // document. Skipping only lines that *begin* with `#` left a trailing comment
  // fully scanned, so `ex:Dog a owl:Class .  # TODO: use foo:Bar` reported an
  // undeclared prefix `foo:` against a remark -- a warning about text that is
  // not code. Same scanner, same reason, as language/curieScan.ts.
  const lines = stripComments(text).split(/\r?\n/);
  const reported = new Set<string>();
  for (let lineNo = 0; lineNo < lines.length; lineNo++) {
    const line = lines[lineNo];
    if (line.trimStart().startsWith('@prefix')) continue;
    CURIE_TOKEN.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = CURIE_TOKEN.exec(line))) {
      const [, leading, prefix, local] = m;
      if (expand(`${prefix}:${local}`, prefixes)) continue;
      if (reported.has(prefix)) continue;
      reported.add(prefix);
      const startCol = m.index + leading.length;
      const range = new vscode.Range(lineNo, startCol, lineNo, startCol + prefix.length + 1 + local.length);
      diagnostics.push(new vscode.Diagnostic(range, `Prefix '${prefix}:' is not declared with @prefix in this document.`, vscode.DiagnosticSeverity.Warning));
    }
  }
  return diagnostics;
}
