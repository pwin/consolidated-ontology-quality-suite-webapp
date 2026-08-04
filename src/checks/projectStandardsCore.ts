import { expand, GIST } from '../rdf/vocab';

/**
 * Project-local configuration a workspace can supply to complete
 * mechanically-generated repairs -- the same role Schematron Quick Fix's
 * (SQF) `$variables` play, resolved from the failing rule's own context.
 * We don't have a rule-local scope the way XSLT/XPath does, so instead
 * every repair template gets these bound as `VALUES`-injected variables
 * alongside the violation's own focusNode/path/value (see repairEngine.ts).
 *
 * Pure logic only (no `vscode` import) so it's usable from vitest and from
 * repairEngine.ts without pulling in the extension host -- the vscode-facing
 * loader lives in projectStandards.ts.
 */
export interface ProjectStandards {
  /** Language tag used when a repair adds a label/prefLabel and none exists yet, or replaces an untagged one. */
  defaultLanguageTag: string;
  /** CURIE or full IRI of the class used for MDL-003's "model as a category instead of a class" repair. */
  categoryClass: string;
  /** Extra prefix bindings (beyond the document's own) needed to resolve `categoryClass` and other CURIE-shaped fields below. */
  prefixes: Record<string, string>;
  /** MDL-002 policy: replace a named-to-named owl:equivalentClass with this predicate ('subClassOf' or 'closeMatch'). */
  equivalentClassPolicy: 'subClassOf' | 'closeMatch';
  /** LOG-003 policy: which axiom to keep when equivalentClass and subClassOf are redundantly both asserted. */
  redundantEquivalencePolicy: 'keepEquivalentClass' | 'keepSubClassOf';
  /** Base IRI used for QUA-005's "declare an owl:Ontology resource" repair when the document doesn't already suggest one. */
  defaultOntologyBaseIri: string;
  /** Literal value used for QUA-002's owl:versionInfo repair. */
  defaultVersionInfo: string;
  /** Template for QUA-007's owl:versionIRI repair; `{ontologyIri}` and `{version}` are substituted. */
  versionIriTemplate: string;
}

export const DEFAULT_PROJECT_STANDARDS: ProjectStandards = {
  defaultLanguageTag: 'en',
  categoryClass: 'gist:Category',
  prefixes: { gist: GIST },
  equivalentClassPolicy: 'subClassOf',
  redundantEquivalencePolicy: 'keepEquivalentClass',
  defaultOntologyBaseIri: 'https://example.org/ontology/',
  defaultVersionInfo: '0.1.0',
  versionIriTemplate: '{ontologyIri}/{version}',
};

/** Resolves every CURIE-shaped standards value against the standards' own prefixes plus the target document's declared prefixes. */
export function resolveStandardsIris(standards: ProjectStandards, documentPrefixes: Record<string, string>): Record<string, string> {
  const allPrefixes = { ...standards.prefixes, ...documentPrefixes };
  const resolve = (v: string) => (v.startsWith('http://') || v.startsWith('https://') ? v : (expand(v, allPrefixes) ?? v));
  return {
    categoryClass: resolve(standards.categoryClass),
    defaultOntologyBaseIri: standards.defaultOntologyBaseIri,
  };
}
