/**
 * What an insert-kind repair writes into the user's file.
 *
 * `applyRepair` needs a `vscode.TextDocument`, so the block builder is tested directly. It is
 * worth testing because it is a hand-written serialiser on the path *into* someone's ontology:
 * anything it drops is data loss in a file, and a dropped field reads as a tidy diff.
 */
import { describe, expect, it } from 'vitest';
import { DataFactory, Parser } from 'n3';
import { renderAddedQuadsTurtle } from './repairTurtle';

const { namedNode, literal, blankNode, quad } = DataFactory;
const PREFIXES = { ex: 'http://ex/', rdfs: 'http://www.w3.org/2000/01/rdf-schema#' };

describe('renderAddedQuadsTurtle', () => {
  it('keeps an RDF 1.2 base direction, which the language branch alone dropped', () => {
    // Built by parsing, because that is how a direction-tagged literal reaches this code --
    // from the document, not from a repair template.
    const [parsed] = new Parser({ format: 'N-Triples' })
      .parse('<http://ex/Thing> <http://www.w3.org/2000/01/rdf-schema#label> "مرحبا"@ar--rtl .');
    const block = renderAddedQuadsTurtle([parsed], PREFIXES);
    expect(block).toContain('@ar--rtl');
    // The failure this replaces: the direction gone and the datatype silently changed from
    // rdf:dirLangString to rdf:langString.
    expect(block).not.toMatch(/@ar(?!--)/);
  });

  it('writes a language-tagged literal with just its tag', () => {
    const block = renderAddedQuadsTurtle(
      [quad(namedNode('http://ex/Thing'), namedNode(`${PREFIXES.rdfs}label`), literal('Thing', 'en'))],
      PREFIXES,
    );
    expect(block).toContain('"Thing"@en');
    expect(block).not.toContain('--');
  });

  it('writes an xsd:string bare and keeps any other datatype', () => {
    const plain = renderAddedQuadsTurtle(
      [quad(namedNode('http://ex/a'), namedNode('http://ex/p'), literal('text'))], PREFIXES);
    expect(plain).toContain('"text" .');

    const typed = renderAddedQuadsTurtle(
      [quad(namedNode('http://ex/a'), namedNode('http://ex/p'),
        literal('42', namedNode('http://www.w3.org/2001/XMLSchema#integer')))], PREFIXES);
    expect(typed).toMatch(/"42"\^\^/);
  });

  it('escapes a quote and a backslash rather than breaking the literal', () => {
    const block = renderAddedQuadsTurtle(
      [quad(namedNode('http://ex/a'), namedNode('http://ex/p'), literal('a "b" \ c'))], PREFIXES);
    expect(block).toContain('\\"b\\"');
    expect(block).toContain('\\');
  });

  it('writes a blank node as a label', () => {
    const block = renderAddedQuadsTurtle(
      [quad(namedNode('http://ex/a'), namedNode('http://ex/p'), blankNode('b1'))], PREFIXES);
    expect(block).toContain('_:b1');
  });

  it('shrinks an IRI to a prefix where one applies, and leaves it otherwise', () => {
    const block = renderAddedQuadsTurtle(
      [quad(namedNode('http://ex/a'), namedNode('http://ex/p'), namedNode('http://other/x'))],
      PREFIXES,
    );
    expect(block).toContain('ex:a');
    expect(block).toContain('<http://other/x>');
  });

  it('is empty for no quads, so a caller does not append a blank block', () => {
    expect(renderAddedQuadsTurtle([], PREFIXES)).toBe('');
  });
});
