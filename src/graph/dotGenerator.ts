import type { Quad } from 'n3';
import { RDF, RDFS_COMMENT, RDFS_LABEL } from '../rdf/vocab';
import { shrink } from '../rdf/vocab';

export interface GraphOptions {
  hideTypes: boolean;
  hideAnnotations: boolean;
  showPrefixes: boolean;
  maxDepth: number;
}

const RDF_TYPE = `${RDF}type`;
const RDF_FIRST = `${RDF}first`;
const RDF_REST = `${RDF}rest`;
const ANNOTATION_PREDICATES = new Set([RDFS_LABEL, RDFS_COMMENT, 'http://www.w3.org/2004/02/skos/core#definition', 'http://www.w3.org/2004/02/skos/core#example']);

const DEFAULT_OPTIONS: GraphOptions = { hideTypes: false, hideAnnotations: false, showPrefixes: true, maxDepth: 3 };

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
    const subjectQuads = bySubject.get(iri) ?? [];
    for (const q of subjectQuads) {
      if (opts.hideTypes && q.predicate.value === RDF_TYPE) continue;
      if (opts.hideAnnotations && ANNOTATION_PREDICATES.has(q.predicate.value)) continue;
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
    '  rankdir=LR;',
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

    if (q.object.termType === 'NamedNode' || q.object.termType === 'BlankNode') {
      const oid = idFor(q.object.value);
      if (!rendered.has(oid)) {
        rendered.add(oid);
        lines.push(`  ${oid} [label=${dotQuote(labelFor(q.object.value, q.object.termType))}${attrsFor(q.object.termType)}];`);
      }
      const sid = idFor(q.subject.value);
      lines.push(`  ${sid} -> ${oid} [label=${dotQuote(predLabel)}];`);
    } else {
      // Literal object: rendered as its own small node (so long values don't clutter the edge
      // label), in blue -- matching turtle-editor-viewer's literal color convention.
      const lid = `lit${nodeCounter++}`;
      const literalText = q.object.value.length > 40 ? `${q.object.value.slice(0, 37)}...` : q.object.value;
      lines.push(`  ${lid} [label=${dotQuote(literalText)}, color="blue", fontcolor="blue"];`);
      const sid = idFor(q.subject.value);
      lines.push(`  ${sid} -> ${lid} [label=${dotQuote(predLabel)}];`);
    }
  }

  lines.push('}');
  return lines.join('\n');
}

function dotQuote(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** RDF collections (rdf:first/rdf:rest chains) are common enough in restrictions to special-case for readability; kept simple for v1 -- flagged nodes, not fully unrolled into a record shape like the source project did. */
export function isRdfListNode(quads: Quad[], iri: string): boolean {
  return quads.some((q) => q.subject.value === iri && (q.predicate.value === RDF_FIRST || q.predicate.value === RDF_REST));
}
