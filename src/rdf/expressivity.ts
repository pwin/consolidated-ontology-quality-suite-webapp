import type { Quad } from 'n3';
import { OWL, RDFS } from './vocab';

export type Owl2Profile = 'EL' | 'QL' | 'RL';

export interface ProfileViolation {
  profile: Owl2Profile;
  construct: string;
  exampleSubject: string;
}

export interface DlConstructFlags {
  complexClassOps: boolean; // unionOf / complementOf -> "C"
  existential: boolean; // someValuesFrom -> "E" (part of AL extension)
  universal: boolean; // allValuesFrom
  roleHierarchy: boolean; // subPropertyOf between object properties -> "H"
  inverseRoles: boolean; // inverseOf -> "I"
  nominals: boolean; // oneOf / hasValue -> "O"
  unqualifiedCardinality: boolean; // cardinality/minCardinality/maxCardinality -> "N"
  qualifiedCardinality: boolean; // qualifiedCardinality/min.../max... -> "Q"
  transitiveRoles: boolean; // TransitiveProperty (part of "S" / "+")
  complexRoleAxioms: boolean; // reflexive/irreflexive/asymmetric/disjoint properties, property chains -> "R"
  functionalRoles: boolean; // FunctionalProperty / InverseFunctionalProperty -> "F"
  datatypes: boolean; // any rdfs:range pointing at an XSD datatype -> "(D)"
}

export interface ExpressivityResult {
  dlExpressivity: string;
  flags: DlConstructFlags;
  profileMembership: Record<Owl2Profile, boolean>;
  profileViolations: ProfileViolation[];
}

const CARDINALITY_PREDICATES = new Set([`${OWL}cardinality`, `${OWL}minCardinality`, `${OWL}maxCardinality`]);
const QUALIFIED_CARDINALITY_PREDICATES = new Set([
  `${OWL}qualifiedCardinality`,
  `${OWL}minQualifiedCardinality`,
  `${OWL}maxQualifiedCardinality`,
]);

/**
 * Heuristic, syntactic DL-expressivity + OWL2 EL/QL/RL profile-membership
 * indicator -- ports the spirit of consolidated_ontology_suite's
 * reasoning/profile.py (syntactic construct scanning, no DL reasoner
 * involved) plus a conventional "ALC.../SROIQ(D)"-style expressivity
 * letter computation (as e.g. Protege's ontology metrics tab shows).
 * Explicitly NOT a certified OWL2 DL conformance calculation -- treat as a
 * fast, always-available indicator of how far the ontology currently
 * reaches beyond the lighter profiles, not a substitute for a real
 * reasoner's verdict (see checks/reasoningRunner.ts / the Python CLI's
 * owlready2 deep-validation fallback for that).
 */
