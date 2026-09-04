import type { ImportResolution } from '../types';

/**
 * The warning shown against an `owl:imports` line the local search could not
 * satisfy.
 *
 * It used to read "no workspace file declares this identity or
 * owl:versionIRI", and only the first three words were wrong -- but they were
 * the ones a reader acts on. `resolveImports` walks the *document's own
 * directory tree*, not the workspace, so an ontology sitting in a sibling
 * folder produced a warning stating, as fact, that no file in the workspace
 * declared it. The reader then goes looking for a missing file that is
 * present, in a folder the resolver never opened.
 *
 * The Python suite hit the same class of defect from the other end: its
 * `--import-dir` silently resolved nothing when the directory did not exist,
 * because `glob` returns an empty list rather than raising, so a mistyped path
 * was indistinguishable from genuinely absent imports. It now reports the
 * directory it searched. This says the same two facts -- where it looked, and
 * how much it found there -- because between them they separate the two causes
 * that an IRI on its own cannot.
 *
 * The zero-candidate case gets its own sentence. A directory with no ontology
 * files in it means nothing was matched *against*, so the location is the thing
 * to check; saying "none of them declares it" there would be true and useless.
 * And a candidate that holds the vocabulary but carries no `owl:Ontology`
 * header can never satisfy an import however complete it is -- resolution
 * matches on declared identity -- which is worth naming, because it is the one
 * cause where the path was right all along.
 */
export function unresolvedImportMessage(
  iri: string,
  report: Pick<ImportResolution, 'searchDir' | 'candidateCount'>,
): string {
  const where = `${report.searchDir} (this document's own directory tree, which is the whole of the local search)`;
  if (report.candidateCount === 0) {
    return `owl:imports <${iri}> could not be resolved locally: no ontology files were found under ${where}.`;
  }
  const files = report.candidateCount === 1 ? '1 ontology file' : `${report.candidateCount} ontology files`;
  return (
    `owl:imports <${iri}> could not be resolved locally: none of the ${files} under ${where} ` +
    'declares it as its `a owl:Ontology` subject or its `owl:versionIRI`. ' +
    'A file holding the vocabulary but no ontology header cannot satisfy an import.'
  );
}
