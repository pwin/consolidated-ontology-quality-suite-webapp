import { Parser } from 'n3';
import { buildOntologyModel } from '../rdf/ontologyModel';
import { RDF_TYPE } from '../rdf/vocab';
import { extractPrefixes, sketchQuery, renderSketchTurtle } from './sketch';
import type { Quad } from 'n3';

const DEFAULT_IGNORED_PREFIXES = new Set(['rdf', 'rdfs', 'owl', 'xsd', 'xml']);

export interface PrefixMisalignment {
  prefix: string;
  queryNamespace: string;
  kind: 'namespace_mismatch' | 'prefix_name_mismatch' | 'undeclared_namespace';
  detail: string;
}

export interface UndeclaredTerm {
  kind: 'class' | 'property';
  term: string;
  detail: string;
}

export interface AlignmentReport {
  prefixMisalignments: PrefixMisalignment[];
  undeclaredTerms: UndeclaredTerm[];
}

/**
 * Ports prefix_alignment.py::check_tarql_ontology_prefix_alignment: checks
 * a query's declared PREFIX block against the ontology's own @prefix
 * declarations for drift (rebound prefix name, or same namespace under a
 * different label).
 */
export function checkPrefixAlignment(
  queryText: string,
  ontologyPrefixes: Record<string, string>,
  ignorePrefixes: Set<string> = DEFAULT_IGNORED_PREFIXES,
): PrefixMisalignment[] {
  const queryPrefixes = extractPrefixes(queryText);
  const findings: PrefixMisalignment[] = [];

  const byNamespace = new Map<string, string>();
  for (const [p, iri] of Object.entries(ontologyPrefixes)) byNamespace.set(iri, p);

  for (const [prefix, iri] of Object.entries(queryPrefixes)) {
    if (ignorePrefixes.has(prefix)) continue;

    const ontologyIri = ontologyPrefixes[prefix];
    if (ontologyIri !== undefined) {
      if (ontologyIri !== iri) {
        findings.push({
          prefix,
          queryNamespace: iri,
          kind: 'namespace_mismatch',
          detail: `'${prefix}:' is <${iri}> here, but the ontology binds '${prefix}:' to <${ontologyIri}>.`,
        });
      }
      continue;
    }

    const ownerPrefix = byNamespace.get(iri);
    if (ownerPrefix) {
      findings.push({
        prefix,
        queryNamespace: iri,
        kind: 'prefix_name_mismatch',
        detail: `<${iri}> is abbreviated '${prefix}:' here, but the ontology uses '${ownerPrefix}:'.`,
      });
    } else {
      findings.push({
        prefix,
        queryNamespace: iri,
        kind: 'undeclared_namespace',
        detail: `'${prefix}:' (<${iri}>) does not appear, under any prefix, in the given ontology.`,
      });
    }
  }
  return findings;
}

/**
 * Ports prefix_alignment.py::check_undeclared_terms: builds the same
 * CONSTRUCT-template sketch the `sketch` pipeline stage does, then reports
 * every class (via rdf:type) or property it references that the ontology
 * never declares.
 */
export function checkUndeclaredTerms(queryText: string, ontologyQuads: Quad[]): UndeclaredTerm[] {
  const sketch = sketchQuery(queryText);
  const turtle = renderSketchTurtle([sketch]);

  let sketchQuads: Quad[];
  try {
    sketchQuads = new Parser().parse(turtle);
  } catch {
    return [];
  }

  const model = buildOntologyModel(ontologyQuads);
  const declaredClasses = new Set(
    [...model.terms.values()].filter((t) => t.kinds.includes('class')).map((t) => t.iri),
  );
  const declaredProperties = new Set(
    [...model.terms.values()]
      .filter((t) => t.kinds.includes('objectProperty') || t.kinds.includes('datatypeProperty') || t.kinds.includes('annotationProperty'))
      .map((t) => t.iri),
  );

  const usedClasses = new Set<string>();
  const usedProperties = new Set<string>();
  for (const q of sketchQuads) {
    if (q.predicate.value === RDF_TYPE) {
      if (q.object.termType === 'NamedNode') usedClasses.add(q.object.value);
      continue;
    }
    if (q.predicate.termType === 'NamedNode') usedProperties.add(q.predicate.value);
  }

  const findings: UndeclaredTerm[] = [];
  for (const cls of [...usedClasses].sort()) {
    if (!declaredClasses.has(cls)) {
      findings.push({
        kind: 'class',
        term: cls,
        detail: `${cls} is used with rdf:type in the query sketch but is never declared owl:Class/rdfs:Class in the ontology.`,
      });
    }
  }
  for (const prop of [...usedProperties].sort()) {
    if (!declaredProperties.has(prop)) {
      findings.push({
        kind: 'property',
        term: prop,
        detail: `${prop} is used in the query sketch but is never declared as a property in the ontology.`,
      });
    }
  }
  return findings;
}

export function checkAlignment(queryText: string, ontologyPrefixes: Record<string, string>, ontologyQuads: Quad[]): AlignmentReport {
  return {
    prefixMisalignments: checkPrefixAlignment(queryText, ontologyPrefixes),
    undeclaredTerms: checkUndeclaredTerms(queryText, ontologyQuads),
  };
}
