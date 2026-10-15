import { BlankNode, DataFactory, NamedNode, Quad, Quad_Object } from 'n3';
import {
  RDF_TYPE,
  RDFS_LABEL,
  RDFS_COMMENT,
  RDFS_SUBCLASS_OF,
  RDFS_SUBPROPERTY_OF,
  RDFS_DOMAIN,
  RDFS_RANGE,
  OWL_CLASS,
  OWL_OBJECT_PROPERTY,
  OWL_DATATYPE_PROPERTY,
  OWL_EQUIVALENT_CLASS,
  OWL_DISJOINT_WITH,
  OWL_ONTOLOGY,
  OWL_VERSION_IRI,
  OWL_VERSION_INFO,
  OWL_PRIOR_VERSION,
  OWL_IMPORTS,
  OWL,
  RDFS,
  XSD,
  WELL_KNOWN_PREFIXES,
  resolveTermName,
} from '../rdf/vocab';
import { classExprToRdf, rdfList } from '../rdf/formats/classExpression';
import { ClassExpr, ClassExpressionSyntaxError, mapClassExprNames, parseClassExpressionStrict } from '../rdf/formats/classExpressionParser';

/**
 * Tawny-OWL-inspired scripting DSL: build an ontology as real TypeScript
 * code (functions, loops, your own abstractions for repeated patterns)
 * instead of only ever hand-authoring Turtle or clicking through the
 * Outline. Runs in a forked child process (see scriptRunnerEntry.ts), not
 * the extension host itself -- see that file for why.
 *
 * Deliberately thin: defclass/defobjectproperty/defdatatypeproperty just
 * emit quads via n3's DataFactory, and the restriction-builders
 * (some/only/and/or/not) return the exact same ClassExpr AST
 * rdf/formats/classExpression.ts already defines for `.omn` files and the
 * Outline's "Add Subclass" Manchester-expression option -- classExprToRdf
 * (already built, already tested) does 100% of the actual RDF generation
 * for restrictions here too. No second expression-to-RDF implementation.
 *
 * Testing is deliberately NOT reimplemented here either: run this script's
 * output through the existing "Run Local Checks" / competency-question
 * Test Explorer integration, exactly as you would for a hand-authored
 * file -- both already validate any graph, not just hand-authored ones.
 */

const { namedNode, blankNode, literal, quad } = DataFactory;
const XSD_STRING = `${XSD}string`;

export interface ClassRef {
  kind: 'class';
  iri: string;
  localName: string;
}

export interface ObjectPropertyRef {
  kind: 'objectProperty';
  iri: string;
  localName: string;
}

export interface DatatypePropertyRef {
  kind: 'datatypeProperty';
  iri: string;
  localName: string;
}

export type PropertyRef = ObjectPropertyRef | DatatypePropertyRef;

export interface IndividualRef {
  kind: 'individual';
  iri: string;
  localName: string;
}

export type Ref = ClassRef | PropertyRef | IndividualRef;

/**
 * A literal: a string is xsd:string, a whole number xsd:integer, any other number xsd:decimal, a
 * boolean xsd:boolean; `{ value, language }` and `{ value, datatype }` say so themselves.
 */
export type LiteralValue = string | number | boolean | { value: string; language: string } | { value: string; datatype: string };

interface OntologyBuilder {
  baseIri: string;
  prefix: string;
  /** defontology()'s triples, kept apart so that build() can put them first. */
  header: Quad[];
  quads: Quad[];
  prefixes: Record<string, string>;
}

let current: OntologyBuilder | undefined;

/** Must be called once, before any defclass/defobjectproperty/defdatatypeproperty call. */
export function ontology(baseIri: string, prefix: string, extraPrefixes: Record<string, string> = {}): void {
  current = { baseIri, prefix, header: [], quads: [], prefixes: { ...WELL_KNOWN_PREFIXES, [prefix]: baseIri, ...extraPrefixes } };
}

function requireCurrent(): OntologyBuilder {
  if (!current) throw new Error("Call ontology(baseIri, prefix) before defining any classes/properties.");
  return current;
}

/** An annotation's value: a literal, or `{ iri }` for an IRI. */
export type AnnotationValue = LiteralValue | { iri: string };

/** A label's or comment's text: plain, or tagged with its language. */
export type TextValue = string | { value: string; language: string };

