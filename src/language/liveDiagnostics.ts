import * as path from 'node:path';
import * as vscode from 'vscode';
import { parseTurtle } from '../rdf/parseDocument';
import { resolveImports } from '../ontology/resolveImports';
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

  dispose(): void {
    this.diagnostics.dispose();
    for (const d of this.disposables) d.dispose();
    for (const t of this.timers.values()) clearTimeout(t);
  }

  private scheduleValidate(document: vscode.TextDocument, delay = DEBOUNCE_MS): void {
    if (document.languageId !== 'turtle') return;
    const key = document.uri.toString();
    const existing = this.timers.get(key);
    if (existing) clearTimeout(existing);
    this.timers.set(
      key,
      setTimeout(() => this.validate(document), delay),
    );
  }

  private validate(document: vscode.TextDocument): void {
    const text = document.getText();
    const parsed = parseTurtle(document.uri.toString(), text);
    const diagnostics: vscode.Diagnostic[] = [];

    for (const err of parsed.errors) {
      const line = Math.min(err.line, document.lineCount - 1);
      const range = new vscode.Range(line, 0, line, document.lineAt(line).text.length);
      diagnostics.push(new vscode.Diagnostic(range, err.message, vscode.DiagnosticSeverity.Error));
    }

    if (document.uri.scheme === 'file') {
      const { report } = resolveImports(document.uri.fsPath, parsed.quads, path.dirname(document.uri.fsPath));
      for (const unresolved of report.unresolved) {
        const line = findImportLine(text, unresolved);
        const range = new vscode.Range(line, 0, line, document.lineAt(line).text.length);
        diagnostics.push(
          new vscode.Diagnostic(
            range,
            `owl:imports <${unresolved}> could not be resolved locally (no workspace file declares this identity or owl:versionIRI).`,
            vscode.DiagnosticSeverity.Warning,
          ),
        );
      }
    }

    diagnostics.push(...findUndeclaredPrefixUsages(document, text, parsed.prefixes));

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
  const lines = text.split(/\r?\n/);
  const reported = new Set<string>();
  for (let lineNo = 0; lineNo < lines.length; lineNo++) {
    const line = lines[lineNo];
    if (line.trimStart().startsWith('@prefix') || line.trimStart().startsWith('#')) continue;
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
