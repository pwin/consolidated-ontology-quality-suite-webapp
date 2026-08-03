import * as vscode from 'vscode';
import { shrink } from '../rdf/vocab';
import type { ParsedDocument, ResultRow, Severity } from '../types';

const SEVERITY_MAP: Record<Severity, vscode.DiagnosticSeverity> = {
  Violation: vscode.DiagnosticSeverity.Error,
  Warning: vscode.DiagnosticSeverity.Warning,
  Info: vscode.DiagnosticSeverity.Information,
  Hint: vscode.DiagnosticSeverity.Hint,
};

export const CHECKS_DIAGNOSTIC_SOURCE = 'ontology-suite';

/**
 * Maps ResultRow findings (from any engine -- local SPARQL/SHACL/reasoning/
 * guidance, or the Python CLI fallback) onto a specific document's
 * diagnostics. Findings are RDF-graph-shaped, not source-position-shaped,
 * so the line match is best-effort: it looks for the focus node's CURIE or
 * full IRI starting a line (the conventional Turtle subject-block style),
 * falling back to line 0 with the IRI spelled out in the message.
 */
export function resultRowsToDiagnostics(rows: ResultRow[], doc: ParsedDocument, rowsByDiagnostic?: WeakMap<vscode.Diagnostic, ResultRow>): vscode.Diagnostic[] {
  const diagnostics: vscode.Diagnostic[] = [];
  const lines = doc.text.split(/\r?\n/);

  for (const row of rows) {
    if (row.focusNode.startsWith('_:')) continue; // blank-node focus nodes have no stable textual anchor
    const line = findDeclaringLine(lines, row.focusNode, doc.prefixes);
    const range =
      line >= 0
        ? new vscode.Range(line, 0, line, lines[line]?.length ?? 0)
        : new vscode.Range(0, 0, 0, 0);

    const prefix = row.checkId ? `[${row.checkId}] ` : '';
    const suffix = line < 0 ? ` (focus: ${row.focusNode})` : '';
    const diagnostic = new vscode.Diagnostic(range, `${prefix}${row.message}${suffix}`, SEVERITY_MAP[row.severity]);
    diagnostic.source = CHECKS_DIAGNOSTIC_SOURCE;
    diagnostic.code = row.checkId ?? undefined;
    if (row.remediation) {
      diagnostic.relatedInformation = [
        new vscode.DiagnosticRelatedInformation(new vscode.Location(vscode.Uri.parse(doc.uri), range), `Remediation: ${row.remediation}`),
      ];
    }
    diagnostics.push(diagnostic);
    rowsByDiagnostic?.set(diagnostic, row);
  }
  return diagnostics;
}

function findDeclaringLine(lines: string[], focusIri: string, prefixes: Record<string, string>): number {
  const curie = shrink(focusIri, prefixes);
  const candidates = [curie, `<${focusIri}>`];
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trimStart();
    for (const candidate of candidates) {
      if (candidate && trimmed.startsWith(`${candidate} `)) return i;
      if (candidate && trimmed === candidate) return i;
    }
  }
  return -1;
}
