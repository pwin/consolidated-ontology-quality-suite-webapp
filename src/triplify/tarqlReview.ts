import * as path from 'node:path';
import * as vscode from 'vscode';
import { CHECKS_DIAGNOSTIC_SOURCE } from '../checks/toDiagnostics';
import { analyseBinds, bindReportToRows, formatBindReport, type BindReport } from './bindAnalysis';

/** The query serializations `triplify/discovery.ts` pairs with CSVs; the same set is reviewed. */
const QUERY_EXTENSIONS = ['.rq', '.sparql', '.tarql', '.tq'];

export const TARQL_DIAGNOSTIC_SOURCE = `${CHECKS_DIAGNOSTIC_SOURCE}-tarql`;

/**
 * Runs the TARQL BIND review (`TQL-001`/`TQL-002`/`TQL-003`) over one folder of
 * CONSTRUCT queries and reports it two ways: as diagnostics on the queries
 * themselves, and as the reviewer-facing text report in an output channel.
 *
 * A folder rather than a file, because `TQL-001` is a *cross-file* finding --
 * one variable minted two different ways in two queries is invisible in either
 * one on its own, which is exactly why it survives review today. The other two
 * checks are per-file and would fit the live-diagnostics path, but they are
 * reported here alongside so that one command answers the whole question.
 */
export async function reviewTarqlBinds(
  folder: vscode.Uri,
  diagnostics: vscode.DiagnosticCollection,
  output: vscode.OutputChannel,
): Promise<BindReport | undefined> {
  const entries = await vscode.workspace.fs.readDirectory(folder);
  const queryPaths = entries
    .filter(([name, type]) => type === vscode.FileType.File && QUERY_EXTENSIONS.includes(path.extname(name).toLowerCase()))
    .map(([name]) => vscode.Uri.joinPath(folder, name))
    .sort((a, b) => a.fsPath.localeCompare(b.fsPath));

  if (queryPaths.length === 0) {
    void vscode.window.showInformationMessage(
      `Ontology Suite: no CONSTRUCT queries in ${path.basename(folder.fsPath)} (looked for ${QUERY_EXTENSIONS.join(', ')}).`,
    );
    return undefined;
  }

  const decoder = new TextDecoder('utf-8');
  const texts = new Map<string, string>();
  for (const uri of queryPaths) {
    texts.set(uri.fsPath, decoder.decode(await vscode.workspace.fs.readFile(uri)));
  }
  const report = analyseBinds([...texts].map(([source, text]) => ({ source, text })));

  diagnostics.clear();
  for (const [fsPath, byFile] of groupDiagnostics(report, texts)) {
    diagnostics.set(vscode.Uri.file(fsPath), byFile);
  }

  output.clear();
  output.appendLine(formatBindReport(report));
  output.show(true);

  const rows = bindReportToRows(report);
  const violations = rows.filter((r) => r.severity === 'Violation').length;
  void vscode.window.showInformationMessage(
    `Ontology Suite: reviewed ${queryPaths.length} quer${queryPaths.length === 1 ? 'y' : 'ies'}, ${report.bindCount} BIND statement(s) -- ` +
    `${report.drift.length} drifting variable(s), ${violations} unbound constructed IRI(s). See Problems and the TARQL BIND Review output.`,
  );
  return report;
}

/**
 * Findings to per-file diagnostics.
 *
 * The report's own `ResultRow` shape names the file in `path` and the variable in
 * `focusNode`, which is what a text review needs; a diagnostic needs a range, so
 * the anchor is recovered here from the line each report entry records and the
 * column of the variable on it.
 */
function groupDiagnostics(report: BindReport, texts: Map<string, string>): Map<string, vscode.Diagnostic[]> {
  const byFile = new Map<string, vscode.Diagnostic[]>();
  const add = (source: string, diagnostic: vscode.Diagnostic) => {
    const existing = byFile.get(source);
    if (existing) existing.push(diagnostic);
    else byFile.set(source, [diagnostic]);
  };

  for (const group of report.drift) {
    // Reported on every competing BIND rather than only the odd one out: which
    // of them is wrong is the reviewer's call, and pointing at one of them would
    // be asserting an answer this check does not have.
    const summary = group.variants.map((v) => v.skeleton).join('  ||  ');
    for (const variant of group.variants) {
      for (const statement of variant.statements) {
        const diagnostic = new vscode.Diagnostic(
          rangeFor(texts.get(statement.source), statement.line, group.target),
          `[TQL-001] ?${group.target} is bound by ${group.variants.length} structurally different expressions across ` +
          `${group.fileCount} files: ${summary}`,
          vscode.DiagnosticSeverity.Warning,
        );
        diagnostic.source = TARQL_DIAGNOSTIC_SOURCE;
        diagnostic.code = 'TQL-001';
        diagnostic.relatedInformation = group.variants
          .flatMap((v) => v.statements)
          .filter((b) => b !== statement)
          .map((b) => new vscode.DiagnosticRelatedInformation(
            new vscode.Location(vscode.Uri.file(b.source), rangeFor(texts.get(b.source), b.line, group.target)),
            `also bound here as: ${b.skeleton}`,
          ));
        add(statement.source, diagnostic);
      }
    }
  }

  for (const entry of report.unbound) {
    const constructed = entry.looksConstructed;
    const diagnostic = new vscode.Diagnostic(
      rangeFor(texts.get(entry.source), entry.line, entry.variable),
      constructed
        ? `[TQL-002] ?${entry.variable} is used in the CONSTRUCT template but never bound. Its name says it is ` +
          'constructed rather than read from a CSV column, so nothing will bind it and every triple using it is dropped.'
        : `[TQL-003] ?${entry.variable} is used in the CONSTRUCT template but not bound in the query. Ordinarily ` +
          'correct -- TARQL binds each CSV header as a variable of that name -- so confirm the column exists.',
      constructed ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Information,
    );
    diagnostic.source = TARQL_DIAGNOSTIC_SOURCE;
    diagnostic.code = constructed ? 'TQL-002' : 'TQL-003';
    add(entry.source, diagnostic);
  }
  return byFile;
}

/** The `?variable` token on `line` (one-based), or the whole line if it is not found there. */
function rangeFor(text: string | undefined, line: number, variable: string): vscode.Range {
  const zeroBased = Math.max(0, line - 1);
  const source = text?.split(/\r?\n/)[zeroBased];
  if (source === undefined) return new vscode.Range(zeroBased, 0, zeroBased, 0);

  const token = new RegExp(`[?$]${variable}\\b`).exec(source);
  return token
    ? new vscode.Range(zeroBased, token.index, zeroBased, token.index + token[0].length)
    : new vscode.Range(zeroBased, 0, zeroBased, source.length);
}
