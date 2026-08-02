import { DataFactory, Quad } from 'n3';
import { buildOntologyModel } from '../ontologyModel';
import { expand, shrink, OWL, RDF, RDFS, SKOS } from '../vocab';
import { classExprToRdf, parseClassExpression, rdfToClassExpr, renderClassExpression } from './classExpression';
import type { ParseResult } from './types';

const { namedNode, literal, quad } = DataFactory;

/**
 * OWL2 Manchester Syntax has no npm package on the whole registry (checked:
 * owl-manchester, manchester-syntax, owl2-manchester, @zazuko/rdf-diagnostic
 * -- none exist). Unlike the other five formats, Manchester Syntax is an
 * *axiom*-level OWL ontology syntax, not a general triple serialization --
 * it has no way to express arbitrary RDF the way Turtle/RDF-XML/N-Triples
 * do, so `FORMATS.manchester.losslessGraph` is `false`: anything outside
 * frame declarations, annotations (label/comment/definition), domain/range,
 * sub-class-of/sub-property-of, equivalence, and class expressions
 * (`and`/`or`/`not`/`some`/`only`/`value`/`Self`/cardinality restrictions,
 * via `classExpression.ts`) is dropped on a Turtle -> Manchester -> Turtle
 * round-trip -- e.g. arbitrary non-OWL annotation properties, property
 * characteristics (Functional/Transitive/...), or property chains.
 */

const ANNOTATION_PROPERTY_IRIS: Record<string, string> = {
  label: `${RDFS}label`,
  comment: `${RDFS}comment`,
  'rdfs:label': `${RDFS}label`,
  'rdfs:comment': `${RDFS}comment`,
  'skos:definition': `${SKOS}definition`,
};

const FRAME_KEYWORDS = ['Class', 'ObjectProperty', 'DataProperty', 'AnnotationProperty', 'Individual'] as const;
type FrameKeyword = (typeof FRAME_KEYWORDS)[number];

const FRAME_TYPE_IRI: Record<FrameKeyword, string | null> = {
  Class: `${OWL}Class`,
  ObjectProperty: `${OWL}ObjectProperty`,
  DataProperty: `${OWL}DatatypeProperty`,
  AnnotationProperty: `${OWL}AnnotationProperty`,
  Individual: null, // Individual's type comes from its `Types:` section, not a fixed IRI.
};

const CLASS_EXPRESSION_SECTIONS = new Set(['SubClassOf', 'EquivalentTo', 'Domain', 'Range', 'Types']);

export function parseManchester(text: string): ParseResult {
  const prefixes: Record<string, string> = {};
  const errors: ParseResult['errors'] = [];
  const quads: Quad[] = [];
  const lines = text.split(/\r?\n/);

  let currentSubject: string | null = null;

  const resolve = (ref: string): string | null => {
    const trimmed = ref.trim();
    if (trimmed.startsWith('<') && trimmed.endsWith('>')) return trimmed.slice(1, -1);
    const iri = expand(trimmed, prefixes);
    if (!iri) errors.push({ message: `Could not resolve '${trimmed}' against known Prefix: declarations.`, line: 0 });
    return iri;
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;

    const prefixMatch = /^Prefix:\s*([\w-]*)\s*:\s*<([^>]+)>/.exec(line);
    if (prefixMatch) {
      prefixes[prefixMatch[1]] = prefixMatch[2];
      continue;
    }
    if (/^Ontology:/.test(line)) continue; // informational only, no downstream consumer needs it from this path yet

    const frameMatch = new RegExp(`^(${FRAME_KEYWORDS.join('|')}):\\s*(.+)$`).exec(line);
    if (frameMatch) {
      const [, keyword, ref] = frameMatch;
      const iri = resolve(ref);
      if (!iri) continue;
      currentSubject = iri;
      const typeIri = FRAME_TYPE_IRI[keyword as FrameKeyword];
      if (typeIri) quads.push(quad(namedNode(iri), namedNode(`${RDF}type`), namedNode(typeIri)));
      continue;
    }

    if (!currentSubject) {
      errors.push({ message: `'${line}' appears outside any Class:/ObjectProperty:/.../Individual: frame.`, line: i });
      continue;
    }

    const bodyMatch = /^(SubClassOf|SubPropertyOf|Domain|Range|EquivalentTo|Types|Annotations):\s*(.+)$/.exec(line);
    if (!bodyMatch) {
      errors.push({ message: `Unsupported Manchester Syntax line: '${line}'`, line: i });
      continue;
    }
    const [, section, rest] = bodyMatch;

    if (section === 'Annotations') {
      for (const part of splitTopLevelCommas(rest)) {
        const annotationMatch = /^([\w:-]+)\s+"((?:[^"\\]|\\.)*)"/.exec(part.trim());
        if (!annotationMatch) {
          errors.push({ message: `Could not parse annotation '${part.trim()}'.`, line: i });
          continue;
        }
        const [, propRef, value] = annotationMatch;
        const propIri = ANNOTATION_PROPERTY_IRIS[propRef] ?? resolve(propRef);
        if (!propIri) continue;
        quads.push(quad(namedNode(currentSubject), namedNode(propIri), literal(unescapeManchesterString(value))));
      }
      continue;
    }

    if (section === 'SubPropertyOf') {
      for (const ref of splitTopLevelCommas(rest)) {
        const target = resolve(ref);
        if (target) quads.push(quad(namedNode(currentSubject), namedNode(`${RDFS}subPropertyOf`), namedNode(target)));
      }
      continue;
    }

    if (CLASS_EXPRESSION_SECTIONS.has(section)) {
      const predicateIri =
        section === 'SubClassOf' ? `${RDFS}subClassOf` :
        section === 'EquivalentTo' ? `${OWL}equivalentClass` :
        section === 'Domain' ? `${RDFS}domain` :
        section === 'Range' ? `${RDFS}range` :
        `${RDF}type`; // 'Types'

      for (const part of splitTopLevelCommas(rest)) {
        let expr;
        try {
          expr = parseClassExpression(part.trim());
        } catch (err) {
          errors.push({ message: `Could not parse class expression '${part.trim()}': ${err instanceof Error ? err.message : String(err)}`, line: i });
          continue;
        }
        if (!expr) continue;
        const nested: Quad[] = [];
        const target = classExprToRdf(expr, prefixes, nested);
        quads.push(quad(namedNode(currentSubject), namedNode(predicateIri), target as never));
        quads.push(...nested);
      }
    }
  }

  return { quads, prefixes, errors };
}