/** What the ontology and every class and property can carry. */
export interface Annotated {
  /** One label, or several -- one per language, say. */
  label?: TextValue | TextValue[];
  comment?: TextValue | TextValue[];
  /** Any other annotation, keyed by property (`'skos:definition'`, or a full IRI). A list gives the property several values. */
  annotations?: Record<string, AnnotationValue | AnnotationValue[]>;
}

export interface DefOntologyOptions extends Annotated {
  versionIRI?: string;
  versionInfo?: string;
  /** owl:priorVersion -- the IRI of the version this one replaces. */
  priorVersion?: string;
  /** One owl:imports per IRI. The extension resolves an import to a local file by the file's ontology IRI or its owl:versionIRI. */
  imports?: string[];
}

/**
 * The ontology's own header: `<iri> a owl:Ontology`, with its version, imports and annotations.
 * At most once per script, after ontology(); the header comes first in the output wherever the
 * call is. IRIs can be full (`http://...`, `urn:...`) or CURIEs over ontology()'s prefixes.
 */
export function defontology(iri: string, opts: DefOntologyOptions = {}): void {
  const b = requireCurrent();
  if (b.header.length > 0) throw new Error('defontology() was already called: an ontology has one header.');
  const subject = namedNode(resolveIri(b, iri));
  const add = (predicate: string, object: Quad_Object) => b.header.push(quad(subject, namedNode(predicate), object));
  add(RDF_TYPE, namedNode(OWL_ONTOLOGY));
  if (opts.versionIRI) add(OWL_VERSION_IRI, namedNode(resolveIri(b, opts.versionIRI)));
  if (opts.versionInfo) add(OWL_VERSION_INFO, literal(opts.versionInfo, namedNode(XSD_STRING)));
  if (opts.priorVersion) add(OWL_PRIOR_VERSION, namedNode(resolveIri(b, opts.priorVersion)));
  for (const imported of opts.imports ?? []) add(OWL_IMPORTS, namedNode(resolveIri(b, imported)));
  b.header.push(...annotations(b, subject, opts));
}

/** `opts`'s labels, comments and other annotations, as triples about `subject`. An empty label or comment is left out. */
function annotations(b: OntologyBuilder, subject: NamedNode, opts: Annotated): Quad[] {
  const listOf = <T>(x: T | T[] | undefined): T[] => (x === undefined ? [] : Array.isArray(x) ? x : [x]);
  const texts = (predicate: string, values: TextValue | TextValue[] | undefined) =>
    listOf(values)
      .map((t) => (typeof t === 'string' ? { value: t, language: undefined } : t))
      .filter((t) => t.value !== '')
      .map((t) => quad(subject, namedNode(predicate), t.language ? literal(t.value, t.language) : literal(t.value, namedNode(XSD_STRING))));
  return [
    ...texts(RDFS_LABEL, opts.label),
    ...texts(RDFS_COMMENT, opts.comment),
    ...Object.entries(opts.annotations ?? {}).flatMap(([property, values]) =>
      listOf(values).map((value) => quad(subject, namedNode(resolveIri(b, property)), annotationObject(b, value))),
    ),
  ];
}

function annotationObject(b: OntologyBuilder, value: AnnotationValue): Quad_Object {
  return typeof value === 'object' && 'iri' in value ? namedNode(resolveIri(b, value.iri)) : literalTerm(b, value);
}

/** A literal's lexical form, and its datatype or language; a plain string carries neither. */
function literalParts(b: OntologyBuilder, value: LiteralValue): { value: string; datatype?: string; language?: string } {
  if (typeof value === 'string') return { value };
  if (typeof value === 'boolean') return { value: String(value), datatype: `${XSD}boolean` };
  if (typeof value === 'number') {
    const text = String(value);
    if (!Number.isFinite(value) || /e/i.test(text)) {
      throw new Error(`${value} has no xsd:integer or xsd:decimal form. Write it as { value, datatype }, with xsd:double, say.`);
    }
    return { value: text, datatype: Number.isInteger(value) ? `${XSD}integer` : `${XSD}decimal` };
  }
  if ('language' in value) return { value: value.value, language: value.language };
  return { value: value.value, datatype: resolveIri(b, value.datatype) };
}

function literalTerm(b: OntologyBuilder, value: LiteralValue): Quad_Object {
  const parts = literalParts(b, value);
  return parts.language ? literal(parts.value, parts.language) : literal(parts.value, namedNode(parts.datatype ?? XSD_STRING));
}

