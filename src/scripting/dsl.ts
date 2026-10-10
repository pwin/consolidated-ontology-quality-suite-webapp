import { DataFactory, NamedNode, Quad, Quad_Object } from 'n3';
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
  XSD,
  WELL_KNOWN_PREFIXES,
  resolveTermName,
} from '../rdf/vocab';
import { classExprToRdf } from '../rdf/formats/classExpression';
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

const { namedNode, literal, quad } = DataFactory;
const XSD_STRING = `${XSD}string`;

export interface ClassRef {
  kind: 'class';
  iri: string;
  localName: string;
}

export interface PropertyRef {
  kind: 'objectProperty' | 'datatypeProperty';
  iri: string;
  localName: string;
}

export type Ref = ClassRef | PropertyRef;

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

/** An annotation's value. A plain string is an xsd:string literal. */
export type AnnotationValue = string | { iri: string } | { value: string; language: string } | { value: string; datatype: string };

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
  if (typeof value === 'string') return literal(value, namedNode(XSD_STRING));
  if ('iri' in value) return namedNode(resolveIri(b, value.iri));
  if ('language' in value) return literal(value.value, value.language);
  return literal(value.value, namedNode(resolveIri(b, value.datatype)));
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

export interface DefPropertyOptions extends Annotated {
  domain?: ClassRef;
  range?: ClassRef;
  subPropertyOf?: PropertyRef;
}

function defproperty(kind: 'objectProperty' | 'datatypeProperty', name: string, opts: DefPropertyOptions): PropertyRef {
  const b = requireCurrent();
  const iri = `${b.baseIri}${name}`;
  const subject = namedNode(iri);
  const owlType = kind === 'objectProperty' ? OWL_OBJECT_PROPERTY : OWL_DATATYPE_PROPERTY;
  b.quads.push(quad(subject, namedNode(RDF_TYPE), namedNode(owlType)));
  b.quads.push(...annotations(b, subject, opts));
  if (opts.domain) b.quads.push(quad(subject, namedNode(RDFS_DOMAIN), namedNode(opts.domain.iri)));
  if (opts.range) b.quads.push(quad(subject, namedNode(RDFS_RANGE), namedNode(opts.range.iri)));
  if (opts.subPropertyOf) b.quads.push(quad(subject, namedNode(RDFS_SUBPROPERTY_OF), namedNode(opts.subPropertyOf.iri)));
  return { kind, iri, localName: name };
}

/**
 * Does not auto-generate a paired inverse property -- same MDL-001-informed
 * convention as ontology/scaffold.ts's promptAddProperty: gist itself only
 * ever scopes owl:inverseOf inline to one restriction, never as a second
 * top-level declared property.
 */
export function defobjectproperty(name: string, opts: DefPropertyOptions = {}): PropertyRef {
  return defproperty('objectProperty', name, opts);
}

export function defdatatypeproperty(name: string, opts: DefPropertyOptions = {}): PropertyRef {
  return defproperty('datatypeProperty', name, opts);
}

// ---------------------------------------------------------------------------
// Class-expression restriction builders -- return the same ClassExpr AST
// rdf/formats/classExpression.ts's Manchester parser produces, so
// classExprToRdf (called from defclass above) handles all of these for
// free. A script can freely mix these with ClassRef values returned by
// defclass/defobjectproperty (toClassExprNode normalizes a bare ClassRef
// into `{ kind: 'class', iri }` automatically).
// ---------------------------------------------------------------------------

function iriOf(x: Ref | ClassExpr): string {
  if ('localName' in x) return x.iri;
  if (x.kind === 'class') return x.iri;
  throw new Error('Expected a class/property reference or an atomic class expression here.');
}

function exprOf(x: ClassRef | ClassExpr): ClassExpr {
  return 'localName' in x ? { kind: 'class', iri: x.iri } : x;
}

export function some(property: PropertyRef, filler: ClassRef | ClassExpr): ClassExpr {
  return { kind: 'restriction', property: iriOf(property), type: 'some', filler: exprOf(filler) };
}

export function only(property: PropertyRef, filler: ClassRef | ClassExpr): ClassExpr {
  return { kind: 'restriction', property: iriOf(property), type: 'only', filler: exprOf(filler) };
}

export function hasValue(property: PropertyRef, individualOrLiteral: ClassRef | string): ClassExpr {
  if (typeof individualOrLiteral === 'string') {
    return { kind: 'restriction', property: iriOf(property), type: 'value', literalValue: { value: individualOrLiteral } };
  }
  return { kind: 'restriction', property: iriOf(property), type: 'value', individual: individualOrLiteral.iri };
}

export function minCardinality(property: PropertyRef, n: number, filler?: ClassRef | ClassExpr): ClassExpr {
  return { kind: 'restriction', property: iriOf(property), type: 'min', cardinality: n, filler: filler ? exprOf(filler) : undefined };
}

export function maxCardinality(property: PropertyRef, n: number, filler?: ClassRef | ClassExpr): ClassExpr {
  return { kind: 'restriction', property: iriOf(property), type: 'max', cardinality: n, filler: filler ? exprOf(filler) : undefined };
}

export function exactCardinality(property: PropertyRef, n: number, filler?: ClassRef | ClassExpr): ClassExpr {
  return { kind: 'restriction', property: iriOf(property), type: 'exactly', cardinality: n, filler: filler ? exprOf(filler) : undefined };
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
export type MxValue = Ref | ClassExpr | string | number;

const MX_NESTED = 'urn:x-ontology-suite-mx:';

/**
 * A class expression written in Manchester Syntax, usable wherever a builder's result is:
 *
 *   defclass('OwnedAnimal', { subClassOf: [Animal, mx`${hasOwner} some ${Person}`] });
 *
 * Interpolate this script's classes and properties (`${Person}`) to keep their type checks and
 * renames. A name written in the text is resolved when the script runs: a bare name against the
 * base IRI, a CURIE over ontology()'s prefixes. An interpolated string is a literal, a number a
 * cardinality, and a class expression stands where a class would. The text must be exactly one
 * expression; the editor marks a syntax error in it as you type.
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
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value < 0) throw new Error(`mx: ${value} is not a cardinality (a whole number, 0 or more).`);
    return String(value);
  }
  if (typeof value === 'string') return `"${value.replace(/["\\]/g, '\\$&')}"`;
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
  return mapClassExprNames(expr, {
    class: (iri) => {
      if (isNested(iri)) return nested[Number(iri.slice(MX_NESTED.length))];
      const ref = refs.get(iri);
      if (ref && ref.kind !== 'class') throw new Error(`mx: ${ref.localName} is a property, used here as a class.`);
      return { kind: 'class', iri: resolveName(b, iri) };
    },
    property: (iri) => {
      if (isNested(iri)) throw new Error('mx: a class expression is used here as a property.');
      const ref = refs.get(iri);
      if (ref && ref.kind === 'class') throw new Error(`mx: ${ref.localName} is a class, used here as a property.`);
      return resolveName(b, iri);
    },
    individual: (iri) => {
      if (isNested(iri)) throw new Error('mx: a class expression is used here as an individual.');
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
export function someOnly(property: PropertyRef, ...fillers: (ClassRef | ClassExpr)[]): ClassExpr[] {
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
