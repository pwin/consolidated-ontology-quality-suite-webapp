import * as vscode from 'vscode';
import { Quad } from 'n3';
import { shrink } from '../rdf/vocab';
import { serializeRdf, RdfFormat } from '../rdf/serialization';
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

function renderAddedQuadsTurtle(quads: Quad[], prefixes: Record<string, string>): string {
  if (quads.length === 0) return '';
  const bySubject = new Map<string, Quad[]>();
  for (const q of quads) {
    const key = q.subject.value;
    if (!bySubject.has(key)) bySubject.set(key, []);
    bySubject.get(key)!.push(q);
  }
  const lines: string[] = [''];
  for (const [subject, subjectQuads] of bySubject) {
    lines.push(shrinkTerm(subject, prefixes));
    subjectQuads.forEach((q, i) => {
      const suffix = i === subjectQuads.length - 1 ? '.' : ';';
      lines.push(`  ${shrinkTerm(q.predicate.value, prefixes)} ${renderObject(q.object, prefixes)} ${suffix}`);
    });
    lines.push('');
  }
  return lines.join('\n');
}

function shrinkTerm(iri: string, prefixes: Record<string, string>): string {
  if (iri === 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type') return 'a';
  const curie = shrink(iri, prefixes);
  return curie === iri ? `<${iri}>` : curie;
}

function renderObject(term: Quad['object'], prefixes: Record<string, string>): string {
  if (term.termType === 'Literal') {
    const lit = term as import('n3').Literal;
    const escaped = lit.value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    if (lit.language) return `"${escaped}"@${lit.language}`;
    if (lit.datatype.value === 'http://www.w3.org/2001/XMLSchema#string') return `"${escaped}"`;
    return `"${escaped}"^^${shrinkTerm(lit.datatype.value, prefixes)}`;
  }
  if (term.termType === 'BlankNode') return `_:${term.value}`;
  return shrinkTerm(term.value, prefixes);
}
