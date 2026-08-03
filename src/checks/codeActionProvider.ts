import * as vscode from 'vscode';
import type { ResultRow } from '../types';
import { hasRepairTemplate } from './repairEngine';
import { CHECKS_DIAGNOSTIC_SOURCE } from './toDiagnostics';

export const APPLY_REPAIR_COMMAND = 'ontologySuite.applyRepair';

/**
 * Schematron-Quick-Fix-style lightbulb: offered only when the diagnostic
 * came from the local checks engine (source === CHECKS_DIAGNOSTIC_SOURCE)
 * and its originating ResultRow's checkId has a registered repair template.
 * Only line-oriented Turtle-family languages are registered as this
 * provider's targets (see extension.ts) -- the insert-kind repairs append
 * raw Turtle text, which isn't valid to splice into RDF/XML or Manchester.
 */
export class OntologyRepairCodeActionProvider implements vscode.CodeActionProvider {
  static readonly providedCodeActionKinds = [vscode.CodeActionKind.QuickFix];

  constructor(
    private readonly getRepairsRootDir: () => string,
    private readonly rowsByDiagnostic: WeakMap<vscode.Diagnostic, ResultRow>,
  ) {}

  provideCodeActions(document: vscode.TextDocument, _range: vscode.Range | vscode.Selection, context: vscode.CodeActionContext): vscode.CodeAction[] {
    const repairsRootDir = this.getRepairsRootDir();
    const actions: vscode.CodeAction[] = [];
    for (const diagnostic of context.diagnostics) {
      if (diagnostic.source !== CHECKS_DIAGNOSTIC_SOURCE) continue;
      const row = this.rowsByDiagnostic.get(diagnostic);
      if (!row?.checkId || !hasRepairTemplate(repairsRootDir, row.checkId)) continue;

      const action = new vscode.CodeAction(`Ontology Suite: Fix ${row.checkId} (${row.title ?? 'apply repair'})`, vscode.CodeActionKind.QuickFix);
      action.diagnostics = [diagnostic];
      action.command = { command: APPLY_REPAIR_COMMAND, title: 'Apply Ontology Suite repair', arguments: [document.uri, row] };
      actions.push(action);
    }
    return actions;
  }
}
