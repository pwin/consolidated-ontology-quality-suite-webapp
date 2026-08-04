import type { Quad } from 'n3';
import { RDF, RDFS_COMMENT, RDFS_LABEL, RDFS_ISDEFINEDBY } from '../rdf/vocab';
import { shrink } from '../rdf/vocab';

export type GraphRankdir = 'LR' | 'RL' | 'TB' | 'BT';

export interface GraphOptions {
  hideTypes: boolean;
  hideAnnotations: boolean;
  /** Hides rdfs:isDefinedBy edges specifically -- separate from hideAnnotations since it's
   *  usually about "which ontology defines this term" bookkeeping, not descriptive content,
   *  and tends to point at a handful of hub nodes (the ontologies themselves) that clutter the
   *  layout more than label/comment/definition edges do. */
  hideIsDefinedBy: boolean;
  /** Stops traversal at the boundary of the main document's own subjects: an imported term
   *  reached via an edge still appears as a leaf node (so you can see *that* something is
   *  categorized/typed/related to it), but none of *its own* outgoing quads are pulled in --
   *  decluttering a large imported upper/foundational ontology's own internal structure out of
   *  the picture without losing the fact that the main document references it. Only applies
   *  beyond depth 0: an imported term picked as one of the selected root subjects is still
   *  expanded normally. */
  hideImportedDownstream: boolean;
  showPrefixes: boolean;
  maxDepth: number;
  rankdir: GraphRankdir;
}

const RDF_TYPE = `${RDF}type`;
const RDF_FIRST = `${RDF}first`;
const RDF_REST = `${RDF}rest`;
const ANNOTATION_PREDICATES = new Set([RDFS_LABEL, RDFS_COMMENT, 'http://www.w3.org/2004/02/skos/core#definition', 'http://www.w3.org/2004/02/skos/core#example']);

const DEFAULT_OPTIONS: GraphOptions = {
  hideTypes: false,
  hideAnnotations: false,
  hideIsDefinedBy: false,
  hideImportedDownstream: false,
  showPrefixes: true,
  maxDepth: 3,
  rankdir: 'LR',
};

/**
 * Ports turtle-editor-viewer's graph-generator.ts (RDF quads -> Graphviz
 * DOT text, subject-filtered BFS incl. blank nodes / rdf:List rendering),
 * fixing its noted O(n*m) issue: that version re-filters the full quad
 * array per visited subject inside the BFS loop; this pre-builds a
 * subject->quads Map once up front.
 */
