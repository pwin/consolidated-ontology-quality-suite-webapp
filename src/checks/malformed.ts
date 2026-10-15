import type { Quad, Term } from 'n3';
import type { ResultRow } from '../types';

/**
 * Three defects in how OWL is written down, reported as extension-only checks (MAL-*). Each is one
 * this extension's own earlier versions could leave in a file, which is why they live here rather
 * than in the shared registry: that is the Python suite's registry too (registryParity.test.ts),
 * and the Python suite never wrote them.
 *
 * - MAL-001: a qualified cardinality written with owl:cardinality (or min/max) beside owl:onClass.
 *   OWL 2 reads it as unqualified and ignores the class. `exactly n C` wrote it before 0.13.14.
 * - MAL-002: a restriction with more than one owl:onProperty: two restrictions merged into one
 *   node. Append and Add Subclass could leave it before 0.13.14, when new blank nodes reused
 *   labels already in the file.
 * - MAL-003: an IRI with no scheme, such as `<hasChild>`. No OWL tool reads a relative IRI as the
 *   term it was meant to name, and holosdb refuses a graph that has one, so Local Checks runs
 *   its engines without those triples (withoutRelativeIris). Add Subclass wrote a bare name this
 *   way before 0.14.0.
 */

const OWL = 'http://www.w3.org/2002/07/owl#';
const RDFS = 'http://www.w3.org/2000/01/rdf-schema#';

/** Unqualified cardinality, and the qualified property it should have been. */
const QUALIFIED = new Map([
  [`${OWL}cardinality`, 'qualifiedCardinality'],
  [`${OWL}minCardinality`, 'minQualifiedCardinality'],
  [`${OWL}maxCardinality`, 'maxQualifiedCardinality'],
]);

/** Whether `term` is an IRI with no scheme. */
function isRelativeIri(term: Term): boolean {
  return term.termType === 'NamedNode' && !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(term.value);
}

/** The quads with no relative IRI in them: what the SPARQL, SHACL and reasoning tiers can load. */
export function withoutRelativeIris(quads: Quad[]): Quad[] {
  return quads.filter((q) => !isRelativeIri(q.subject) && !isRelativeIri(q.predicate) && !isRelativeIri(q.object));
}

export function runMalformedChecks(quads: Quad[]): ResultRow[] {
  const bySubject = new Map<string, Quad[]>();
  for (const q of quads) {
    const key = `${q.subject.termType}:${q.subject.value}`;
    const statements = bySubject.get(key);
    if (statements) statements.push(q);
    else bySubject.set(key, [q]);
  }

  // A blank-node restriction has no line of its own to point at, so a finding about one goes to
  // the named class that uses it, where there is one.
  const owner = (node: Term): { focusNode: string; focusIsBlank: boolean } => {
    if (node.termType !== 'BlankNode') return { focusNode: node.value, focusIsBlank: false };
    const use = quads.find(
      (q) => q.object.equals(node) && q.subject.termType === 'NamedNode' && (q.predicate.value === `${RDFS}subClassOf` || q.predicate.value === `${OWL}equivalentClass`),
    );
    return use ? { focusNode: use.subject.value, focusIsBlank: false } : { focusNode: node.value, focusIsBlank: true };
  };
  const row = (checkId: string, title: string, at: { focusNode: string; focusIsBlank: boolean }, value: string, message: string, remediation: string): ResultRow => ({
    checkId,
    category: 'structural',
    title,
    severity: 'Violation',
    ...at,
    path: null,
    value,
    message,
    remediation,
    sources: ['structure'],
  });

  const rows: ResultRow[] = [];
  for (const statements of bySubject.values()) {
    const subject = statements[0].subject;
    const objectsOf = (predicate: string) => statements.filter((q) => q.predicate.value === predicate).map((q) => q.object);

    const onClass = [...objectsOf(`${OWL}onClass`), ...objectsOf(`${OWL}onDataRange`)];
    const unqualified = statements.find((q) => QUALIFIED.has(q.predicate.value));
    if (onClass.length > 0 && unqualified) {
      const property = objectsOf(`${OWL}onProperty`)[0]?.value ?? 'its property';
      const qualified = QUALIFIED.get(unqualified.predicate.value)!;
      const written = unqualified.predicate.value.slice(OWL.length);
      rows.push(
        row(
          'MAL-001',
          'Qualified cardinality written as unqualified',
          owner(subject),
          property,
          `A restriction on ${property} pairs owl:${written} with owl:onClass ${onClass[0].value}. OWL 2 reads it as an unqualified cardinality and ignores the class.`,
          `Write owl:${qualified} instead of owl:${written}. Versions of this extension before 0.13.14 wrote "exactly n C" this way.`,
        ),
      );
    }

    const properties = [...new Set(objectsOf(`${OWL}onProperty`).map((p) => p.value))];
    if (properties.length > 1) {
      rows.push(
        row(
          'MAL-002',
          'Restriction on more than one property',
          owner(subject),
          properties.join(', '),
          `One restriction has ${properties.length} owl:onProperty values (${properties.join(', ')}): two or more restrictions merged into one node.`,
          'Split it into one restriction per property. Versions of this extension before 0.13.14 could merge restrictions this way when Append or Add Subclass reused a blank-node label already in the file.',
        ),
      );
    }
  }

  // One finding per relative IRI, at the subject of the first statement that uses it -- which is
  // the relative IRI itself when it is the subject, as in `<Foo> a owl:Class`.
  const relative = new Map<string, Quad[]>();
  for (const q of quads) {
    for (const term of new Set([q.subject, q.predicate, q.object].filter(isRelativeIri).map((t) => t.value))) {
      const uses = relative.get(term);
      if (uses) uses.push(q);
      else relative.set(term, [q]);
    }
  }
  for (const [iri, uses] of relative) {
    rows.push(
      row(
        'MAL-003',
        'IRI with no scheme',
        owner(uses[0].subject),
        iri,
        `<${iri}> is a relative IRI: it has no scheme, so no OWL tool reads it as the term it was meant to name. Local Checks leaves out the ${uses.length} statement${uses.length === 1 ? '' : 's'} that use${uses.length === 1 ? 's' : ''} it.`,
        'Write it as a prefixed name or a full IRI. Versions of this extension before 0.14.0 wrote a bare name typed into Add Subclass this way; search the file for the regular expression <[^:>]+>.',
      ),
    );
  }
  return rows;
}
