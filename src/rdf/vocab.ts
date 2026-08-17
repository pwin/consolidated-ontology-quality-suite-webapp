export const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
export const RDFS = 'http://www.w3.org/2000/01/rdf-schema#';
export const OWL = 'http://www.w3.org/2002/07/owl#';
export const SKOS = 'http://www.w3.org/2004/02/skos/core#';
export const XSD = 'http://www.w3.org/2001/XMLSchema#';
export const SH = 'http://www.w3.org/ns/shacl#';
/** gist 14.1.0's namespace -- gist moved here from ontologies.semanticarts.com/gist/ between v11 and v14; always offer the current one. */
export const GIST = 'https://w3id.org/semanticarts/ns/ontology/gist/';

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
export const OWL_DISJOINT_WITH = `${OWL}disjointWith`;
export const OWL_INVERSE_OF = `${OWL}inverseOf`;
export const OWL_INTERSECTION_OF = `${OWL}intersectionOf`;
export const OWL_UNION_OF = `${OWL}unionOf`;
export const OWL_RESTRICTION = `${OWL}Restriction`;
export const OWL_ON_PROPERTY = `${OWL}onProperty`;
export const OWL_ON_CLASS = `${OWL}onClass`;
export const OWL_SOME_VALUES_FROM = `${OWL}someValuesFrom`;
export const OWL_ALL_VALUES_FROM = `${OWL}allValuesFrom`;

export const SKOS_DEFINITION = `${SKOS}definition`;
export const SKOS_PREF_LABEL = `${SKOS}prefLabel`;
export const SKOS_SCOPE_NOTE = `${SKOS}scopeNote`;
export const SKOS_EXAMPLE = `${SKOS}example`;

export const SH_TARGET_CLASS = `${SH}targetClass`;
export const SH_CLASS = `${SH}class`;
export const SH_PATH = `${SH}path`;

export const WELL_KNOWN_PREFIXES: Record<string, string> = {
  rdf: RDF,
  rdfs: RDFS,
  owl: OWL,
  skos: SKOS,
  xsd: XSD,
  sh: SH,
  gist: GIST,
};

/**
 * The shortest readable form of `iri` under `prefixes` -- `ex:Dog` rather than
 * the full IRI -- or the IRI unchanged when no prefix covers it.
 *
 * Candidates are ranked rather than taken in declaration order, which is what
 * this did before and which made the output depend on how the document happened
 * to be written:
 *
 * 1. **Longest namespace wins.** With both `http://ex.org/` and
 *    `http://ex.org/sub/` bound, `http://ex.org/sub/Thing` is `sub:Thing`, not
 *    `ex:sub/Thing` -- the latter is a *different* CURIE that only round-trips
 *    by accident, and is wrong outright if `/` were not legal in a local name.
 * 2. **A named prefix beats the empty one.** A document that binds both `:` and
 *    `ex:` to one namespace previously rendered `:Dog` or `ex:Dog` purely on
 *    which `@prefix` line came first. `ex:Dog` says which vocabulary the term is
 *    from, so it is preferred; `:Dog` is still used when `:` is the only binding.
 *
 * Ties beyond that keep declaration order, so the choice stays stable for a
 * given document.
 */
export function shrink(iri: string, prefixes: Record<string, string>): string {
  let best: { prefix: string; ns: string } | undefined;
  for (const [prefix, ns] of Object.entries(prefixes)) {
    if (!ns || !iri.startsWith(ns) || iri.length <= ns.length) continue;
    if (!best) {
      best = { prefix, ns };
      continue;
    }
    if (ns.length > best.ns.length) best = { prefix, ns };
    else if (ns.length === best.ns.length && best.prefix === '' && prefix !== '') best = { prefix, ns };
  }
  return best ? `${best.prefix}:${iri.slice(best.ns.length)}` : iri;
}

export function expand(curie: string, prefixes: Record<string, string>): string | null {
  const colon = curie.indexOf(':');
  if (colon < 0) return null;
  const prefix = curie.slice(0, colon);
  const local = curie.slice(colon + 1);
  const ns = prefixes[prefix];
  return ns ? ns + local : null;
}
