import { DataFactory, Quad } from 'n3';
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
  XSD,
  WELL_KNOWN_PREFIXES,
} from '../rdf/vocab';
import { ClassExpr, classExprToRdf } from '../rdf/formats/classExpression';

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
  quads: Quad[];
  prefixes: Record<string, string>;
}

let current: OntologyBuilder | undefined;

/** Must be called once, before any defclass/defobjectproperty/defdatatypeproperty call. */
export function ontology(baseIri: string, prefix: string, extraPrefixes: Record<string, string> = {}): void {
  current = { baseIri, prefix, quads: [], prefixes: { ...WELL_KNOWN_PREFIXES, [prefix]: baseIri, ...extraPrefixes } };
}

function requireCurrent(): OntologyBuilder {
  if (!current) throw new Error("Call ontology(baseIri, prefix) before defining any classes/properties.");
  return current;
}

function toClassExprNode(b: OntologyBuilder, x: ClassRef | ClassExpr) {
  const expr: ClassExpr = 'localName' in x ? { kind: 'class', iri: x.iri } : x;
  return classExprToRdf(expr, b.prefixes, b.quads);
}

export interface DefClassOptions {
  label?: string;
  comment?: string;
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
  if (opts.label) b.quads.push(quad(subject, namedNode(RDFS_LABEL), literal(opts.label, namedNode(XSD_STRING))));
  if (opts.comment) b.quads.push(quad(subject, namedNode(RDFS_COMMENT), literal(opts.comment, namedNode(XSD_STRING))));
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

export interface DefPropertyOptions {
  label?: string;
  comment?: string;
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
  if (opts.label) b.quads.push(quad(subject, namedNode(RDFS_LABEL), literal(opts.label, namedNode(XSD_STRING))));
  if (opts.comment) b.quads.push(quad(subject, namedNode(RDFS_COMMENT), literal(opts.comment, namedNode(XSD_STRING))));
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

/** Called once, at the end of the script, to hand the built model back to the runner (see scriptRunnerEntry.ts). */
export function build(): { quads: Quad[]; prefixes: Record<string, string> } {
  const b = requireCurrent();
  return { quads: b.quads, prefixes: b.prefixes };
}