/** A full IRI as given, or a CURIE expanded over the ontology's prefixes. */
function resolveIri(b: OntologyBuilder, ref: string): string {
  const iri = resolveTermName(ref, b.prefixes);
  if (iri) return iri;
  throw new Error(`"${ref}" is neither a full IRI nor a CURIE with a known prefix. Add the prefix to ontology()'s third argument.`);
}

/** As resolveIri, and a bare name (no `:`) is a term in this ontology, as in Manchester Syntax. */
function resolveName(b: OntologyBuilder, ref: string): string {
  return ref.includes(':') ? resolveIri(b, ref) : resolveTermName(ref, b.prefixes, b.baseIri)!;
}

function toClassExprNode(b: OntologyBuilder, x: ClassRef | ClassExpr) {
  const expr: ClassExpr = 'localName' in x ? { kind: 'class', iri: x.iri } : x;
  return classExprToRdf(expr, b.prefixes, b.quads);
}

export interface DefClassOptions extends Annotated {
  /** Named parents and/or restriction expressions (e.g. `some(hasChild, Person)`) -- each becomes its own rdfs:subClassOf triple, exactly like the Outline's "Add Subclass" + optional Manchester restriction. */
  subClassOf?: (ClassRef | ClassExpr)[];
  /** Full definition (necessary+sufficient conditions) -- see gist's own convention (MDL-002): reserve this for genuinely defined classes, not a casual alias between two named classes. */
  equivalentClass?: ClassExpr;
  /** owl:disjointWith one or more other classes -- e.g. so REA-DISJOINT can catch an individual asserted (directly or by inference) as a member of two of them. */
  disjointWith?: ClassRef[];
}

export function defclass(name: string, opts: DefClassOptions = {}): ClassRef {
  const b = requireCurrent();
  const iri = `${b.baseIri}${name}`;
  const subject = namedNode(iri);
  b.quads.push(quad(subject, namedNode(RDF_TYPE), namedNode(OWL_CLASS)));
  b.quads.push(...annotations(b, subject, opts));
  for (const parent of opts.subClassOf ?? []) {
    b.quads.push(quad(subject, namedNode(RDFS_SUBCLASS_OF), toClassExprNode(b, parent)));
  }
  for (const other of opts.disjointWith ?? []) {
    b.quads.push(quad(subject, namedNode(OWL_DISJOINT_WITH), namedNode(other.iri)));
  }
  if (opts.equivalentClass) {
    b.quads.push(quad(subject, namedNode(OWL_EQUIVALENT_CLASS), toClassExprNode(b, opts.equivalentClass)));
  }
  return { kind: 'class', iri, localName: name };
}

/** What both kinds of property take. */
export interface DefPropertyOptions extends Annotated {
  domain?: ClassRef;
}

export type ObjectPropertyCharacteristic = 'functional' | 'inverseFunctional' | 'transitive' | 'symmetric' | 'asymmetric' | 'reflexive' | 'irreflexive';

export interface DefObjectPropertyOptions extends DefPropertyOptions {
  range?: ClassRef;
  subPropertyOf?: ObjectPropertyRef;
  /** Each makes the property `a owl:FunctionalProperty`, `a owl:TransitiveProperty`, and so on. */
  characteristics?: ObjectPropertyCharacteristic[];
  /**
   * owl:inverseOf another object property. Local Checks' MDL-001 hints against a named inverse,
   * after gist's convention of reaching the reverse direction with a SPARQL path instead.
   */
  inverseOf?: ObjectPropertyRef;
  /** owl:propertyChainAxiom: following these properties in turn implies this one. Two or more. */
  chain?: ObjectPropertyRef[];
}

export interface DefDatatypePropertyOptions extends DefPropertyOptions {
  /** A datatype, with or without facets: `datatype('xsd:integer', { minInclusive: 0 })`. */
  range?: DatatypeRef;
  subPropertyOf?: DatatypePropertyRef;
  /** A datatype property can only be functional. */
  characteristics?: 'functional'[];
}

const CHARACTERISTIC_TYPES: Record<ObjectPropertyCharacteristic, string> = {
  functional: `${OWL}FunctionalProperty`,
  inverseFunctional: `${OWL}InverseFunctionalProperty`,
  transitive: `${OWL}TransitiveProperty`,
  symmetric: `${OWL}SymmetricProperty`,
  asymmetric: `${OWL}AsymmetricProperty`,
  reflexive: `${OWL}ReflexiveProperty`,
  irreflexive: `${OWL}IrreflexiveProperty`,
};

