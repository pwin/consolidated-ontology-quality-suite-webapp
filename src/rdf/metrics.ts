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

  const memo = new Map<string, number>();
  const depthOf = (iri: string, seen: Set<string>): number => {
    if (memo.has(iri)) return memo.get(iri)!;
    if (seen.has(iri)) return 0; // cycle guard
    const parents = childToParents.get(iri) ?? [];
    if (parents.length === 0) return 0;
    seen.add(iri);
    const depth = 1 + Math.max(...parents.map((p) => depthOf(p, seen)));
    seen.delete(iri);
    memo.set(iri, depth);
    return depth;
  };

  let max = 0;
  for (const iri of model.terms.keys()) {
    max = Math.max(max, depthOf(iri, new Set()));
  }
  return max;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
