export type RdfFormat = 'turtle' | 'trig' | 'ntriples' | 'nquads' | 'rdfxml' | 'manchester';

export interface FormatInfo {
  id: RdfFormat;
  label: string;
  /** File extensions this format is unambiguously associated with (no other supported format shares them). */
  extensions: string[];
  languageId: string;
  /** True for the four RDF-triple-serialization formats that carry the exact same graph losslessly; false for formats that only round-trip an OWL-axiom subset. */
  losslessGraph: boolean;
}

export const FORMATS: Record<RdfFormat, FormatInfo> = {
  turtle: { id: 'turtle', label: 'Turtle', extensions: ['.ttl'], languageId: 'turtle', losslessGraph: true },
  trig: { id: 'trig', label: 'TriG', extensions: ['.trig'], languageId: 'trig', losslessGraph: true },
  ntriples: { id: 'ntriples', label: 'N-Triples', extensions: ['.nt'], languageId: 'ntriples', losslessGraph: true },
  nquads: { id: 'nquads', label: 'N-Quads', extensions: ['.nq'], languageId: 'nquads', losslessGraph: true },
  rdfxml: { id: 'rdfxml', label: 'RDF/XML', extensions: ['.rdf'], languageId: 'rdfxml', losslessGraph: true },
  manchester: { id: 'manchester', label: 'OWL Manchester Syntax', extensions: ['.omn'], languageId: 'owl-manchester', losslessGraph: false },
};

export interface ParseResult {
  quads: import('n3').Quad[];
  prefixes: Record<string, string>;
  errors: { message: string; line: number }[];
}
