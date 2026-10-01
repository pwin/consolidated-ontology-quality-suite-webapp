import * as vscode from 'vscode';

import { serializeRdf, RdfFormat } from '../rdf/serialization';
import { renderAddedQuadsTurtle } from './repairTurtle';
import type { RepairOutcome } from './repairEngine';

/**
 * Applies a computed repair to its source document. 'insert'-kind fixes are
 * appended as new Turtle-style blocks (grouped by subject, IRIs shrunk to
 * the document's own prefixes where possible) -- the same append-only
 * approach ontology/scaffold.ts's Add Class/Add Property commands already
 * use, which preserves the rest of the file's hand-authored formatting and
 * comments exactly. 'replace'-kind fixes (a DELETE+INSERT touching existing
 * triples) can't in general be spliced into arbitrary existing syntax
 * without a real parser-preserving editor, so the whole document is
 * reserialized from the repaired graph instead -- this *will* lose
 * hand-authored formatting/comments, and the caller should warn the user
 * before applying (see checks/codeActionProvider.ts).
 */
export async function applyRepair(
  document: vscode.TextDocument,
  outcome: RepairOutcome,
  documentPrefixes: Record<string, string>,
  format: RdfFormat,
): Promise<void> {
  const edit = new vscode.WorkspaceEdit();
  if (outcome.kind === 'insert') {
    const block = renderAddedQuadsTurtle(outcome.addedQuads, documentPrefixes);
    if (!block) return;
    const endPos = new vscode.Position(document.lineCount, 0);
    edit.insert(document.uri, endPos, block);
  } else {
    const text = await serializeRdf(outcome.resultQuads, format, documentPrefixes);
    const fullRange = new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length));
    edit.replace(document.uri, fullRange, text);
  }
  await vscode.workspace.applyEdit(edit);
}