/** What both kinds of property declaration write: the type, annotations, domain, parent and characteristics. */
function declareProperty(
  b: OntologyBuilder,
  iri: string,
  owlType: string,
  opts: DefPropertyOptions & { subPropertyOf?: PropertyRef; characteristics?: string[] },
): NamedNode {
  const subject = namedNode(iri);
  b.quads.push(quad(subject, namedNode(RDF_TYPE), namedNode(owlType)));
  b.quads.push(...annotations(b, subject, opts));
  if (opts.domain) b.quads.push(quad(subject, namedNode(RDFS_DOMAIN), namedNode(opts.domain.iri)));
  if (opts.subPropertyOf) b.quads.push(quad(subject, namedNode(RDFS_SUBPROPERTY_OF), namedNode(opts.subPropertyOf.iri)));
  for (const characteristic of opts.characteristics ?? []) {
    const type = CHARACTERISTIC_TYPES[characteristic as ObjectPropertyCharacteristic];
    if (!type) throw new Error(`"${characteristic}" is not a property characteristic.`);
    b.quads.push(quad(subject, namedNode(RDF_TYPE), namedNode(type)));
  }
  return subject;
}

/** `ref`'s IRI, if it is an object property; for scripts the type checker didn't see. */
function objectPropertyIri(ref: PropertyRef, option: string): string {
  if (ref.kind !== 'objectProperty') throw new Error(`${ref.localName} is not an object property; ${option} takes object properties.`);
  return ref.iri;
}

/**
 * Declares an owl:ObjectProperty. It never generates a paired inverse: declare one with
 * `inverseOf` if you want it.
 */
export function defobjectproperty(name: string, opts: DefObjectPropertyOptions = {}): ObjectPropertyRef {
  const b = requireCurrent();
  const iri = `${b.baseIri}${name}`;
  const subject = declareProperty(b, iri, OWL_OBJECT_PROPERTY, opts);
  if (opts.range) b.quads.push(quad(subject, namedNode(RDFS_RANGE), namedNode(opts.range.iri)));
  if (opts.inverseOf) b.quads.push(quad(subject, namedNode(`${OWL}inverseOf`), namedNode(objectPropertyIri(opts.inverseOf, 'inverseOf'))));
  if (opts.chain) {
    if (opts.chain.length < 2) throw new Error(`${name}: a property chain needs at least two properties.`);
    const links = opts.chain.map((p) => namedNode(objectPropertyIri(p, 'chain')));
    b.quads.push(quad(subject, namedNode(`${OWL}propertyChainAxiom`), rdfList(links, b.quads)));
  }
  return { kind: 'objectProperty', iri, localName: name };
}

export function defdatatypeproperty(name: string, opts: DefDatatypePropertyOptions = {}): DatatypePropertyRef {
  const b = requireCurrent();
  for (const characteristic of opts.characteristics ?? []) {
    if (characteristic !== 'functional') throw new Error(`${name}: a datatype property can only be functional, not ${characteristic}.`);
  }
  const iri = `${b.baseIri}${name}`;
  const subject = declareProperty(b, iri, OWL_DATATYPE_PROPERTY, opts);
  if (opts.range) b.quads.push(quad(subject, namedNode(RDFS_RANGE), datatypeNode(b, opts.range)));
  return { kind: 'datatypeProperty', iri, localName: name };
}

// ---------------------------------------------------------------------------
// Datatypes, after Owlready2's ConstrainedDatatype
// ---------------------------------------------------------------------------

/** OWL 2's facets for restricting a datatype. Bounds take a number, or a string for a date, say. */
export interface DatatypeFacets {
  minInclusive?: number | string;
  maxInclusive?: number | string;
  minExclusive?: number | string;
  maxExclusive?: number | string;
  length?: number;
  minLength?: number;
  maxLength?: number;
  totalDigits?: number;
  fractionDigits?: number;
  pattern?: string;
}

export interface DatatypeRef {
  kind: 'datatype';
  iri: string;
  facets: DatatypeFacets;
}

const BOUND_FACETS = new Set(['minInclusive', 'maxInclusive', 'minExclusive', 'maxExclusive']);
const COUNT_FACETS = new Set(['length', 'minLength', 'maxLength', 'totalDigits', 'fractionDigits']);

