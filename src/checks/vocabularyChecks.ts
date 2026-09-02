import { buildOntologyModel } from '../rdf/ontologyModel';
import {
  RDFS_SUBCLASS_OF,
  RDFS_SUBPROPERTY_OF,
  RDFS_DOMAIN,
  RDFS_RANGE,
  OWL_EQUIVALENT_CLASS,
  OWL_DISJOINT_WITH,
  OWL_INVERSE_OF,
  OWL_ON_PROPERTY,
  OWL_ON_CLASS,
  OWL_SOME_VALUES_FROM,
  OWL_ALL_VALUES_FROM,
  SH_TARGET_CLASS,
  SH_CLASS,
  SH_PATH,
} from '../rdf/vocab';
import type { ResultRow } from '../types';
import type { Quad } from 'n3';

/**
 * Predicates whose NamedNode object is itself a term reference (a class/property IRI that
 * should resolve to something declared), not just arbitrary data -- used by runVocabularyChecks
 * below. Doesn't attempt to walk owl:intersectionOf/unionOf RDF-list members or SHACL's more
 * elaborate sh:path expressions (alternative/sequence paths, blank-node-headed) -- a heuristic
 * scoped to the common, high-value cases, consistent with this project's other text/graph
 * heuristics (e.g. language/completionContext.ts, language/termIndex.ts's statement-span scan).
 *
 * `rdf:type` is deliberately absent: an undeclared class in the type position is STR-001, which
 * reports the same focus node and the same value, so listing it here produced two findings with
 * two ids for one defect. STR-002 owns the predicate position for the same reason.
 */
const TERM_REFERENCING_OBJECT_PREDICATES = new Set([
  RDFS_SUBCLASS_OF,
  RDFS_SUBPROPERTY_OF,
  RDFS_DOMAIN,
  RDFS_RANGE,
  OWL_EQUIVALENT_CLASS,
  OWL_DISJOINT_WITH,
  OWL_INVERSE_OF,
  OWL_ON_PROPERTY,
  OWL_ON_CLASS,
  OWL_SOME_VALUES_FROM,
  OWL_ALL_VALUES_FROM,
  SH_TARGET_CLASS,
  SH_CLASS,
  SH_PATH,
]);

function namespaceOf(iri: string): string {
  const idx = Math.max(iri.lastIndexOf('#'), iri.lastIndexOf('/'));
  return idx >= 0 ? iri.slice(0, idx + 1) : iri;
}

/**
 * Closed-world check for undeclared vocabulary terms: SHACL's open-world semantics never flag
 * "used ex:Dgo, meant ex:Dog" since nothing *contradicts* an undeclared class/property existing --
 * it's simply never asserted to say anything about it either way. For a fixed set of
 * term-referencing predicates (rdfs:subClassOf/subPropertyOf/domain/range,
 * owl:equivalentClass/disjointWith/inverseOf/..., sh:targetClass/class/path) this flags a
 * NamedNode object that isn't declared as a class/property/individual/annotation-property
 * anywhere in `quads` -- the document plus its resolved imports (see
 * ontology/resolveImports.ts), since callers pass in the same merged-quads graph every other
 * local check runs against.
 *
 * The two positions it does *not* cover are the ones the registry already owns: an undeclared
 * class in the rdf:type object is STR-001, and an undeclared predicate is STR-002. Both report
 * the same focus node this would, so covering them here meant one defect arriving as two
 * findings under two ids -- and since neither of those applies the namespace guard below, they
 * were already reporting a superset. What is left is the axiom positions nothing else reads.
 *
 * Scoped to namespaces this graph has *some* closed-world knowledge of -- i.e. at least one
 * declared term already exists in that namespace somewhere in `quads` -- so a namespace this
 * ontology never actually pulled in (dcterms:, foaf:, or gist: when it isn't imported here) is
 * left alone rather than flooded with false positives for perfectly normal external references.
 * rdf:/rdfs:/owl:/sh:/skos:/xsd: are excluded the same way, automatically: no ontology declares
 * e.g. `owl:Class a owl:Class` itself, so those namespaces never accumulate any declared terms
 * to become "known" in the first place.
 */
export function runVocabularyChecks(quads: Quad[]): ResultRow[] {
  const model = buildOntologyModel(quads);
  const declaredIris = new Set(model.terms.keys());
  const knownNamespaces = new Set<string>();
  for (const iri of declaredIris) knownNamespaces.add(namespaceOf(iri));

  const rows: ResultRow[] = [];
  const seen = new Set<string>();

  const flag = (subj: string, pred: string, usedIri: string): void => {
    if (usedIri.startsWith('_:')) return; // blank nodes are never "vocabulary"
    if (declaredIris.has(usedIri)) return;
    if (!knownNamespaces.has(namespaceOf(usedIri))) return; // no closed-world knowledge of this namespace -- don't guess
    const key = `${subj}|${pred}|${usedIri}`;
    if (seen.has(key)) return;
    seen.add(key);
    rows.push({
      checkId: 'VOC-001',
      category: 'vocabulary',
      // Kept in step with registry.json's VOC-001 entry, which is where the id is now
      // declared -- so the Problems panel, `disabledChecks` and the run summary all name
      // this check the same way.
      title: 'Undeclared term referenced by an axiom',
      severity: 'Warning',
      focusNode: subj,
      path: pred,
      value: usedIri,
      message: `${subj} references ${usedIri} via ${pred}, but no class/property/individual with that exact IRI is declared anywhere in this document or its resolved imports -- likely a typo, or a term from an ontology that wasn't actually imported.`,
      remediation: 'Check the spelling against the declaring ontology, or add the missing owl:imports if this term is meant to come from elsewhere.',
      sources: ['vocabulary'],
    });
  };

  for (const q of quads) {
    if (q.subject.termType !== 'NamedNode') continue;
    const subj = q.subject.value;
    const pred = q.predicate.value;

    // The predicate position is STR-002's, and the rdf:type object is STR-001's. Both are
    // registry checks with SHACL and SPARQL formulations and their own Quick Fix templates,
    // and neither applies this check's namespace guard -- so they already report a superset
    // of what this would, and reporting it again only doubled the finding.
    if (q.object.termType === 'NamedNode' && TERM_REFERENCING_OBJECT_PREDICATES.has(pred)) {
      flag(subj, pred, q.object.value);
    }
  }

  return rows;
}
