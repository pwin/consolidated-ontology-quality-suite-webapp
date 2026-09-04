import { stripComments } from '../triplify/bindAnalysis';

/**
 * One CURIE occurrence as it sits in the source, with no VS Code types in it so
 * the scan can be tested without an extension host -- `termIndex.ts` adds the
 * document's `uri` on the way past.
 */
export interface CurieOccurrence {
  /** Zero-based source position, held as numbers -- see termIndex's `occurrenceRange`. */
  line: number;
  startCol: number;
  endCol: number;
  iri: string;
  /** True if this occurrence looks like a declaration (subject of `a owl:Class`/etc.), not just a usage. */
  isDeclaration: boolean;
}

const CURIE_TOKEN = /(^|[\s(),;.[\]{}])((?:[A-Za-z][\w-]*)?):([A-Za-z_][\w-]*)/g;

/**
 * Finds every prefixed name in a document, by source position.
 *
 * Comments are blanked first, and that is the whole reason this is its own
 * module. The scan used to skip a line whose *first* non-space character was
 * `#`, which leaves a trailing comment fully scanned -- so
 * `ex:Dog a owl:Class .  # was ex:Dgo` recorded an occurrence of `ex:Dgo`
 * inside the remark. Rename is backed by these occurrences, so renaming
 * `ex:Dgo` rewrote the comment that explained the rename, turning a true note
 * into a false one; find-references counted the mention as a use of the term;
 * and rename's own validity check saw a term that was not really there. The
 * Python suite hit the identical defect in its `--apply-repairs` textual
 * rename and fixed it the same way, with this same scanner.
 *
 * `stripComments` replaces a comment with spaces of equal length rather than
 * removing it, so every column below is still the column in the real document.
 * It also knows that `#` is the fragment separator in almost every RDF
 * namespace and that a `#` inside a string literal is not a comment -- both of
 * which a line-oriented scan gets wrong, the first by truncating
 * `<http://example.org/ns#Term>` and the second by skipping a line of a
 * multi-line literal that happens to begin with `#`.
 *
 * String literals are *not* blanked, deliberately, and the upstream repair
 * reaches the same rule from the other end: a CURIE written inside a literal
 * here is almost always a real term reference -- `sh:message "ex:Dog must
 * ..."`, a SPARQL query held as a string -- and losing those would make
 * find-references quietly incomplete; there, a TARQL IRI template is built out
 * of literals, so a rename usually *must* reach inside them. Different
 * reasons, one behaviour, and worth knowing they agree before anyone
 * "restores parity" by changing working code.
 *
 * `stripCommentsParity.test.ts` pins that agreement against a fixture both
 * repos carry.
 */
export function scanCuries(
  text: string,
  prefixes: Record<string, string>,
  declarationSubjectIris: Set<string>,
): CurieOccurrence[] {
  const occurrences: CurieOccurrence[] = [];
  // Stripped over the whole text, not line by line: a multi-line literal's
  // quoting state only makes sense read straight through.
  const lines = stripComments(text).split(/\r?\n/);
  for (let lineNo = 0; lineNo < lines.length; lineNo++) {
    const line = lines[lineNo];
    // Hoisted out of the match loop: it was recomputed per match to answer the same
    // question every time -- whether the match is the first thing on the line.
    const firstNonSpace = line.search(/\S/);
    CURIE_TOKEN.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = CURIE_TOKEN.exec(line))) {
      const leading = m[1];
      const prefix = m[2];
      const local = m[3];
      // `expand` inlined. The regex has already separated prefix from local name, so
      // joining them into a CURIE only for expand() to split it apart again allocated a
      // string per match -- and there is one match per term occurrence in the whole
      // workspace. `expand` alone was 65% of one unresponsive-host profile.
      const namespace = prefixes[prefix];
      if (!namespace) continue;
      const iri = namespace + local;
      const startCol = m.index + leading.length;
      occurrences.push({
        line: lineNo,
        startCol,
        endCol: startCol + prefix.length + 1 + local.length,
        iri,
        isDeclaration: startCol === firstNonSpace && declarationSubjectIris.has(iri),
      });
    }
  }
  return occurrences;
}
