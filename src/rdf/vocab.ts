export const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
export const RDFS = 'http://www.w3.org/2000/01/rdf-schema#';
export const OWL = 'http://www.w3.org/2002/07/owl#';
export const SKOS = 'http://www.w3.org/2004/02/skos/core#';
export const XSD = 'http://www.w3.org/2001/XMLSchema#';
export const SH = 'http://www.w3.org/ns/shacl#';

export const RDF_TYPE = `${RDF}type`;
export const RDFS_LABEL = `${RDFS}label`;
export const RDFS_COMMENT = `${RDFS}comment`;
export const RDFS_SUBCLASS_OF = `${RDFS}subClassOf`;
export const RDFS_SUBPROPERTY_OF = `${RDFS}subPropertyOf`;
export const RDFS_DOMAIN = `${RDFS}domain`;
export const RDFS_RANGE = `${RDFS}range`;
export const RDFS_ISDEFINEDBY = `${RDFS}isDefinedBy`;

export const OWL_CLASS = `${OWL}Class`;
export const OWL_OBJECT_PROPERTY = `${OWL}ObjectProperty`;
export const OWL_DATATYPE_PROPERTY = `${OWL}DatatypeProperty`;
export const OWL_ANNOTATION_PROPERTY = `${OWL}AnnotationProperty`;
export const OWL_ONTOLOGY = `${OWL}Ontology`;
export const OWL_IMPORTS = `${OWL}imports`;
export const OWL_VERSION_IRI = `${OWL}versionIRI`;
export const OWL_VERSION_INFO = `${OWL}versionInfo`;
export const OWL_EQUIVALENT_CLASS = `${OWL}equivalentClass`;
export const OWL_INVERSE_OF = `${OWL}inverseOf`;
export const OWL_INTERSECTION_OF = `${OWL}intersectionOf`;
export const OWL_UNION_OF = `${OWL}unionOf`;
export const OWL_RESTRICTION = `${OWL}Restriction`;

export const SKOS_DEFINITION = `${SKOS}definition`;
export const SKOS_PREF_LABEL = `${SKOS}prefLabel`;
export const SKOS_SCOPE_NOTE = `${SKOS}scopeNote`;
export const SKOS_EXAMPLE = `${SKOS}example`;

export const WELL_KNOWN_PREFIXES: Record<string, string> = {
  rdf: RDF,
  rdfs: RDFS,
  owl: OWL,
  skos: SKOS,
  xsd: XSD,
  sh: SH,
};

export function shrink(iri: string, prefixes: Record<string, string>): string {
  for (const [prefix, ns] of Object.entries(prefixes)) {
    if (ns && iri.startsWith(ns) && iri.length > ns.length) {
      return `${prefix}:${iri.slice(ns.length)}`;
    }
  }
  return iri;
}

export function expand(curie: string, prefixes: Record<string, string>): string | null {
  const colon = curie.indexOf(':');
  if (colon < 0) return null;
  const prefix = curie.slice(0, colon);
  const local = curie.slice(colon + 1);
  const ns = prefixes[prefix];
  return ns ? ns + local : null;
}
