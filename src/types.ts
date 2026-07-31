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
}

export interface ImportResolution {
  resolved: string[];
  unresolved: string[];
  excluded: string[];
  networkAllowed: boolean;
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