function splitTopLevelCommas(s: string): string[] {
  // Values/expressions may themselves contain commas inside quoted strings, {individual, lists},
  // or (parenthesized, expressions) -- a depth-aware split keeps those intact.
  const parts: string[] = [];
  let depth = 0;
  let inString = false;
  let current = '';
  for (const ch of s) {
    if (ch === '"') inString = !inString;
    if (!inString) {
      if (ch === '(' || ch === '{') depth++;
      if (ch === ')' || ch === '}') depth--;
    }
    if (ch === ',' && depth === 0 && !inString) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current);
  return parts;
}

function unescapeManchesterString(s: string): string {
  return s.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
}

export function serializeManchester(quads: Quad[], prefixes: Record<string, string> = {}): string {
  const model = buildOntologyModel(quads);
  const lines: string[] = [];

  const bySubject = new Map<string, Quad[]>();
  for (const q of quads) {
    const key = q.subject.value;
    if (!bySubject.has(key)) bySubject.set(key, []);
    bySubject.get(key)!.push(q);
  }

  for (const [prefix, iri] of Object.entries(prefixes)) {
    if (prefix) lines.push(`Prefix: ${prefix}: <${iri}>`);
  }
  if (model.ontologyIri) lines.push('', `Ontology: <${model.ontologyIri}>`);
  lines.push('');

  const ref = (iri: string) => {
    const curie = shrink(iri, prefixes);
    return curie === iri ? `<${iri}>` : curie;
  };
  /** Renders every object of `predicateIri` on `subjectIri` as a Manchester expression, walking blank-node structure via classExpression.ts's rdfToClassExpr. */
  const renderTargets = (subjectIri: string, predicateIri: string): string[] => {
    const objects = (bySubject.get(subjectIri) ?? []).filter((q) => q.predicate.value === predicateIri).map((q) => q.object);
    return objects
      .map((obj) => {
        const expr = rdfToClassExpr(obj as never, bySubject);
        return expr ? renderClassExpression(expr, prefixes) : null;
      })
      .filter((s): s is string => s !== null);
  };
  const annotationLine = (label: string | undefined, comment: string | undefined, definition: string | undefined): string[] => {
    const parts: string[] = [];
    if (label) parts.push(`rdfs:label "${escapeManchesterString(label)}"`);
    if (comment) parts.push(`rdfs:comment "${escapeManchesterString(comment)}"`);
    if (definition) parts.push(`skos:definition "${escapeManchesterString(definition)}"`);
    return parts.length > 0 ? [`    Annotations: ${parts.join(', ')}`] : [];
  };

  const emitFrame = (keyword: FrameKeyword, iri: string, extraLines: string[]) => {
    const term = model.terms.get(iri)!;
    lines.push(`${keyword}: ${ref(iri)}`);
    lines.push(...extraLines);
    lines.push(...annotationLine(term.label, term.comment, term.definition));
    lines.push('');
  };

  for (const term of model.terms.values()) {
    if (term.kinds.includes('class')) {
      const extra: string[] = [];
      const subClassOf = renderTargets(term.iri, `${RDFS}subClassOf`);
      if (subClassOf.length) extra.push(`    SubClassOf: ${subClassOf.join(', ')}`);
      const equivalentTo = renderTargets(term.iri, `${OWL}equivalentClass`);
      if (equivalentTo.length) extra.push(`    EquivalentTo: ${equivalentTo.join(', ')}`);
      emitFrame('Class', term.iri, extra);
    }
    if (term.kinds.includes('objectProperty') || term.kinds.includes('datatypeProperty')) {
      const keyword: FrameKeyword = term.kinds.includes('objectProperty') ? 'ObjectProperty' : 'DataProperty';
      const extra: string[] = [];
      if (term.subPropertyOf.length) extra.push(`    SubPropertyOf: ${term.subPropertyOf.map(ref).join(', ')}`);
      const domain = renderTargets(term.iri, `${RDFS}domain`);
      if (domain.length) extra.push(`    Domain: ${domain.join(', ')}`);
      const range = renderTargets(term.iri, `${RDFS}range`);
      if (range.length) extra.push(`    Range: ${range.join(', ')}`);
      emitFrame(keyword, term.iri, extra);
    }
    if (term.kinds.includes('annotationProperty')) {
      emitFrame('AnnotationProperty', term.iri, []);
    }
    if (term.kinds.includes('individual')) {
      const typeTerms = quads.filter((q) => q.subject.value === term.iri && q.predicate.value === `${RDF}type` && q.object.termType === 'NamedNode');
      const extra = typeTerms.length ? [`    Types: ${typeTerms.map((q) => ref(q.object.value)).join(', ')}`] : [];
      emitFrame('Individual', term.iri, extra);
    }
  }

  return lines.join('\n');
}

function escapeManchesterString(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
