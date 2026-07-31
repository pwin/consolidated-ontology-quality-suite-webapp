import { buildOntologyModel } from '../rdf/ontologyModel';
import type { ResultRow } from '../types';
import type { Quad } from 'n3';

const CATEGORY_SCOPE_NOTE =
  "Often a type can be modeled either as an owl:Class or as a gist:Category. Use the latter if you don't care much about the formal structure of the different types, or if there is a whole hierarchy of types that are going to be managed by a group separate from the ontology developers.";

/**
 * Advisory (Hint-severity) modelling-convention rules grounded against
 * consolidated_ontology_suite/examples/gist_versions_reference/gistCore14.1.0.ttl
 * -- see the plan's "Gist-informed modelling guidance" section for the
 * grounding evidence behind each rule. Gated by ontologySuite.modellingGuidance;
 * callers should skip invoking this module entirely when the setting is 'off'.
 */
export function runModellingGuidance(quads: Quad[]): ResultRow[] {
  const model = buildOntologyModel(quads);
  const rows: ResultRow[] = [];

  for (const term of model.terms.values()) {
    // MDL-001: a named object/datatype property declared solely as the
    // inverse of another named property. Gist itself only ever uses
    // owl:inverseOf inline, scoped to one restriction's anonymous property
    // expression -- never as a pair of top-level declared properties.
    if (term.inverseOf.length > 0 && (term.kinds.includes('objectProperty') || term.kinds.includes('datatypeProperty'))) {
      for (const inverseOfIri of term.inverseOf) {
        rows.push({
          checkId: 'MDL-001',
          category: 'guidance',
          title: 'Named inverse property (consider a SPARQL property path instead)',
          severity: 'Hint',
          focusNode: term.iri,
          path: null,
          value: inverseOfIri,
          message: `${term.iri} is declared as owl:inverseOf ${inverseOfIri} as a top-level property. gist's own convention only ever uses owl:inverseOf inline, scoped to a single restriction -- consider a SPARQL property path (e.g. ^${shortHint(inverseOfIri)}) for reverse traversal instead of maintaining both directions as named properties.`,
          remediation: 'Remove the named inverse property and use a SPARQL property path for reverse traversal, or scope owl:inverseOf inline to the one restriction that needs it.',
          sources: ['guidance'],
        });
      }
    }

    // MDL-002: owl:equivalentClass between two plain named classes, with no
    // attached logical definition (intersectionOf/unionOf/restriction --
    // those parse as blank-node objects and never populate this array; see
    // rdf/ontologyModel.ts).
    if (term.equivalentClass.length > 0 && term.kinds.includes('class')) {
      for (const equivIri of term.equivalentClass) {
        rows.push({
          checkId: 'MDL-002',
          category: 'guidance',
          title: 'owl:equivalentClass between two named classes with no logical definition',
          severity: 'Hint',
          focusNode: term.iri,
          path: null,
          value: equivIri,
          message: `${term.iri} owl:equivalentClass ${equivIri} with no attached intersectionOf/unionOf/restriction definition. gist reserves owl:equivalentClass for fully-defined classes; a plain alias between two named classes is usually rdfs:subClassOf (taxonomic specialization) or a SKOS mapping (skos:closeMatch/exactMatch, for cross-ontology alignment).`,
          remediation: 'Replace with rdfs:subClassOf if this is specialization, or skos:closeMatch/exactMatch if this is a cross-ontology alignment.',
          sources: ['guidance'],
        });
      }
    }

    // MDL-003: a class with no restrictions/properties of its own -- an
    // enum-like classification candidate for gist:Category instead.
    if (term.kinds.includes('class') && !term.hasOwnStructure && term.subClassOf.length === 0) {
      rows.push({
        checkId: 'MDL-003',
        category: 'guidance',
        title: 'Consider gist:Category instead of a new owl:Class',
        severity: 'Hint',
        focusNode: term.iri,
        path: null,
        value: null,
        message: `${term.iri} has no property restrictions of its own -- if it's purely a classification/tag rather than a thing with independent structure or relationships, consider modelling it as a gist:Category instead. ${CATEGORY_SCOPE_NOTE}`,
        remediation: "If this is a classification/tag, model it as an individual `a gist:Category` (or a project-local equivalent) rather than a new owl:Class.",
        sources: ['guidance'],
      });
    }
  }

  return rows;
}

function shortHint(iri: string): string {
  const idx = Math.max(iri.lastIndexOf('#'), iri.lastIndexOf('/'));
  return idx >= 0 ? iri.slice(idx + 1) : iri;
}
