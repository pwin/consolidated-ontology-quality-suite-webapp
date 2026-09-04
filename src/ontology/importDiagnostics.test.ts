import { describe, expect, it } from 'vitest';
import { unresolvedImportMessage } from './importDiagnostics';

const IRI = 'http://example.org/vocab/core';

describe('unresolvedImportMessage', () => {
  it('names the directory that was actually searched, not "the workspace"', () => {
    // The message this replaced said "no workspace file declares this identity",
    // which is a claim about the whole workspace that the search never made:
    // resolveImports walks the document's own directory tree. An ontology in a
    // sibling folder therefore produced a warning asserting, as fact, that it
    // was not there -- sending the reader to look for a file that exists.
    const message = unresolvedImportMessage(IRI, { searchDir: '/w/ontology', candidateCount: 4 });
    expect(message).toContain('/w/ontology');
    expect(message).toContain("this document's own directory tree");
    expect(message).not.toContain('workspace');
  });

  it('says nothing was found to match against when the directory holds no ontologies', () => {
    // The two causes an IRI alone cannot separate. Zero candidates means the
    // location is the thing to check; "none of them declares it" would be true
    // there and useless.
    const message = unresolvedImportMessage(IRI, { searchDir: '/w/ontology', candidateCount: 0 });
    expect(message).toContain('no ontology files were found');
    expect(message).not.toContain('declares it as its');
  });

  it('names the ontology-header requirement when there were candidates', () => {
    // The one cause where the path was right all along: resolution matches on
    // declared identity, so a file holding the whole vocabulary but carrying no
    // owl:Ontology header can never satisfy an import.
    const message = unresolvedImportMessage(IRI, { searchDir: '/w/ontology', candidateCount: 4 });
    expect(message).toContain('4 ontology files');
    expect(message).toContain('owl:versionIRI');
    expect(message).toContain('no ontology header cannot satisfy an import');
  });

  it('agrees with itself about the count', () => {
    expect(unresolvedImportMessage(IRI, { searchDir: '/w', candidateCount: 1 })).toContain('1 ontology file under');
    expect(unresolvedImportMessage(IRI, { searchDir: '/w', candidateCount: 2 })).toContain('2 ontology files under');
  });

  it('always names the import it is about', () => {
    for (const candidateCount of [0, 1, 9]) {
      expect(unresolvedImportMessage(IRI, { searchDir: '/w', candidateCount })).toContain(`<${IRI}>`);
    }
  });
});