/**
 * A datatype for a datatype property's range: a name (`'xsd:integer'`, or a full IRI), and
 * optionally facets that restrict it, after Owlready2's ConstrainedDatatype. With facets the range
 * is an rdfs:Datatype on the named one, with owl:withRestrictions.
 *
 *   defdatatypeproperty('age', { range: datatype('xsd:integer', { minInclusive: 0, maxInclusive: 150 }) });
 */
export function datatype(name: string, facets: DatatypeFacets = {}): DatatypeRef {
  const b = requireCurrent();
  for (const [facet, value] of Object.entries(facets)) {
    if (value === undefined) continue;
    if (BOUND_FACETS.has(facet)) {
      if (typeof value !== 'string' && !(typeof value === 'number' && Number.isFinite(value))) throw new Error(`datatype: ${facet} takes a number or a string.`);
    } else if (COUNT_FACETS.has(facet)) {
      if (!Number.isInteger(value) || (value as number) < 0) throw new Error(`datatype: ${facet} takes a whole number, 0 or more.`);
    } else if (facet === 'pattern') {
      if (typeof value !== 'string') throw new Error('datatype: pattern takes a regular expression, as a string.');
    } else {
      throw new Error(`datatype: "${facet}" is not a facet.`);
    }
  }
  return { kind: 'datatype', iri: resolveIri(b, name), facets };
}

function datatypeNode(b: OntologyBuilder, range: DatatypeRef): NamedNode | BlankNode {
  const facets = Object.entries(range.facets).filter(([, value]) => value !== undefined);
  if (facets.length === 0) return namedNode(range.iri);
  const restricted = blankNode();
  b.quads.push(quad(restricted, namedNode(RDF_TYPE), namedNode(`${RDFS}Datatype`)));
  b.quads.push(quad(restricted, namedNode(`${OWL}onDatatype`), namedNode(range.iri)));
  const restrictions = facets.map(([facet, value]) => {
    const node = blankNode();
    // A bound is a value of the datatype it bounds; a count is a nonNegativeInteger; a pattern a string.
    const datatypeOfValue = BOUND_FACETS.has(facet) ? range.iri : COUNT_FACETS.has(facet) ? `${XSD}nonNegativeInteger` : XSD_STRING;
    b.quads.push(quad(node, namedNode(`${XSD}${facet}`), literal(String(value), namedNode(datatypeOfValue))));
    return node;
  });
  b.quads.push(quad(restricted, namedNode(`${OWL}withRestrictions`), rdfList(restrictions, b.quads)));
  return restricted;
}

// ---------------------------------------------------------------------------
// Individuals, after Owlready2's and Tawny-OWL's
// ---------------------------------------------------------------------------

/** A property assertion: an individual for an object property, a literal for a datatype property. */
export type Fact = readonly [property: ObjectPropertyRef, value: IndividualRef] | readonly [property: DatatypePropertyRef, value: LiteralValue];

export interface DefIndividualOptions extends Annotated {
  /** Classes or class expressions it is a member of: one rdf:type each. */
  types?: (ClassRef | ClassExpr)[];
  facts?: Fact[];
  sameAs?: IndividualRef[];
  differentFrom?: IndividualRef[];
}

/**
 * Declares an owl:NamedIndividual, after Owlready2's `Drug(price = 25.0)` and Tawny-OWL's
 * defindividual:
 *
 *   const rex = defindividual('rex', { types: [Dog], facts: [[hasOwner, alice], [age, 3]] });
 */
export function defindividual(name: string, opts: DefIndividualOptions = {}): IndividualRef {
  const b = requireCurrent();
  const iri = `${b.baseIri}${name}`;
  const subject = namedNode(iri);
  b.quads.push(quad(subject, namedNode(RDF_TYPE), namedNode(`${OWL}NamedIndividual`)));
  b.quads.push(...annotations(b, subject, opts));
  for (const type of opts.types ?? []) b.quads.push(quad(subject, namedNode(RDF_TYPE), toClassExprNode(b, type)));
  for (const [property, value] of opts.facts ?? []) b.quads.push(quad(subject, namedNode(property.iri), factObject(b, name, property, value)));
  for (const other of opts.sameAs ?? []) b.quads.push(quad(subject, namedNode(`${OWL}sameAs`), namedNode(other.iri)));
  for (const other of opts.differentFrom ?? []) b.quads.push(quad(subject, namedNode(`${OWL}differentFrom`), namedNode(other.iri)));
  return { kind: 'individual', iri, localName: name };
}

