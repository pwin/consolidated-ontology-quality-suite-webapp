import * as vscode from 'vscode';
import { parseTurtle, parseSparqlPrefixes } from '../rdf/parseDocument';
import { expand } from '../rdf/vocab';
import type { TermIndex } from './termIndex';

function iriAtPosition(document: vscode.TextDocument, position: vscode.Position): { iri: string; range: vscode.Range } | undefined {
  const wordRange = document.getWordRangeAtPosition(position, /[A-Za-z][\w-]*:[A-Za-z_][\w-]*/);
  if (!wordRange) return undefined;
  const curie = document.getText(wordRange);
  const prefixes = document.languageId === 'turtle' ? parseTurtle(document.uri.toString(), document.getText()).prefixes : parseSparqlPrefixes(document.getText());
  const iri = expand(curie, prefixes);
  return iri ? { iri, range: wordRange } : undefined;
}

export function registerDefinitionProvider(index: TermIndex): vscode.Disposable {
  const provider: vscode.DefinitionProvider = {
    async provideDefinition(document, position) {
      const hit = iriAtPosition(document, position);
      if (!hit) return undefined;
      if (!(await index.ensureBuiltQuietly())) return undefined;
      const occurrences = index.getOccurrences(hit.iri).filter((o) => o.isDeclaration);
      return occurrences.map((o) => new vscode.Location(o.uri, o.range.start));
    },
  };
  return vscode.languages.registerDefinitionProvider([{ language: 'turtle' }, { language: 'sparql-construct' }], provider);
}

export function registerReferenceProvider(index: TermIndex): vscode.Disposable {
  const provider: vscode.ReferenceProvider = {
    async provideReferences(document, position) {
      const hit = iriAtPosition(document, position);
      if (!hit) return undefined;
      if (!(await index.ensureBuiltQuietly())) return undefined;
      return index.getOccurrences(hit.iri).map((o) => new vscode.Location(o.uri, o.range));
    },
  };
  return vscode.languages.registerReferenceProvider([{ language: 'turtle' }, { language: 'sparql-construct' }], provider);
}

/** Workspace-wide rename backed by the same term index used for completion/go-to-definition (see the plan's "Differentiators"). */
export function registerRenameProvider(index: TermIndex): vscode.Disposable {
  const provider: vscode.RenameProvider = {
    async prepareRename(document, position) {
      const hit = iriAtPosition(document, position);
      if (!hit) throw new Error('Not renameable here.');
      return hit.range;
    },
    async provideRenameEdits(document, position, newLocalName) {
      const hit = iriAtPosition(document, position);
      if (!hit) return undefined;
      if (!/^[A-Za-z_][\w-]*$/.test(newLocalName)) {
        void vscode.window.showErrorMessage('New name must be a valid Turtle local name.');
        return undefined;
      }
      if (!(await index.ensureBuiltQuietly())) return undefined;
      const occurrences = index.getOccurrences(hit.iri);
      const edit = new vscode.WorkspaceEdit();
      for (const occ of occurrences) {
        const text = (await vscode.workspace.openTextDocument(occ.uri)).getText(occ.range);
        const prefix = text.split(':')[0];
        edit.replace(occ.uri, occ.range, `${prefix}:${newLocalName}`);
      }
      return edit;
    },
  };
  return vscode.languages.registerRenameProvider([{ language: 'turtle' }, { language: 'sparql-construct' }], provider);
}
