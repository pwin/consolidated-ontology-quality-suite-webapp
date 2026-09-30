export type Severity = 'Violation' | 'Warning' | 'Info' | 'Hint';

/**
 * Mirrors consolidated_ontology_suite/ontology_suite/checks/merge.py::ResultRow
 * so findings from every engine (local SPARQL/SHACL/reasoning/guidance, or
 * the Python CLI fallback) render identically.
 */
export interface ResultRow {
  checkId: string | null;
  category: string | null;
  title: string | null;
  severity: Severity;
  focusNode: string;
  path: string | null;
  value: string | null;
  message: string;
  remediation: string | null;
  sources: string[];
  /**
   * Whether `focusNode` is a blank node label rather than an IRI. Set from the
   * term at construction, never guessed from the string: the two arms spell it
   * differently -- shacl-wasm gives `_:1_b4`, the SPARQL arm gives n3's bare
   * `n3-0` for the same node -- and neither is distinguishable from a relative
   * IRI by inspection.
   *
   * Two things need it. `merge.ts` cannot key its dedup on a label the two
   * engines disagree about, and `shaclRunner.fillMessageTemplate` must not put
   * one in a message. Mirrors `focus_is_blank` in the Python suite's
   * checks/merge.py.
   */
  focusIsBlank?: boolean;
}

export interface ImportResolution {
  resolved: string[];
  unresolved: string[];
  excluded: string[];
  networkAllowed: boolean;
  /**
   * The directory the local search actually walked, and how many ontology
   * files it found there.
   *
   * Reported because an unresolved import has two quite different causes that
   * look identical in a list of IRIs: the file is not there, or it is there
   * and does not declare the identity being imported. `candidateCount` tells
   * those apart at a glance -- zero means nothing was found to match against,
   * so the search location is the thing to check.
   */
  searchDir: string;
  candidateCount: number;
}

export interface PrefixMap {
  [prefix: string]: string;
}

export interface ParsedDocument {
  uri: string;
  text: string;
  quads: import('n3').Quad[];
  prefixes: PrefixMap;
  /** Parse errors, best-effort line-numbered (N3's error messages are line-only, no column). */
  errors: { message: string; line: number }[];
}

export interface CsvSample {
  headers: string[];
  rows: Record<string, string>[];
}
