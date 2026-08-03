import type { Quad } from 'n3';
import type { ResultRow } from '../types';
import { RDF_TYPE, expand, shrink, WELL_KNOWN_PREFIXES } from '../rdf/vocab';

/**
 * Project-defined "minimum required content" rules for classes/properties --
 * e.g. "every owl:Class needs rdfs:label and rdfs:comment". Authored as
 * plain JSON (`.ontology-suite/class-rules.json`, path configurable via
 * `ontologySuite.projectRulesPath`) rather than hand-written SHACL, so VS
 * Code's built-in JSON language support (via the bundled
 * resources/checks-registry/class-rules.schema.json, wired through
 * `contributes.jsonValidation`) gives autocomplete/validation for free.
 * Pure logic only (no `vscode` import) -- see classRulesLoader.ts for the
 * workspace-file-reading counterpart.
 */
export interface ClassRule {
  /** CURIE or full IRI of the rdf:type this rule applies to, e.g. "owl:Class". */
  appliesTo: string;
  /** CURIEs or full IRIs of predicates that must appear at least once on every matching subject. */
  requires: string[];
}

export interface ClassRulesConfig {
  rules: ClassRule[];
}

export const EMPTY_CLASS_RULES: ClassRulesConfig = { rules: [] };

export const PROJECT_REQUIRED_CHECK_ID = 'PRJ-REQUIRED';

/**
 * Findings reuse the same ResultRow shape as every other check engine
 * (focusNode = the class/property missing content, path = the missing
 * predicate) so they flow through the existing diagnostics/merge/quick-fix
 * pipeline unchanged -- a missing rdfs:label/skos:prefLabel is even
 * auto-fixable by the same repair template QUA-001/QUA-004 use (see
 * resources/checks-registry/repairs/PRJ-REQUIRED.ru).
 */
export function evaluateClassRules(quads: Quad[], config: ClassRulesConfig, documentPrefixes: Record<string, string>): ResultRow[] {
  if (config.rules.length === 0) return [];
  const prefixes = { ...WELL_KNOWN_PREFIXES, ...documentPrefixes };
  const resolve = (v: string): string => (v.startsWith('http://') || v.startsWith('https://') ? v : (expand(v, prefixes) ?? v));

  const typesBySubject = new Map<string, Set<string>>();
  const predicatesPresent = new Set<string>();
  for (const q of quads) {
    if (q.subject.termType !== 'NamedNode') continue;
    if (q.predicate.value === RDF_TYPE && q.object.termType === 'NamedNode') {
      if (!typesBySubject.has(q.subject.value)) typesBySubject.set(q.subject.value, new Set());
      typesBySubject.get(q.subject.value)!.add(q.object.value);
    }
    predicatesPresent.add(`${q.subject.value}|${q.predicate.value}`);
  }

  const rows: ResultRow[] = [];
  for (const rule of config.rules) {
    const appliesTo = resolve(rule.appliesTo);
    for (const [subject, types] of typesBySubject) {
      if (!types.has(appliesTo)) continue;
      for (const requiredRaw of rule.requires) {
        const required = resolve(requiredRaw);
        if (predicatesPresent.has(`${subject}|${required}`)) continue;
        rows.push({
          checkId: PROJECT_REQUIRED_CHECK_ID,
          category: 'project-rules',
          title: 'Missing required predicate (project rule)',
          severity: 'Warning',
          focusNode: subject,
          path: required,
          value: null,
          message: `${shrink(subject, prefixes)} is a ${shrink(appliesTo, prefixes)} but is missing required predicate ${shrink(required, prefixes)} (project rule).`,
          remediation: `Add ${shrink(required, prefixes)} to ${shrink(subject, prefixes)}.`,
          sources: ['project-rules'],
        });
      }
    }
  }
  return rows;
}
