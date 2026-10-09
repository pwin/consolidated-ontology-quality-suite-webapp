import { BlankNode, DataFactory, Quad } from 'n3';

const { blankNode, quad } = DataFactory;

/**
 * Relabels the blank nodes in `quads` so that none shares a label with one already in
 * `existingText`, for appending them to that Turtle document.
 *
 * A Turtle document treats every `_:x` with the same label as one node. The labels on new quads
 * come from a counter that restarts -- n3's DataFactory starts at `n3-0` in every process, so in
 * every Run Ontology Script and in every VS Code session -- so appended as they were, a new
 * restriction could share a label with one already in the file and the two would merge into a
 * single malformed node. Every label in the text counts as taken, including any in a comment or a
 * string literal: an unneeded rename costs nothing.
 */
export function blankNodesApartFrom(quads: Quad[], existingText: string): Quad[] {
  const taken = new Set(Array.from(existingText.matchAll(/_:([^\s;,.()[\]<>"']+)/g), (m) => m[1]));
  const renamed = new Map<string, BlankNode>();
  let next = 0;
  const relabel = (label: string): BlankNode => {
    let node = renamed.get(label);
    if (!node) {
      while (taken.has(`b${next}`)) next++;
      node = blankNode(`b${next++}`);
      renamed.set(label, node);
    }
    return node;
  };
  return quads.map((q) =>
    q.subject.termType !== 'BlankNode' && q.object.termType !== 'BlankNode'
      ? q
      : quad(
          q.subject.termType === 'BlankNode' ? relabel(q.subject.value) : q.subject,
          q.predicate,
          q.object.termType === 'BlankNode' ? relabel(q.object.value) : q.object,
          q.graph,
        ),
  );
}