/** A fact's object, checked against its property's kind for scripts the type checker didn't see. */
function factObject(b: OntologyBuilder, subjectName: string, property: PropertyRef, value: IndividualRef | LiteralValue): Quad_Object {
  const ref = typeof value === 'object' && 'localName' in value ? (value as Ref) : undefined;
  if (property.kind === 'objectProperty') {
    if (ref?.kind !== 'individual') throw new Error(`${subjectName}: ${property.localName} is an object property, so its value must be an individual.`);
    return namedNode(ref.iri);
  }
  if (ref) throw new Error(`${subjectName}: ${property.localName} is a datatype property, so its value must be a literal.`);
  return literalTerm(b, value as LiteralValue);
}

/**
 * Every pair of `individuals` owl:differentFrom each other. Written pairwise, the form the
 * extension's reasoner reads, as asSubclasses writes disjointness.
 */
export function allDifferent(...individuals: IndividualRef[]): void {
  const b = requireCurrent();
  individuals.forEach((individual, i) => {
    for (const other of individuals.slice(i + 1)) b.quads.push(quad(namedNode(individual.iri), namedNode(`${OWL}differentFrom`), namedNode(other.iri)));
  });
}

// ---------------------------------------------------------------------------
// References to terms declared elsewhere
// ---------------------------------------------------------------------------

