import { Quad } from 'n3';
import {
  OWL_ANNOTATION_PROPERTY,
  OWL_CLASS,
  OWL_DATATYPE_PROPERTY,
  OWL_EQUIVALENT_CLASS,
  OWL_INVERSE_OF,
  OWL_OBJECT_PROPERTY,
  OWL_ONTOLOGY,
  RDF_TYPE,
  RDFS_COMMENT,
  RDFS_DOMAIN,
  RDFS_LABEL,
  RDFS_RANGE,
  RDFS_ISDEFINEDBY,
  RDFS_SUBCLASS_OF,
  RDFS_SUBPROPERTY_OF,
  SKOS_DEFINITION,
  SKOS_EXAMPLE,
  SKOS_PREF_LABEL,
  SKOS_SCOPE_NOTE,
} from './vocab';

/** Purely documentary predicates -- never count as "own structure" for the gist:Category heuristic (MDL-003). */
const ANNOTATION_ONLY_PREDICATES = new Set([SKOS_PREF_LABEL, SKOS_SCOPE_NOTE, SKOS_EXAMPLE, RDFS_ISDEFINEDBY]);

export type TermKind = 'class' | 'objectProperty' | 'datatypeProperty' | 'annotationProperty' | 'individual' | 'ontology';

export interface TermInfo {
  iri: string;
  kinds: TermKind[];
  label?: string;
  comment?: string;
  definition?: string;
  domain: string[];
  range: string[];
  subClassOf: string[];
  subPropertyOf: string[];
  equivalentClass: string[];
  inverseOf: string[];
  /** True if this class/property has no restrictions/properties of its own beyond annotations -- used by MDL-003. */
  hasOwnStructure: boolean;
}

export interface OntologyModel {
  ontologyIri: string | null;
  imports: string[];
  versionIri: string | null;
  terms: Map<string, TermInfo>;
}

function getOrCreate(terms: Map<string, TermInfo>, iri: string): TermInfo {
  let t = terms.get(iri);
  if (!t) {
    t = {
      iri,
      kinds: [],
      domain: [],
      range: [],
      subClassOf: [],
      subPropertyOf: [],
      equivalentClass: [],
      inverseOf: [],
      hasOwnStructure: false,
    };
    terms.set(iri, t);
  }
  return t;
}

export function buildOntologyModel(quads: Quad[]): OntologyModel {
  const terms = new Map<string, TermInfo>();
  let ontologyIri: string | null = null;
  let versionIri: string | null = null;
  const imports: string[] = [];

  for (const q of quads) {
    if (q.subject.termType !== 'NamedNode') continue;
    const subj = q.subject.value;
    const pred = q.predicate.value;
    const obj = q.object;

    if (pred === RDF_TYPE && obj.termType === 'NamedNode') {
      const t = getOrCreate(terms, subj);
      switch (obj.value) {
        case OWL_CLASS:
          t.kinds.push('class');
          break;
        case OWL_OBJECT_PROPERTY:
          t.kinds.push('objectProperty');
          break;
        case OWL_DATATYPE_PROPERTY:
          t.kinds.push('datatypeProperty');
          break;
        case OWL_ANNOTATION_PROPERTY:
          t.kinds.push('annotationProperty');
          break;
        case OWL_ONTOLOGY:
          ontologyIri = subj;
          break;
        default:
          getOrCreate(terms, subj).kinds.push('individual');
      }
      continue;
    }

    if (pred === 'http://www.w3.org/2002/07/owl#imports' && obj.termType === 'NamedNode') {
      imports.push(obj.value);
      continue;
    }
    if (pred === 'http://www.w3.org/2002/07/owl#versionIRI' && obj.termType === 'NamedNode') {
      versionIri = obj.value;
      continue;
    }

    const t = terms.get(subj);
    if (!t) continue;

    switch (pred) {
      case RDFS_LABEL:
        t.label = obj.value;
        break;
      case RDFS_COMMENT:
        t.comment = obj.value;
        break;
      case SKOS_DEFINITION:
        t.definition = obj.value;
        break;
      case RDFS_DOMAIN:
        if (obj.termType === 'NamedNode') t.domain.push(obj.value);
        break;
      case RDFS_RANGE:
        if (obj.termType === 'NamedNode') t.range.push(obj.value);
        break;
      case RDFS_SUBCLASS_OF:
        if (obj.termType === 'NamedNode') t.subClassOf.push(obj.value);
        else t.hasOwnStructure = true; // blank-node restriction => real structure
        break;
      case RDFS_SUBPROPERTY_OF:
        if (obj.termType === 'NamedNode') t.subPropertyOf.push(obj.value);
        break;
      case OWL_EQUIVALENT_CLASS:
        if (obj.termType === 'NamedNode') t.equivalentClass.push(obj.value);
        else t.hasOwnStructure = true;
        break;
      case OWL_INVERSE_OF:
        if (obj.termType === 'NamedNode') t.inverseOf.push(obj.value);
        break;
      default:
        if (ANNOTATION_ONLY_PREDICATES.has(pred)) break;
        // Any other outgoing property restriction/axiom on this term counts
        // as "own structure" for the gist:Category heuristic (MDL-003).
        t.hasOwnStructure = true;
    }
  }

  return { ontologyIri, imports, versionIri, terms };
}