export function generateDot(
  quads: Quad[],
  selectedSubjects: string[],
  prefixes: Record<string, string>,
  options: Partial<GraphOptions> = {},
  /** Subjects declared in the main document itself (pre-import-merge) -- required only when
   *  `hideImportedDownstream` is set; a term not in this set is treated as "imported". */
  localSubjects?: ReadonlySet<string>,
  /** Quad keys (see quadKey()) present in the reasoner's deductive closure but not in `quads`
   *  itself -- rendered as dashed purple edges instead of the default solid black, so an
   *  inferred relationship (e.g. a subclass link entailed through the class hierarchy, not
   *  directly asserted) is visually distinct from what the document actually states. Edge
   *  styling only, not node styling: the inferred/asserted distinction is fundamentally about
   *  axioms/relationships, which map onto edges here, not the nodes themselves. */
  inferredKeys?: ReadonlySet<string>,
): string {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const bySubject = new Map<string, Quad[]>();
  for (const q of quads) {
    const key = q.subject.value;
    if (!bySubject.has(key)) bySubject.set(key, []);
    bySubject.get(key)!.push(q);
  }

  const visited = new Set<string>();
  const relevantQuads: Quad[] = [];
  const queue: { iri: string; depth: number }[] = selectedSubjects.map((iri) => ({ iri, depth: 0 }));

  while (queue.length > 0) {
    const { iri, depth } = queue.shift()!;
    if (visited.has(iri) || depth > opts.maxDepth) continue;
    visited.add(iri);
    // The node itself still renders (via the edge that reached it); its own outgoing quads are
    // just never collected, so nothing further is pulled in from an imported ontology's internals.
    if (opts.hideImportedDownstream && depth > 0 && !localSubjects?.has(iri)) continue;
    const subjectQuads = bySubject.get(iri) ?? [];
    for (const q of subjectQuads) {
      if (opts.hideTypes && q.predicate.value === RDF_TYPE) continue;
      if (opts.hideAnnotations && ANNOTATION_PREDICATES.has(q.predicate.value)) continue;
      if (opts.hideIsDefinedBy && q.predicate.value === RDFS_ISDEFINEDBY) continue;
      relevantQuads.push(q);
      if ((q.object.termType === 'NamedNode' || q.object.termType === 'BlankNode') && !visited.has(q.object.value)) {
        queue.push({ iri: q.object.value, depth: depth + 1 });
      }
    }
  }

  // Shape/color scheme matches turtle-editor-viewer's graph-generator.ts: rounded boxes
  // throughout, literals in blue, blank nodes in orange -- named resources get no extra color.
  const lines: string[] = [
    'digraph G {',
    `  rankdir=${opts.rankdir};`,
    '  node [shape=box, style=rounded, fontname="sans-serif", fontsize=10];',
    '  edge [fontname="sans-serif", fontsize=9];',
  ];
  const nodeIds = new Map<string, string>();
  let nodeCounter = 0;
  const idFor = (iri: string): string => {
    let id = nodeIds.get(iri);
    if (!id) {
      id = `n${nodeCounter++}`;
      nodeIds.set(iri, id);
    }
    return id;
  };
  const labelFor = (iri: string, termType: string): string => {
    if (termType === 'BlankNode') return `_:${iri.slice(0, 6)}`;
    return opts.showPrefixes ? shrink(iri, prefixes) : iri;
  };
  // Blank nodes get an orange border, matching turtle-editor-viewer; named resources get no
  // extra color (the default node style already applies to them).
  const attrsFor = (termType: string): string => (termType === 'BlankNode' ? ', color="orange"' : '');

  const rendered = new Set<string>();
  for (const q of relevantQuads) {
    if (q.subject.termType === 'NamedNode' || q.subject.termType === 'BlankNode') {
      const sid = idFor(q.subject.value);
      if (!rendered.has(sid)) {
        rendered.add(sid);
        lines.push(`  ${sid} [label=${dotQuote(labelFor(q.subject.value, q.subject.termType))}${attrsFor(q.subject.termType)}];`);
      }
    }

    const predLabel = opts.showPrefixes ? shrink(q.predicate.value, prefixes) : q.predicate.value;

    // Dashed purple for an inferred-only relationship (present in the reasoner's closure but
    // not asserted in the document itself); the default solid black edge style otherwise.
    const edgeStyle = inferredKeys?.has(quadKey(q)) ? ', style=dashed, color="purple", fontcolor="purple"' : '';

    if (q.object.termType === 'NamedNode' || q.object.termType === 'BlankNode') {
      const oid = idFor(q.object.value);
      if (!rendered.has(oid)) {
        rendered.add(oid);
        lines.push(`  ${oid} [label=${dotQuote(labelFor(q.object.value, q.object.termType))}${attrsFor(q.object.termType)}];`);
      }
      const sid = idFor(q.subject.value);
      lines.push(`  ${sid} -> ${oid} [label=${dotQuote(predLabel)}${edgeStyle}];`);
    } else {
      // Literal object: rendered as its own small node (so long values don't clutter the edge
      // label), in blue -- matching turtle-editor-viewer's literal color convention.
      const lid = `lit${nodeCounter++}`;
      const literalText = q.object.value.length > 40 ? `${q.object.value.slice(0, 37)}...` : q.object.value;
      lines.push(`  ${lid} [label=${dotQuote(literalText)}, color="blue", fontcolor="blue"];`);
      const sid = idFor(q.subject.value);
      lines.push(`  ${sid} -> ${lid} [label=${dotQuote(predLabel)}${edgeStyle}];`);
    }
  }

  lines.push('}');
  return lines.join('\n');
}

function dotQuote(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Stable per-triple identity for diffing an asserted graph against a reasoner's closure (see graphView.ts's "Show inferred" option) -- literal-aware so a literal and a same-string resource can't collide. */
export function quadKey(q: Quad): string {
  const objectKey = q.object.termType === 'Literal' ? `"${q.object.value}"@${(q.object as import('n3').Literal).language ?? ''}^^${(q.object as import('n3').Literal).datatype?.value ?? ''}` : q.object.value;
  return `${q.subject.value}|${q.predicate.value}|${objectKey}`;
}

/** RDF collections (rdf:first/rdf:rest chains) are common enough in restrictions to special-case for readability; kept simple for v1 -- flagged nodes, not fully unrolled into a record shape like the source project did. */
export function isRdfListNode(quads: Quad[], iri: string): boolean {
  return quads.some((q) => q.subject.value === iri && (q.predicate.value === RDF_FIRST || q.predicate.value === RDF_REST));
}
