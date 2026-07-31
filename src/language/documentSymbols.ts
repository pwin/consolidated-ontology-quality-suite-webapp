import * as vscode from 'vscode';
import { parseTurtle } from '../rdf/parseDocument';
import { buildOntologyModel } from '../rdf/ontologyModel';
import { shrink } from '../rdf/vocab';

export function registerDocumentSymbolProvider(): vscode.Disposable {
  const provider: vscode.DocumentSymbolProvider = {
    provideDocumentSymbols(document) {
      const text = document.getText();
      const parsed = parseTurtle(document.uri.toString(), text);
      const model = buildOntologyModel(parsed.quads);
      const lines = text.split(/\r?\n/);

      const groups: Record<string, vscode.DocumentSymbol[]> = { class: [], objectProperty: [], datatypeProperty: [], annotationProperty: [], individual: [] };
      for (const term of model.terms.values()) {
        const line = findSubjectLine(lines, term.iri, parsed.prefixes);
        const range = new vscode.Range(line, 0, line, lines[line]?.length ?? 0);
        const name = term.label ?? shrink(term.iri, parsed.prefixes);
        for (const kind of term.kinds) {
          const symbolKind = kind === 'class' ? vscode.SymbolKind.Class : kind === 'individual' ? vscode.SymbolKind.Object : vscode.SymbolKind.Property;
          groups[kind]?.push(new vscode.DocumentSymbol(name, shrink(term.iri, parsed.prefixes), symbolKind, range, range));
        }
      }

      const root: vscode.DocumentSymbol[] = [];
      const labelFor: Record<string, string> = {
        class: 'Classes',
        objectProperty: 'Object Properties',
        datatypeProperty: 'Datatype Properties',
        annotationProperty: 'Annotation Properties',
        individual: 'Individuals',
      };
      for (const [kind, symbols] of Object.entries(groups)) {
        if (symbols.length === 0) continue;
        const groupRange = new vscode.Range(0, 0, 0, 0);
        const groupSymbol = new vscode.DocumentSymbol(labelFor[kind], `${symbols.length}`, vscode.SymbolKind.Namespace, groupRange, groupRange);
        groupSymbol.children = symbols;
        root.push(groupSymbol);
      }
      return root;
    },
  };
  return vscode.languages.registerDocumentSymbolProvider({ language: 'turtle' }, provider);
}

function findSubjectLine(lines: string[], iri: string, prefixes: Record<string, string>): number {
  const curie = shrinkLocal(iri, prefixes);
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trimStart();
    if (curie && (trimmed.startsWith(`${curie} `) || trimmed === curie)) return i;
    if (trimmed.startsWith(`<${iri}>`)) return i;
  }
  return 0;
}

function shrinkLocal(iri: string, prefixes: Record<string, string>): string | null {
  const s = shrink(iri, prefixes);
  return s === iri ? null : s;
}
