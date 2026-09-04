import { describe, expect, it } from 'vitest';
import { scanCuries } from './curieScan';

const PREFIXES = {
  ex: 'http://example.org/ns#',
  owl: 'http://www.w3.org/2002/07/owl#',
  rdfs: 'http://www.w3.org/2000/01/rdf-schema#',
  sh: 'http://www.w3.org/ns/shacl#',
};
const EX = PREFIXES.ex;
const iris = (text: string, declarations = new Set<string>()) =>
  scanCuries(text, PREFIXES, declarations).map((o) => o.iri);

describe('scanCuries', () => {
  it('ignores a CURIE inside a trailing comment', () => {
    // The defect this module was extracted for. Rename is backed by these
    // occurrences, so renaming ex:Dgo rewrote the very comment explaining the
    // rename -- a true note turned into a false one -- and find-references
    // counted the mention as a use.
    expect(iris('ex:Dog a owl:Class .  # was ex:Dgo, renamed 2026-09-04')).toEqual([
      `${EX}Dog`,
      'http://www.w3.org/2002/07/owl#Class',
    ]);
  });

  it('still ignores a whole-line comment', () => {
    expect(iris('# ex:Ghost a owl:Class .\nex:Dog a owl:Class .')).toEqual([
      `${EX}Dog`,
      'http://www.w3.org/2002/07/owl#Class',
    ]);
  });

  it('keeps the local name of an IRI containing a fragment separator', () => {
    // A line-oriented `#`-to-end-of-line strip truncates this, and `#` is the
    // fragment separator in almost every RDF namespace -- so the naive fix
    // would break the commonest line in the language.
    expect(iris('<http://example.org/ns#Dog> rdfs:label "Dog" .')).toEqual([
      'http://www.w3.org/2000/01/rdf-schema#label',
    ]);
  });

  it('reads a CURIE inside a string literal', () => {
    // Deliberately kept, unlike comments: a term named in a message or an
    // embedded query is a real reference, and dropping those makes
    // find-references quietly incomplete -- worse than the odd false positive
    // it would save.
    //
    // Only where a separator precedes it, though. CURIE_TOKEN requires one of
    // `(^|[\s(),;.[\]{}])` before the prefix and `"` is not among them, so a
    // literal that *opens* on a CURIE is missed. That is incidental rather
    // than intended; it is pinned here so a future change to that character
    // class is a decision rather than a surprise.
    expect(iris('ex:Shape sh:message "the class ex:Dog must have a label" .')).toEqual([
      `${EX}Shape`,
      'http://www.w3.org/ns/shacl#message',
      `${EX}Dog`,
    ]);
    expect(iris('ex:Shape sh:message "ex:Dog must have a label" .')).toEqual([
      `${EX}Shape`,
      'http://www.w3.org/ns/shacl#message',
    ]);
  });

  it('does not treat a # inside a literal as starting a comment', () => {
    expect(iris('ex:Dog rdfs:comment "see ex:Owner # not a comment" .')).toEqual([
      `${EX}Dog`,
      'http://www.w3.org/2000/01/rdf-schema#comment',
      `${EX}Owner`,
    ]);
  });

  it('scans a line of a multi-line literal that begins with #', () => {
    // The old line-oriented skip dropped this line outright, since its first
    // non-space character is `#` -- but it is inside a literal, not a comment.
    const text = 'ex:Dog rdfs:comment """\n# ex:Owner is the point\n""" .';
    expect(iris(text)).toContain(`${EX}Owner`);
  });

  it('reports positions in the real document, not the stripped copy', () => {
    // stripComments blanks a comment with spaces of equal length precisely so
    // every column below still indexes the file the user is looking at.
    const text = 'ex:Dog a owl:Class .  # ex:Dgo';
    const [dog] = scanCuries(text, PREFIXES, new Set());
    expect(text.slice(dog.startCol, dog.endCol)).toBe('ex:Dog');
    expect(dog.line).toBe(0);
  });

  it('marks a line-leading subject as a declaration, and a later mention of it not', () => {
    const declared = new Set([`${EX}Dog`]);
    const rows = scanCuries('ex:Dog a owl:Class .\nex:Cat rdfs:seeAlso ex:Dog .', PREFIXES, declared);
    expect(rows.filter((r) => r.isDeclaration).map((r) => `${r.line}:${r.startCol}`)).toEqual(['0:0']);
  });
});
