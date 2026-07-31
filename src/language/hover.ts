import * as vscode from 'vscode';
import { parseTurtle, parseSparqlPrefixes } from '../rdf/parseDocument';
import { expand, shrink } from '../rdf/vocab';
import type { TermIndex } from './termIndex';

export function registerHoverProvider(index: TermIndex): vscode.Disposable {
  const provider: vscode.HoverProvider = {
    async provideHover(document, position) {
      const wordRange = document.getWordRangeAtPosition(position, /[A-Za-z][\w-]*:[A-Za-z_][\w-]*/);
      if (!wordRange) return undefined;
      const curie = document.getText(wordRange);

      const prefixes = document.languageId === 'turtle' ? parseTurtle(document.uri.toString(), document.getText()).prefixes : parseSparqlPrefixes(document.getText());
      const iri = expand(curie, prefixes);
      if (!iri) return undefined;

      await index.ensureBuilt();
      const term = index.lookupTerm(iri);
      if (!term) {
        return new vscode.Hover(new vscode.MarkdownString(`\`${iri}\`\n\n*(not declared in any workspace ontology)*`), wordRange);
      }

      const md = new vscode.MarkdownString();
      md.appendMarkdown(`**${term.label ?? shrink(iri, prefixes)}** \`${term.kinds.join(', ') || 'term'}\`\n\n`);
      md.appendMarkdown(`\`${iri}\`\n\n`);
      if (term.comment) md.appendMarkdown(`${term.comment}\n\n`);
      if (term.definition) md.appendMarkdown(`${term.definition}\n\n`);
      if (term.domain.length) md.appendMarkdown(`**Domain:** ${term.domain.map((d) => shrink(d, prefixes)).join(', ')}\n\n`);
      if (term.range.length) md.appendMarkdown(`**Range:** ${term.range.map((r) => shrink(r, prefixes)).join(', ')}\n\n`);
      if (term.subClassOf.length) md.appendMarkdown(`**subClassOf:** ${term.subClassOf.map((r) => shrink(r, prefixes)).join(', ')}\n\n`);
      return new vscode.Hover(md, wordRange);
    },
  };
  return vscode.languages.registerHoverProvider([{ language: 'turtle' }, { language: 'sparql-construct' }], provider);
}
