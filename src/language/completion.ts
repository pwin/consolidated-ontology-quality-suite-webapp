import * as vscode from 'vscode';
import { parseTurtle, parseSparqlPrefixes } from '../rdf/parseDocument';
import { shrink, WELL_KNOWN_PREFIXES } from '../rdf/vocab';
import { parseCsv } from '../triplify/csv';
import { findPair } from '../triplify/discovery';
import { detectPosition, expectedKinds } from './completionContext';
import type { TermKind } from '../rdf/ontologyModel';
import type { TermIndex } from './termIndex';

export function registerCompletionProvider(index: TermIndex): vscode.Disposable {
  const provider: vscode.CompletionItemProvider = {
    async provideCompletionItems(document, position) {
      const linePrefix = document.lineAt(position).text.slice(0, position.character);
      const items: vscode.CompletionItem[] = [];

      // `?var` completion in .rq files -- CSV column names, when a CSV is linked by filename convention.
      if (document.languageId === 'sparql-construct' && /\?\w*$/.test(linePrefix)) {
        const csvPath = findPair(document.uri.fsPath);
        if (csvPath) {
          try {
            const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(csvPath));
            const { headers } = parseCsv(new TextDecoder('utf-8').decode(bytes), 1);
            for (const h of headers) {
              const item = new vscode.CompletionItem(h, vscode.CompletionItemKind.Variable);
              item.detail = `CSV column (from ${csvPath.split(/[\\/]/).pop()})`;
              items.push(item);
            }
          } catch {
            /* no linked CSV readable yet -- fine, just no column completions */
          }
        }
      }

      // Prefix-name completion: declared + well-known prefixes.
      const prefixMatch = /(?:^|\s)([A-Za-z][\w-]*)?$/.exec(linePrefix);
      if (prefixMatch) {
        const declared = document.languageId === 'turtle' ? parseTurtle(document.uri.toString(), document.getText()).prefixes : parseSparqlPrefixes(document.getText());
        const allPrefixes = { ...WELL_KNOWN_PREFIXES, ...declared };
        for (const [prefix, iri] of Object.entries(allPrefixes)) {
          const item = new vscode.CompletionItem(`${prefix}:`, vscode.CompletionItemKind.Module);
          item.detail = iri;
          items.push(item);
        }
      }

      // Term completion after a known prefix: classes/properties from the workspace-wide index,
      // filtered by cursor position (predicate slot -> properties only, object of `a` -> classes
      // only, etc. -- see completionContext.ts) so a large vocabulary doesn't drown the list in
      // kinds that can't be syntactically valid here. Filtering fails open: anything the position
      // detector can't confidently classify shows every kind, same as before.
      const curieMatch = /([A-Za-z][\w-]*):(\w*)$/.exec(linePrefix);
      if (curieMatch) {
        await index.ensureBuilt();
        const [, prefix] = curieMatch;
        const declared = document.languageId === 'turtle' ? parseTurtle(document.uri.toString(), document.getText()).prefixes : parseSparqlPrefixes(document.getText());
        const ns = declared[prefix] ?? WELL_KNOWN_PREFIXES[prefix];
        if (ns) {
          const textBeforeCursor = document.getText(new vscode.Range(new vscode.Position(0, 0), position));
          const allPrefixes = { ...WELL_KNOWN_PREFIXES, ...declared };
          const allowedKinds = expectedKinds(detectPosition(textBeforeCursor), allPrefixes);

          for (const term of index.getModel().terms.values()) {
            if (!term.iri.startsWith(ns)) continue;
            if (allowedKinds && !term.kinds.some((k) => allowedKinds.includes(k))) continue;
            const local = term.iri.slice(ns.length);
            const item = new vscode.CompletionItem(local, kindFor(term.kinds));
            item.detail = term.label ?? shrink(term.iri, declared);
            item.documentation = term.comment ?? term.definition;
            item.insertText = local;
            items.push(item);
          }
        }
      }

      return items;
    },
  };
  return vscode.languages.registerCompletionItemProvider([{ language: 'turtle' }, { language: 'sparql-construct' }], provider, ':', '?');
}

function kindFor(kinds: TermKind[]): vscode.CompletionItemKind {
  if (kinds.includes('class')) return vscode.CompletionItemKind.Class;
  if (kinds.includes('objectProperty') || kinds.includes('datatypeProperty')) return vscode.CompletionItemKind.Property;
  if (kinds.includes('individual')) return vscode.CompletionItemKind.Value;
  return vscode.CompletionItemKind.Text;
}
