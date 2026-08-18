import type { Quad } from 'n3';
import { buildOntologyModel, OntologyModel } from './ontologyModel';
import { RDFS_SUBCLASS_OF } from './vocab';

export interface OntologyMetrics {
  classCount: number;
  objectPropertyCount: number;
  datatypePropertyCount: number;
  annotationPropertyCount: number;
  individualCount: number;
  axiomCount: number;
  subClassOfEdgeCount: number;
  maxDepth: number;
  /** OntoQA "Inheritance Richness": average number of subclasses per class. */
  inheritanceRichness: number;
  /** OntoQA "Relationship Richness": non-inheritance relations / (relations + inheritance edges). */
  relationshipRichness: number;
  /** OntoQA "Attribute Richness": average number of datatype properties per class. */
  attributeRichness: number;
  classesWithNoLabel: number;
  classesWithNoDefinition: number;
}

/**
 * Compact OntoQA-inspired schema metrics -- ported in spirit (not
 * line-for-line) from consolidated_ontology_suite's
 * ontologyeval/ontology_evaluation.py. Complements expressivity.ts's DL
 * expressivity/profile indicators with size/shape metrics.
 */
export function computeMetrics(quads: Quad[]): OntologyMetrics {
  const model = buildOntologyModel(quads);
  const classes = [...model.terms.values()].filter((t) => t.kinds.includes('class'));
  const objectProps = [...model.terms.values()].filter((t) => t.kinds.includes('objectProperty'));
  const datatypeProps = [...model.terms.values()].filter((t) => t.kinds.includes('datatypeProperty'));
  const annotationProps = [...model.terms.values()].filter((t) => t.kinds.includes('annotationProperty'));
  const individuals = [...model.terms.values()].filter((t) => t.kinds.includes('individual'));

  const subClassEdges = quads.filter((q) => q.predicate.value === RDFS_SUBCLASS_OF && q.object.termType === 'NamedNode');
  const maxDepth = computeMaxDepth(model, subClassEdges.length > 0 ? subClassEdges.map((q) => [q.subject.value, q.object.value] as const) : []);

  const inheritanceRichness = classes.length > 0 ? subClassEdges.length / classes.length : 0;
  const relationshipRichness = objectProps.length + subClassEdges.length > 0 ? objectProps.length / (objectProps.length + subClassEdges.length) : 0;
  const attributeRichness = classes.length > 0 ? datatypeProps.length / classes.length : 0;

  const classesWithNoLabel = classes.filter((c) => !c.label).length;
  const classesWithNoDefinition = classes.filter((c) => !c.definition && !c.comment).length;

  return {
    classCount: classes.length,
    objectPropertyCount: objectProps.length,
    datatypePropertyCount: datatypeProps.length,
    annotationPropertyCount: annotationProps.length,
    individualCount: individuals.length,
    axiomCount: quads.length,
    subClassOfEdgeCount: subClassEdges.length,
    maxDepth,
    inheritanceRichness: round2(inheritanceRichness),
    relationshipRichness: round2(relationshipRichness),
    attributeRichness: round2(attributeRichness),
    classesWithNoLabel,
    classesWithNoDefinition,
  };
}

function computeMaxDepth(model: OntologyModel, edges: ReadonlyArray<readonly [string, string]>): number {
  const childToParents = new Map<string, string[]>();
  for (const [child, parent] of edges) {
    if (!childToParents.has(child)) childToParents.set(child, []);
    childToParents.get(child)!.push(parent);
  }

  // Iterative, with an explicit stack. A cycle guard alone does not bound the
  // descent: depth follows the longest subclass chain, and a recursive walk costs
  // one JS frame per link. Measured on this runtime, ~5,000 frames of a closure
  // this size already overflow -- so *any* fixed recursion limit low enough to be
  // safe would also be low enough to silently truncate a real answer. Walking the
  // DAG on the heap removes the ceiling instead of choosing one: a 100,000-deep
  // chain reports 99,999 rather than throwing.
  const memo = new Map<string, number>();
  const depthOf = (start: string): number => {
    const cached = memo.get(start);
    if (cached !== undefined) return cached;

    // `best` is max(parent depth + 1) so far; `next` is how many of this node's
    // parents have been visited. `onPath` breaks cycles, exactly as the recursive
    // form's `seen` did -- a node already being expanded contributes nothing.
    const stack: { iri: string; next: number; best: number }[] = [{ iri: start, next: 0, best: 0 }];
    const onPath = new Set<string>([start]);

    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const parents = childToParents.get(frame.iri) ?? [];

      if (frame.next < parents.length) {
        const parent = parents[frame.next++];
        const known = memo.get(parent);
        if (known !== undefined) frame.best = Math.max(frame.best, known + 1);
        else if (!onPath.has(parent)) {
          onPath.add(parent);
          stack.push({ iri: parent, next: 0, best: 0 });
        }
        continue;
      }

      stack.pop();
      onPath.delete(frame.iri);
      memo.set(frame.iri, frame.best);
      const caller = stack[stack.length - 1];
      if (caller) caller.best = Math.max(caller.best, frame.best + 1);
    }
    return memo.get(start) ?? 0;
  };

  let max = 0;
  for (const iri of model.terms.keys()) {
    max = Math.max(max, depthOf(iri));
  }
  return max;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
