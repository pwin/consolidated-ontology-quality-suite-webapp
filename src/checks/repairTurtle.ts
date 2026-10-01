/**
 * Turtle for the quads an insert-kind repair adds.
 *
 * Split from `applyRepair.ts` so it can be tested: that module imports `vscode`, which does not
 * exist outside the extension host, and this is the part that writes into someone's ontology.
 * A hand-written serialiser on the path *into* a user's file is worth a test, because anything
 * it drops is data loss that reads as a tidy diff. Same reasoning as `projectStandardsCore`.
 */
import type { Quad } from 'n3';
import { shrink } from '../rdf/vocab';

/**
 * The Turtle block an insert-kind repair appends.
 *
 * Exported for `applyRepair.test.ts`. `applyRepair` itself needs a `vscode.TextDocument`, so
 * this is the largest piece of what gets written into someone's file that can be checked
 * without one -- and a serialiser that drops part of a term is exactly the kind of fault that
 * survives a review and shows up in a diff.
 */
export function renderAddedQuadsTurtle(quads: Quad[], prefixes: Record<string, string>): string {
  if (quads.length === 0) return '';
  const bySubject = new Map<string, Quad[]>();
  for (const q of quads) {
    const key = q.subject.value;
    if (!bySubject.has(key)) bySubject.set(key, []);
    bySubject.get(key)!.push(q);
  }
  const lines: string[] = [''];
  for (const [subject, subjectQuads] of bySubject) {
    lines.push(shrinkTerm(subject, prefixes));
    subjectQuads.forEach((q, i) => {
      const suffix = i === subjectQuads.length - 1 ? '.' : ';';
      lines.push(`  ${shrinkTerm(q.predicate.value, prefixes)} ${renderObject(q.object, prefixes)} ${suffix}`);
    });
    lines.push('');
  }
  return lines.join('\n');
}

function shrinkTerm(iri: string, prefixes: Record<string, string>): string {
  if (iri === 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type') return 'a';
  const curie = shrink(iri, prefixes);
  return curie === iri ? `<${iri}>` : curie;
}

function renderObject(term: Quad['object'], prefixes: Record<string, string>): string {
  if (term.termType === 'Literal') {
    const lit = term as import('n3').Literal;
    const escaped = lit.value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    // Direction before language, because a literal with a base direction has *both* and
    // the language branch alone silently drops it -- rewriting `"x"@ar--rtl` as `"x"@ar`
    // and changing its datatype from rdf:dirLangString to rdf:langString on the way into
    // the user's file. Measured: n3 parses the direction and this discarded it.
    //
    // Only the insert path comes through here; the replace path uses n3's Writer, which
    // emits `--rtl` correctly. So this was the one place a repair could lose it, and the
    // place an Arabic or Hebrew ontology would notice, since QUA-001 inserts a label in
    // the project language.
    // Cast because the rdf-js typings do not declare `direction` yet -- it is an RDF 1.2
    // addition, and n3 implements it (`get direction()` in N3DataFactory) ahead of the types.
    // Narrow rather than `as any`, so this stops compiling if the field ever arrives properly.
    const direction = (lit as unknown as { direction?: string }).direction;
    if (lit.language && direction) {
      return `"${escaped}"@${lit.language}--${direction}`;
    }
    if (lit.language) return `"${escaped}"@${lit.language}`;
    if (lit.datatype.value === 'http://www.w3.org/2001/XMLSchema#string') return `"${escaped}"`;
    return `"${escaped}"^^${shrinkTerm(lit.datatype.value, prefixes)}`;
  }
  if (term.termType === 'BlankNode') return `_:${term.value}`;
  return shrinkTerm(term.value, prefixes);
}
