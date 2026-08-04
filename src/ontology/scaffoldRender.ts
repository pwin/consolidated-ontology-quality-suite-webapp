import { DataFactory, Quad, Literal } from 'n3';
import { shrink, WELL_KNOWN_PREFIXES } from '../rdf/vocab';
import { serializeRdf } from '../rdf/serialization';
import { ClassExpr, classExprToRdf } from '../rdf/formats/classExpression';

/**
 * Pure Turtle-fragment rendering for the Ontology Outline's scaffold
 * commands -- no `vscode` import, unlike scaffold.ts itself, so these are
 * unit-testable directly (matching the same split checks/projectStandards
 * .ts/projectStandardsCore.ts and checks/classRules.ts already use: a
 * module that imports `vscode` at the top can't be loaded by vitest at all
 * outside a real extension host, even to exercise a function inside it that
 * never itself touches the vscode API).
 */

const { namedNode, quad, literal } = DataFactory;
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
const RDFS_SUBCLASS_OF = 'http://www.w3.org/2000/01/rdf-schema#subClassOf';
const RDFS_SUBPROPERTY_OF = 'http://www.w3.org/2000/01/rdf-schema#subPropertyOf';
const OWL_CLASS = 'http://www.w3.org/2002/07/owl#Class';
const XSD_STRING = 'http://www.w3.org/2001/XMLSchema#string';

export interface AddClassOptions {
  className: string;
  label: string;
  asCategory: boolean;
  prefix: string;
}

export function renderAddClassTurtle(opts: AddClassOptions): string {
  if (opts.asCategory) {
    return ['', `${opts.prefix}:${opts.className}`, '  a gist:Category ;', `  rdfs:label "${opts.label}"^^xsd:string ;`, '  .', ''].join('\n');
  }
  return ['', `${opts.prefix}:${opts.className}`, '  a owl:Class ;', `  rdfs:label "${opts.label}"^^xsd:string ;`, '  .', ''].join('\n');
}

export interface AddPropertyOptions {
  propertyName: string;
  label: string;
  kind: 'ObjectProperty' | 'DatatypeProperty' | 'AnnotationProperty';
  domain?: string;
  range?: string;
  prefix: string;
}

export function renderAddPropertyTurtle(opts: AddPropertyOptions): string {
  const lines = ['', `${opts.prefix}:${opts.propertyName}`, `  a owl:${opts.kind} ;`, `  rdfs:label "${opts.label}"^^xsd:string ;`];
  if (opts.domain) lines.push(`  rdfs:domain ${opts.domain} ;`);
  if (opts.range) lines.push(`  rdfs:range ${opts.range} ;`);
  lines[lines.length - 1] = lines[lines.length - 1].replace(/;\s*$/, '.');
  lines.push('');
  return lines.join('\n');
}

export interface AddClassWithParentsOptions {
  className: string;
  label: string;
  prefix: string;
  /** Named (rdfs:subClassOf) parents -- one for "Add Subclass", the clicked sibling's own parents for "Add Sibling Class". Empty means top-level. */
  parentIris: string[];
  /** An optional additional rdfs:subClassOf restriction (owl:Restriction/intersectionOf/etc.), authored as a Manchester expression and parsed via classExpression.ts -- the same parser/AST `.omn` files use. */
  restrictionExpr?: ClassExpr;
}

/**
 * Builds the new class's triples as real RDF (not hand-formatted strings,
 * unlike renderAddClassTurtle above) so the optional restriction's blank-node
 * structure round-trips through the same N3 Writer the rest of this
 * extension already relies on for correctness, then strips the writer's own
 * `@prefix` lines before returning -- those prefixes already exist earlier
 * in the target file; only the new statements should be appended.
 */
export async function renderAddClassWithParentsTurtle(opts: AddClassWithParentsOptions, documentPrefixes: Record<string, string>): Promise<string> {
  // See renderAddSubPropertyTurtle's comment: falls back to rdf:/rdfs:/owl:/xsd: even if the
  // target file never explicitly declares them.
  const prefixes = { ...WELL_KNOWN_PREFIXES, ...documentPrefixes };
  const ns = prefixes[opts.prefix];
  const classIri = ns ? `${ns}${opts.className}` : `${opts.prefix}:${opts.className}`;
  const subject = namedNode(classIri);

  const quads: Quad[] = [
    quad(subject, namedNode(RDF_TYPE), namedNode(OWL_CLASS)),
    quad(subject, namedNode(RDFS_LABEL), literal(opts.label, namedNode(XSD_STRING))),
  ];
  for (const parentIri of opts.parentIris) {
    quads.push(quad(subject, namedNode(RDFS_SUBCLASS_OF), namedNode(parentIri)));
  }
  if (opts.restrictionExpr) {
    const restrictionNode = classExprToRdf(opts.restrictionExpr, prefixes, quads);
    quads.push(quad(subject, namedNode(RDFS_SUBCLASS_OF), restrictionNode));
  }

  const turtle = await serializeRdf(quads, 'turtle', prefixes);
  return `\n${stripPrefixLines(turtle)}\n`;
}

export interface AddSubPropertyOptions {
  propertyName: string;
  label: string;
  kind: 'ObjectProperty' | 'DatatypeProperty';
  prefix: string;
  parentIri: string;
}

export function renderAddSubPropertyTurtle(opts: AddSubPropertyOptions, documentPrefixes: Record<string, string>): string {
  // Falls back to rdf:/rdfs:/owl:/xsd: even if the target file never explicitly declares them
  // (common -- e.g. `a` is Turtle's built-in rdf:type shorthand, so plenty of real files never
  // bother with an explicit `@prefix rdf:` line at all) -- confirmed by a real test failure:
  // without this, `shrink()` on an undeclared prefix silently falls back to the full, ugly IRI
  // instead of a CURIE.
  const prefixes = { ...WELL_KNOWN_PREFIXES, ...documentPrefixes };
  const ns = prefixes[opts.prefix];
  const propertyIri = ns ? `${ns}${opts.propertyName}` : `${opts.prefix}:${opts.propertyName}`;
  const subject = namedNode(propertyIri);
  const quads = [
    quad(subject, namedNode(RDF_TYPE), namedNode(`http://www.w3.org/2002/07/owl#${opts.kind}`)),
    quad(subject, namedNode(RDFS_LABEL), literal(opts.label, namedNode(XSD_STRING))),
    quad(subject, namedNode(RDFS_SUBPROPERTY_OF), namedNode(opts.parentIri)),
  ];
  // Rendered synchronously via the same shrink-based CURIE style as renderAddPropertyTurtle
  // (no restriction machinery needed here, so the async serializeRdf round-trip isn't worth it).
  // rdf:type specifically uses Turtle's built-in `a` shorthand, which needs no prefix at all.
  const lines = quads.map((q) => `  ${q.predicate.value === RDF_TYPE ? 'a' : shrink(q.predicate.value, prefixes)} ${renderObjectCurie(q, prefixes)} ;`);
  lines[lines.length - 1] = lines[lines.length - 1].replace(/;\s*$/, '.');
  return ['', shrink(propertyIri, prefixes), ...lines, ''].join('\n');
}

function renderObjectCurie(q: Quad, prefixes: Record<string, string>): string {
  if (q.object.termType === 'Literal') {
    const lit = q.object as Literal;
    return `"${lit.value}"^^${shrink(lit.datatype.value, prefixes)}`;
  }
  return shrink(q.object.value, prefixes);
}

function stripPrefixLines(turtle: string): string {
  return turtle
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('@prefix'))
    .join('\n')
    .replace(/^\n+/, '');
}

export function humanize(s: string): string {
  return s.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());
}
