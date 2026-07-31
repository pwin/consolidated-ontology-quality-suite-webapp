import type { OntologyModel, TermInfo, TermKind } from './ontologyModel';

/**
 * Builds a parent->children index over rdfs:subClassOf (for classes) or
 * rdfs:subPropertyOf (for object/datatype properties) restricted to terms
 * present in the given model -- backs the Ontology Outline's Protege-style
 * folder-hierarchy view (see extension.ts / ontology/outline.ts).
 */
export function buildHierarchyIndex(
  model: OntologyModel,
  kind: Extract<TermKind, 'class' | 'objectProperty' | 'datatypeProperty'>,
): { roots: TermInfo[]; childrenOf: Map<string, TermInfo[]> } {
  const relevant = [...model.terms.values()].filter((t) => t.kinds.includes(kind));
  const relevantIris = new Set(relevant.map((t) => t.iri));
  const parentField = kind === 'class' ? 'subClassOf' : 'subPropertyOf';

  const childrenOf = new Map<string, TermInfo[]>();
  const roots: TermInfo[] = [];

  for (const term of relevant) {
    const parents = term[parentField].filter((p) => relevantIris.has(p) && p !== term.iri);
    if (parents.length === 0) {
      roots.push(term);
      continue;
    }
    for (const parent of parents) {
      if (!childrenOf.has(parent)) childrenOf.set(parent, []);
      childrenOf.get(parent)!.push(term);
    }
  }

  const sortByName = (a: TermInfo, b: TermInfo) => (a.label ?? a.iri).localeCompare(b.label ?? b.iri);
  roots.sort(sortByName);
  for (const children of childrenOf.values()) children.sort(sortByName);

  return { roots, childrenOf };
}

/** Cycle-safe children lookup: a subClassOf/subPropertyOf cycle would otherwise recurse forever when expanding the tree. */
export function childrenOf(childrenIndex: Map<string, TermInfo[]>, term: TermInfo, ancestorPath: ReadonlySet<string>): TermInfo[] {
  const children = childrenIndex.get(term.iri) ?? [];
  return children.filter((c) => !ancestorPath.has(c.iri));
}