/** The IRI and local name of a term named in a script: a bare name is in this ontology. */
function named(name: string): { iri: string; localName: string } {
  const iri = resolveName(requireCurrent(), name);
  return { iri, localName: iri.replace(/^.*[#/:]/, '') };
}

/**
 * A class declared elsewhere -- in an imported ontology (`classRef('gist:Person')`), or later in
 * this script (`classRef('Keeper')`). Writes nothing. The same goes for the three below.
 */
export function classRef(name: string): ClassRef {
  return { kind: 'class', ...named(name) };
}

export function objectPropertyRef(name: string): ObjectPropertyRef {
  return { kind: 'objectProperty', ...named(name) };
}

export function datatypePropertyRef(name: string): DatatypePropertyRef {
  return { kind: 'datatypeProperty', ...named(name) };
}

export function individualRef(name: string): IndividualRef {
  return { kind: 'individual', ...named(name) };
}

// ---------------------------------------------------------------------------
// Class-expression restriction builders -- return the same ClassExpr AST
// rdf/formats/classExpression.ts's Manchester parser produces, so
// classExprToRdf (called from defclass above) handles all of these for
// free. A script can freely mix these with ClassRef values returned by
// defclass/defobjectproperty (toClassExprNode normalizes a bare ClassRef
// into `{ kind: 'class', iri }` automatically).
// ---------------------------------------------------------------------------

/** The inverse of an object property, made by inverse(). */
export interface InverseProperty {
  kind: 'inverse';
  of: ObjectPropertyRef;
}

/** What a restriction can be on: a property, or the inverse of an object property. */
export type PropertyExpression = PropertyRef | InverseProperty;

/**
 * The inverse of an object property, for a restriction: `some(inverse(hasPart), Car)` is "part
 * of some car", with no named inverse property to declare and keep in step. That is gist's
 * convention, and what Local Checks' MDL-001 suggests in place of a named inverse.
 */
export function inverse(property: ObjectPropertyRef): InverseProperty {
  if (property.kind !== 'objectProperty') throw new Error(`inverse: ${(property as Ref).localName} is not an object property; only an object property has an inverse.`);
  return { kind: 'inverse', of: property };
}

/** A restriction's property fields for `p`. */
function onProperty(p: PropertyExpression): { property: string; inverse?: boolean } {
  return p.kind === 'inverse' ? { property: p.of.iri, inverse: true } : { property: p.iri };
}

function exprOf(x: ClassRef | ClassExpr): ClassExpr {
  return 'localName' in x ? { kind: 'class', iri: x.iri } : x;
}

export function some(property: PropertyExpression, filler: ClassRef | ClassExpr): ClassExpr {
  return { kind: 'restriction', ...onProperty(property), type: 'some', filler: exprOf(filler) };
}

export function only(property: PropertyExpression, filler: ClassRef | ClassExpr): ClassExpr {
  return { kind: 'restriction', ...onProperty(property), type: 'only', filler: exprOf(filler) };
}

/** `property value` an individual or a literal. A class reference stands for the individual with its IRI. */
export function hasValue(property: PropertyExpression, value: IndividualRef | ClassRef | LiteralValue): ClassExpr {
  if (typeof value === 'object' && 'localName' in value) {
    return { kind: 'restriction', ...onProperty(property), type: 'value', individual: value.iri };
  }
  return { kind: 'restriction', ...onProperty(property), type: 'value', literalValue: literalParts(requireCurrent(), value) };
}

export function minCardinality(property: PropertyExpression, n: number, filler?: ClassRef | ClassExpr): ClassExpr {
  return { kind: 'restriction', ...onProperty(property), type: 'min', cardinality: n, filler: filler ? exprOf(filler) : undefined };
}

export function maxCardinality(property: PropertyExpression, n: number, filler?: ClassRef | ClassExpr): ClassExpr {
  return { kind: 'restriction', ...onProperty(property), type: 'max', cardinality: n, filler: filler ? exprOf(filler) : undefined };
}

export function exactCardinality(property: PropertyExpression, n: number, filler?: ClassRef | ClassExpr): ClassExpr {
  return { kind: 'restriction', ...onProperty(property), type: 'exactly', cardinality: n, filler: filler ? exprOf(filler) : undefined };
}

export function and(...operands: (ClassRef | ClassExpr)[]): ClassExpr {
  return { kind: 'and', operands: operands.map(exprOf) };
}

export function or(...operands: (ClassRef | ClassExpr)[]): ClassExpr {
  return { kind: 'or', operands: operands.map(exprOf) };
}

export function not(operand: ClassRef | ClassExpr): ClassExpr {
  return { kind: 'not', operand: exprOf(operand) };
}

// ---------------------------------------------------------------------------
// Manchester Syntax, as a tagged template
// ---------------------------------------------------------------------------

/** What a `${...}` inside mx can hold. */
export type MxValue = Ref | InverseProperty | ClassExpr | string | number | boolean;

const MX_NESTED = 'urn:x-ontology-suite-mx:';

/**
 * A class expression written in Manchester Syntax, usable wherever a builder's result is:
 *
 *   defclass('OwnedAnimal', { subClassOf: [Animal, mx`${hasOwner} some ${Person}`] });
 *
 * Interpolate this script's classes and properties (`${Person}`) to keep their type checks and
 * renames. A name written in the text is resolved when the script runs: a bare name against the
 * base IRI, a CURIE over ontology()'s prefixes. An interpolated string, boolean or number is a
 * literal -- a whole number 0 or more also serves as a cardinality -- and a class expression
 * stands where a class would. The text must be exactly one expression; the editor marks a syntax
 * error in it as you type.
 */
export function mx(strings: TemplateStringsArray, ...values: MxValue[]): ClassExpr {
  const b = requireCurrent();
  const nested: ClassExpr[] = [];
  const refs = new Map<string, Ref>();
  let text = strings[0];
  values.forEach((value, i) => {
    text += mxToken(value, nested, refs) + strings[i + 1];
  });
  let expr: ClassExpr;
  try {
    expr = parseClassExpressionStrict(text);
  } catch (err) {
    if (err instanceof ClassExpressionSyntaxError) throw new Error(`mx: ${err.message}\n  ${text}\n  ${' '.repeat(err.offset)}^`);
    throw err;
  }
  return resolveMx(b, expr, nested, refs);
}

/** The Manchester text an interpolated value stands for. */
function mxToken(value: MxValue, nested: ClassExpr[], refs: Map<string, Ref>): string {
  // A whole number 0 or more is written bare, so it reads as a cardinality or, after `value`, as
  // an xsd:integer; any other number, and a boolean, as a typed literal.
  if (typeof value === 'number' || typeof value === 'boolean') {
    if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && !/e/i.test(String(value))) return String(value);
    const parts = literalParts(requireCurrent(), value);
    return `"${parts.value}"^^<${parts.datatype}>`;
  }
  if (typeof value === 'string') return `"${value.replace(/["\\]/g, '\\$&')}"`;
  if (value.kind === 'inverse') {
    refs.set(value.of.iri, value.of);
    return `inverse <${value.of.iri}>`;
  }
  if ('localName' in value) {
    refs.set(value.iri, value);
    return `<${value.iri}>`;
  }
  nested.push(value);
  return `<${MX_NESTED}${nested.length - 1}>`;
}

/** Resolves every name in a parsed mx expression, and checks each interpolated class or property is used as one. */
function resolveMx(b: OntologyBuilder, expr: ClassExpr, nested: ClassExpr[], refs: Map<string, Ref>): ClassExpr {
  const isNested = (iri: string) => iri.startsWith(MX_NESTED);
  const what = { class: 'a class', objectProperty: 'a property', datatypeProperty: 'a property', individual: 'an individual' } as const;
  // An interpolated term used as something else: a class as a property, say.
  const check = (iri: string, usedAs: 'a class' | 'a property' | 'an individual', allowed: Ref['kind'][]) => {
    if (isNested(iri)) throw new Error(`mx: a class expression is used here as ${usedAs}.`);
    const ref = refs.get(iri);
    if (ref && !allowed.includes(ref.kind)) throw new Error(`mx: ${ref.localName} is ${what[ref.kind]}, used here as ${usedAs}.`);
  };
  return mapClassExprNames(expr, {
    class: (iri) => {
      if (isNested(iri)) return nested[Number(iri.slice(MX_NESTED.length))];
      check(iri, 'a class', ['class']);
      return { kind: 'class', iri: resolveName(b, iri) };
    },
    property: (iri) => {
      check(iri, 'a property', ['objectProperty', 'datatypeProperty']);
      return resolveName(b, iri);
    },
    individual: (iri) => {
      // A class reference stands for the individual with its IRI, as hasValue allows.
      check(iri, 'an individual', ['individual', 'class']);
      return resolveName(b, iri);
    },
    datatype: (iri) => resolveName(b, iri),
  });
}

// ---------------------------------------------------------------------------
// Patterns, after Tawny-OWL's
// ---------------------------------------------------------------------------

/**
 * Tawny-OWL's some-only, a closure axiom: `property some` each filler, and `property only` their
 * union -- at least one of each, and nothing else. Spread it into subClassOf:
 *
 *   defclass('MargheritaPizza', { subClassOf: [Pizza, ...someOnly(hasTopping, Mozzarella, Tomato)] });
 */
export function someOnly(property: PropertyExpression, ...fillers: (ClassRef | ClassExpr)[]): ClassExpr[] {
  if (fillers.length === 0) throw new Error('someOnly() needs at least one filler.');
  return [...fillers.map((filler) => some(property, filler)), only(property, fillers.length === 1 ? fillers[0] : or(...fillers))];
}

export interface AsSubclassesOptions {
  /** Every child owl:disjointWith every other. Written pairwise, the form the extension's reasoner checks (REA-DISJOINT), not as owl:AllDisjointClasses. */
  disjoint?: boolean;
  /** The covering axiom: the parent is a subclass of the children's union, so each of its members is in one of them. */
  cover?: boolean;
}

/**
 * Tawny-OWL's as-subclasses: makes each child a subclass of `parent`, and optionally the children
 * pairwise disjoint and covering it. Returns the children, so it can wrap their declarations:
 *
 *   const [Mammal, Bird] = asSubclasses(Animal, [defclass('Mammal'), defclass('Bird')], { disjoint: true, cover: true });
 */
export function asSubclasses(parent: ClassRef, children: ClassRef[], opts: AsSubclassesOptions = {}): ClassRef[] {
  const b = requireCurrent();
  for (const child of children) b.quads.push(quad(namedNode(child.iri), namedNode(RDFS_SUBCLASS_OF), namedNode(parent.iri)));
  if (opts.disjoint) {
    children.forEach((child, i) => {
      for (const other of children.slice(i + 1)) b.quads.push(quad(namedNode(child.iri), namedNode(OWL_DISJOINT_WITH), namedNode(other.iri)));
    });
  }
  if (opts.cover && children.length > 0) {
    b.quads.push(quad(namedNode(parent.iri), namedNode(RDFS_SUBCLASS_OF), toClassExprNode(b, children.length === 1 ? children[0] : or(...children))));
  }
  return children;
}

/**
 * Called once, at the end of the script, to hand the built model back to the runner (see
 * scriptRunnerEntry.ts). A triple stated twice -- a child given its parent both by defclass and
 * by asSubclasses, say -- is written once; one with a blank node is always kept, since two
 * restrictions alike are still two nodes.
 */
export function build(): { quads: Quad[]; prefixes: Record<string, string> } {
  const b = requireCurrent();
  const seen = new Set<string>();
  const quads = [...b.header, ...b.quads].filter((q) => {
    if (q.subject.termType === 'BlankNode' || q.object.termType === 'BlankNode') return true;
    const o = q.object;
    const key = JSON.stringify([q.subject.value, q.predicate.value, o.termType, o.value, o.termType === 'Literal' ? [o.language, o.datatype.value] : null]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { quads, prefixes: b.prefixes };
}
