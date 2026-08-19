import * as vscode from 'vscode';
import { shrink, WELL_KNOWN_PREFIXES } from '../rdf/vocab';
import { detectSection, parseManchesterPrefixes, EXPRESSION_KEYWORDS, SECTION_KINDS, FRAME_KINDS } from './manchesterSection';
import type { TermKind } from '../rdf/ontologyModel';
import type { TermIndex } from './termIndex';

/**
 * Completion for OWL Manchester Syntax (`.omn`) -- previously had none at
 * all, despite the class-expression grammar built for it (see
 * rdf/formats/classExpression.ts). Manchester's frame/section keywords
 * give an unambiguous context signal (unlike Turtle's punctuation-based
 * position, this is just "what section line governs the cursor" --
 * manchesterSection.ts), so this is section-aware from the start rather
 * than needing the same heuristic token-counting completionContext.ts
 * uses for Turtle.
 */
export function registerManchesterCompletionProvider(index: TermIndex): vscode.Disposable {
  const provider: vscode.CompletionItemProvider = {
    async provideCompletionItems(document, position) {
      const linePrefix = document.lineAt(position).text.slice(0, position.character);
      const items: vscode.CompletionItem[] = [];
      const declared = parseManchesterPrefixes(document.getText());

      // Prefix completion at the start of a token.
      if (/(?:^|\s)([A-Za-z][\w-]*)?$/.test(linePrefix)) {
        const allPrefixes = { ...WELL_KNOWN_PREFIXES, ...declared };
        for (const [prefix, iri] of Object.entries(allPrefixes)) {
          const item = new vscode.CompletionItem(`${prefix}:`, vscode.CompletionItemKind.Module);
          item.detail = iri;
          items.push(item);
        }
      }

      const { section, frameKind } = detectSection(document.getText(), document.offsetAt(position));

      // Restriction/connective keywords, wherever a class expression is being written.
      if (section === 'SubClassOf' || section === 'EquivalentTo' || section === 'Types') {
        if (/(?:^|\s)([A-Za-z]*)$/.test(linePrefix)) {
          for (const kw of EXPRESSION_KEYWORDS) {
            items.push(new vscode.CompletionItem(kw, vscode.CompletionItemKind.Keyword));
          }
        }
      }

      // Term completion after a known prefix, filtered by section.
      const curieMatch = /([A-Za-z][\w-]*):(\w*)$/.exec(linePrefix);
      if (curieMatch) {
        if (!(await index.ensureBuiltQuietly())) return undefined;
        const [, prefix] = curieMatch;
        const ns = declared[prefix] ?? WELL_KNOWN_PREFIXES[prefix];
        if (ns) {
          const allPrefixes = { ...WELL_KNOWN_PREFIXES, ...declared };
          const allowedKinds = section === 'frame-header' ? (frameKind ? FRAME_KINDS[frameKind] : undefined) : SECTION_KINDS[section];

          for (const term of index.getModel().terms.values()) {
            if (!term.iri.startsWith(ns)) continue;
            if (allowedKinds && !term.kinds.some((k) => allowedKinds.includes(k))) continue;
            const local = term.iri.slice(ns.length);
            const item = new vscode.CompletionItem(local, kindFor(term.kinds));
            item.detail = term.label ?? shrink(term.iri, allPrefixes);
            item.documentation = term.comment ?? term.definition;
            item.insertText = local;
            items.push(item);
          }
        }
      }

      return items;
    },
  };
  return vscode.languages.registerCompletionItemProvider({ language: 'owl-manchester' }, provider, ':');
}

function kindFor(kinds: TermKind[]): vscode.CompletionItemKind {
  if (kinds.includes('class')) return vscode.CompletionItemKind.Class;
  if (kinds.includes('objectProperty') || kinds.includes('datatypeProperty')) return vscode.CompletionItemKind.Property;
  if (kinds.includes('individual')) return vscode.CompletionItemKind.Value;
  return vscode.CompletionItemKind.Text;
}
