import * as vscode from 'vscode';
import { parseTurtle } from '../rdf/parseDocument';
import { buildOntologyModel, OntologyModel, TermInfo } from '../rdf/ontologyModel';
import { buildHierarchyIndex, childrenOf } from '../rdf/hierarchy';
import { shrink } from '../rdf/vocab';

type GroupKind = 'class' | 'objectProperty' | 'datatypeProperty' | 'individual';

type OutlineNode =
  | { kind: 'root'; uri: vscode.Uri }
  | { kind: 'group'; groupKind: GroupKind; label: string; model: OntologyModel; prefixes: Record<string, string> }
  | { kind: 'term'; term: TermInfo; groupKind: GroupKind; model: OntologyModel; prefixes: Record<string, string>; ancestorPath: ReadonlySet<string> };

/**
 * Explorer-integrated Ontology Outline for the active .ttl document:
 * classes and properties are shown as a Protege-style nested hierarchy
 * (rdfs:subClassOf / rdfs:subPropertyOf), with object and datatype
 * properties kept as separate subtrees; individuals remain a flat list
 * (they have no such hierarchy to nest under).
 */
export class OntologyOutlineProvider implements vscode.TreeDataProvider<OutlineNode> {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  private activeUri: vscode.Uri | undefined;
  /** Rebuilt once per refresh() cycle, not once per tree-node expansion -- expanding a hierarchy is O(nodes), not O(nodes^2). */
  private context: { uri: vscode.Uri; model: OntologyModel; prefixes: Record<string, string> } | undefined;
  private hierarchyCache = new Map<Exclude<GroupKind, 'individual'>, ReturnType<typeof buildHierarchyIndex>>();

  constructor() {
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor && editor.document.languageId === 'turtle') {
        this.activeUri = editor.document.uri;
        this.refresh();
      }
    });
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (doc.uri.toString() === this.activeUri?.toString()) this.refresh();
    });
    if (vscode.window.activeTextEditor?.document.languageId === 'turtle') {
      this.activeUri = vscode.window.activeTextEditor.document.uri;
    }
  }

  refresh(): void {
    this.context = undefined;
    this.hierarchyCache.clear();
    this.onDidChangeTreeDataEmitter.fire();
  }

  private async getContext(uri: vscode.Uri): Promise<{ model: OntologyModel; prefixes: Record<string, string> }> {
    if (this.context && this.context.uri.toString() === uri.toString()) return this.context;
    const doc = await vscode.workspace.openTextDocument(uri);
    const parsed = parseTurtle(uri.toString(), doc.getText());
    const model = buildOntologyModel(parsed.quads);
    this.context = { uri, model, prefixes: parsed.prefixes };
    this.hierarchyCache.clear();
    return this.context;
  }

  private getHierarchy(model: OntologyModel, groupKind: Exclude<GroupKind, 'individual'>): ReturnType<typeof buildHierarchyIndex> {
    let cached = this.hierarchyCache.get(groupKind);
    if (!cached) {
      cached = buildHierarchyIndex(model, groupKind);
      this.hierarchyCache.set(groupKind, cached);
    }
    return cached;
  }

  getTreeItem(element: OutlineNode): vscode.TreeItem {
    if (element.kind === 'root') {
      const item = new vscode.TreeItem(element.uri.path.split('/').pop() ?? 'Ontology', vscode.TreeItemCollapsibleState.Expanded);
      item.contextValue = 'ontologyRoot';
      item.resourceUri = element.uri;
      item.iconPath = new vscode.ThemeIcon('symbol-namespace');
      return item;
    }
    if (element.kind === 'group') {
      const count = countGroup(element.model, element.groupKind);
      const item = new vscode.TreeItem(`${element.label} (${count})`, count > 0 ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
      item.iconPath = new vscode.ThemeIcon('symbol-class');
      return item;
    }

    const hasChildren =
      element.groupKind !== 'individual' && (this.getHierarchy(element.model, element.groupKind).childrenOf.get(element.term.iri)?.length ?? 0) > 0;
    const item = new vscode.TreeItem(
      element.term.label ?? shrink(element.term.iri, element.prefixes),
      hasChildren ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
    );
    item.description = element.term.label ? shrink(element.term.iri, element.prefixes) : undefined;
    item.tooltip = element.term.comment ?? element.term.definition ?? element.term.iri;
    item.iconPath = new vscode.ThemeIcon(iconForKind(element.groupKind));
    item.command = { command: 'ontologySuite.revealTerm', title: 'Reveal', arguments: [element.term.iri] };
    return item;
  }

  async getChildren(element?: OutlineNode): Promise<OutlineNode[]> {
    if (!this.activeUri) return [];
    if (!element) return [{ kind: 'root', uri: this.activeUri }];

    if (element.kind === 'root') {
      const { model, prefixes } = await this.getContext(element.uri);
      const groups: { groupKind: GroupKind; label: string }[] = [
        { groupKind: 'class', label: 'Classes' },
        { groupKind: 'objectProperty', label: 'Object Properties' },
        { groupKind: 'datatypeProperty', label: 'Datatype Properties' },
        { groupKind: 'individual', label: 'Individuals' },
      ];
      return groups
        .filter((g) => countGroup(model, g.groupKind) > 0)
        .map((g) => ({ kind: 'group' as const, groupKind: g.groupKind, label: g.label, model, prefixes }));
    }

    if (element.kind === 'group') {
      if (element.groupKind === 'individual') {
        const individuals = [...element.model.terms.values()].filter((t) => t.kinds.includes('individual'));
        individuals.sort((a, b) => (a.label ?? a.iri).localeCompare(b.label ?? b.iri));
        return individuals.map((term) => ({
          kind: 'term' as const,
          term,
          groupKind: element.groupKind,
          model: element.model,
          prefixes: element.prefixes,
          ancestorPath: new Set<string>(),
        }));
      }
      const { roots } = this.getHierarchy(element.model, element.groupKind);
      return roots.map((term) => ({
        kind: 'term' as const,
        term,
        groupKind: element.groupKind,
        model: element.model,
        prefixes: element.prefixes,
        ancestorPath: new Set<string>(),
      }));
    }

    // element.kind === 'term'
    if (element.groupKind === 'individual') return [];
    const { childrenOf: childrenIndex } = this.getHierarchy(element.model, element.groupKind);
    const nextAncestorPath = new Set(element.ancestorPath);
    nextAncestorPath.add(element.term.iri);
    return childrenOf(childrenIndex, element.term, element.ancestorPath).map((child) => ({
      kind: 'term' as const,
      term: child,
      groupKind: element.groupKind,
      model: element.model,
      prefixes: element.prefixes,
      ancestorPath: nextAncestorPath,
    }));
  }
}

function countGroup(model: OntologyModel, groupKind: GroupKind): number {
  return [...model.terms.values()].filter((t) => t.kinds.includes(groupKind)).length;
}

function iconForKind(kind: GroupKind): string {
  if (kind === 'class') return 'symbol-class';
  if (kind === 'objectProperty' || kind === 'datatypeProperty') return 'symbol-property';
  return 'symbol-object';
}