export function analyzeExpressivity(quads: Quad[]): ExpressivityResult {
  const flags: DlConstructFlags = {
    complexClassOps: false,
    existential: false,
    universal: false,
    roleHierarchy: false,
    inverseRoles: false,
    nominals: false,
    unqualifiedCardinality: false,
    qualifiedCardinality: false,
    transitiveRoles: false,
    complexRoleAxioms: false,
    functionalRoles: false,
    datatypes: false,
  };

  const objectProperties = new Set<string>();
  const violations: ProfileViolation[] = [];
  const flag = (key: keyof DlConstructFlags) => {
    flags[key] = true;
  };

  for (const q of quads) {
    const pred = q.predicate.value;
    const objType = q.object.termType;

    if (pred === `${RDFS}range` && objType === 'NamedNode' && q.object.value.startsWith('http://www.w3.org/2001/XMLSchema#')) {
      flag('datatypes');
    }
    if (pred === `${OWL}unionOf` || pred === `${OWL}complementOf`) flag('complexClassOps');
    if (pred === `${OWL}someValuesFrom`) flag('existential');
    if (pred === `${OWL}allValuesFrom`) flag('universal');
    if (pred === `${OWL}inverseOf`) flag('inverseRoles');
    if (pred === `${OWL}oneOf` || pred === `${OWL}hasValue`) flag('nominals');
    if (CARDINALITY_PREDICATES.has(pred)) flag('unqualifiedCardinality');
    if (QUALIFIED_CARDINALITY_PREDICATES.has(pred)) flag('qualifiedCardinality');
    if (pred === `${OWL}propertyChainAxiom`) flag('complexRoleAxioms');
    if (
      pred === 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type' &&
      objType === 'NamedNode' &&
      [`${OWL}ReflexiveProperty`, `${OWL}IrreflexiveProperty`, `${OWL}AsymmetricProperty`].includes(q.object.value)
    ) {
      flag('complexRoleAxioms');
    }
    if (
      pred === 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type' &&
      objType === 'NamedNode' &&
      q.object.value === `${OWL}TransitiveProperty`
    ) {
      flag('transitiveRoles');
    }
    if (
      pred === 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type' &&
      objType === 'NamedNode' &&
      [`${OWL}FunctionalProperty`, `${OWL}InverseFunctionalProperty`].includes(q.object.value)
    ) {
      flag('functionalRoles');
    }
    if (pred === `${RDFS}subPropertyOf`) flag('roleHierarchy');
    if (pred === 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type' && objType === 'NamedNode' && q.object.value === `${OWL}ObjectProperty`) {
      objectProperties.add(q.subject.value);
    }
  }

  const profileMembership: Record<Owl2Profile, boolean> = { EL: true, QL: true, RL: true };
  const disallow = (profile: Owl2Profile, construct: string, present: boolean, exampleSubject = '') => {
    if (present) {
      profileMembership[profile] = false;
      violations.push({ profile, construct, exampleSubject });
    }
  };

  // EL: no unionOf/complementOf, no allValuesFrom, no cardinality (qualified or not), no inverse properties.
  disallow('EL', 'owl:unionOf / owl:complementOf', flags.complexClassOps);
  disallow('EL', 'owl:allValuesFrom', flags.universal);
  disallow('EL', 'cardinality restrictions', flags.unqualifiedCardinality || flags.qualifiedCardinality);
  disallow('EL', 'owl:inverseOf', flags.inverseRoles);
  disallow('EL', 'owl:FunctionalProperty / owl:InverseFunctionalProperty', flags.functionalRoles);

  // QL: no unionOf/complementOf, no cardinality >1 (approximated as any cardinality construct), no transitive properties,
  // someValuesFrom only in subclass (not superclass) position -- approximated conservatively as "any someValuesFrom flags it".
  disallow('QL', 'owl:unionOf / owl:complementOf', flags.complexClassOps);
  disallow('QL', 'cardinality restrictions', flags.unqualifiedCardinality || flags.qualifiedCardinality);
  disallow('QL', 'owl:TransitiveProperty', flags.transitiveRoles);
  disallow('QL', 'owl:someValuesFrom in superclass position (approximated)', flags.existential && flags.universal);

  // RL: no unionOf in subclass position / complementOf, no cardinality restrictions >1, no nominals in most positions (approximated).
  disallow('RL', 'owl:complementOf', flags.complexClassOps);
  disallow('RL', 'qualified/unqualified cardinality >1 (approximated)', flags.unqualifiedCardinality || flags.qualifiedCardinality);

  return { dlExpressivity: assembleExpressivityLabel(flags), flags, profileMembership, profileViolations: violations };
}

function assembleExpressivityLabel(flags: DlConstructFlags): string {
  const hasAlc = flags.complexClassOps || (flags.existential && flags.universal);
  let base = hasAlc ? 'ALC' : flags.existential ? 'AL' : 'AL';
  if (flags.existential && !hasAlc) base = 'AL'; // AL already implies limited existential in some conventions; kept simple
  if (hasAlc && flags.transitiveRoles) base = 'S'; // S is shorthand for ALC + transitive roles
  else if (flags.transitiveRoles) base += '+';

  let label = base;
  if (flags.roleHierarchy) label += 'H';
  if (flags.nominals) label += 'O';
  if (flags.inverseRoles) label += 'I';
  if (flags.qualifiedCardinality) label += 'Q';
  else if (flags.unqualifiedCardinality) label += 'N';
  if (flags.complexRoleAxioms) label += 'R';
  else if (flags.functionalRoles) label += 'F';
  if (flags.datatypes) label += '(D)';
  return label;
}
