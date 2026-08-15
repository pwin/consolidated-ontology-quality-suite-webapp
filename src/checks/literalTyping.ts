import type { Quad } from 'n3';
import type { ResultRow } from '../types';

const XSD = 'http://www.w3.org/2001/XMLSchema#';

/**
 * Value-space validation for typed literals -- the half of `DAT-001` a lexical
 * pattern cannot express.
 *
 * The registry's two portable `DAT-001` formulations (`sparql/data/DAT-001.rq`
 * and the `sh:sparql` twin in `shapes/data.ttl`) test the *lexical form* with a
 * regex, which is all SPARQL can portably do. That catches `"twelve"^^xsd:integer`
 * but not `"2021-02-30"^^xsd:date`: February has no 30th, yet the string matches
 * `\d{4}-\d{2}-\d{2}` perfectly. Confirmed against this stack rather than assumed
 * -- the regex formulations flag the bad integer and the bad boolean and let the
 * impossible date through.
 *
 * The equivalent upstream (`consolidated_ontology_suite_python` 0.6.0's
 * `checks/literal_typing.py`) leans on rdflib's `Literal.ill_typed`. There is no
 * such thing here, so the value spaces are checked directly. Only datatypes with
 * an unambiguous, cheaply-decidable value space are covered; anything else is
 * left to the lexical checks rather than guessed at, since a false "invalid" on
 * real data is worse than a miss.
 *
 * Note one upstream finding that does *not* carry over: their `xsd:boolean`
 * branch was unreachable because rdflib's boolean converter never raises -- it
 * warns and yields `False`, so `"yes"^^xsd:boolean` was *stored* as `'false'`
 * and matched the regex. n3 stores the lexical form verbatim, so the portable
 * formulations already catch that case here and it is deliberately not repeated.
 */
export function runLiteralTypingChecks(quads: Quad[]): ResultRow[] {
  const rows: ResultRow[] = [];
  const seen = new Set<string>();

  for (const q of quads) {
    if (q.object.termType !== 'Literal') continue;
    const literal = q.object as import('n3').Literal;
    const datatype = literal.datatype?.value;
    if (!datatype || !datatype.startsWith(XSD)) continue;

    const reason = valueSpaceError(datatype.slice(XSD.length), literal.value);
    if (!reason) continue;

    const key = `${q.subject.value}|${q.predicate.value}|${literal.value}|${datatype}`;
    if (seen.has(key)) continue;
    seen.add(key);

    rows.push({
      checkId: 'DAT-001',
      category: 'data',
      title: 'Literal invalid for its declared datatype',
      severity: 'Violation',
      focusNode: q.subject.value,
      path: q.predicate.value,
      value: literal.value,
      message: `Literal "${literal.value}" is typed as ${datatype} but ${reason}.`,
      remediation: 'Correct the literal, or declare the datatype that actually matches its value.',
      sources: ['sparql'],
    });
  }
  return rows;
}

/** A human-readable reason the lexical form does not denote a value of `datatype`, or null if it does (or isn't checked). */
function valueSpaceError(datatype: string, lexical: string): string | null {
  switch (datatype) {
    case 'date':
    case 'dateTime':
      return dateError(datatype, lexical);
    case 'gMonth':
      return inRange(lexical, /^--(\d{2})/, 1, 12, 'month');
    case 'gDay':
      return inRange(lexical, /^---(\d{2})/, 1, 31, 'day');
    default:
      return null;
  }
}

/**
 * Checks a date/dateTime's calendar validity, not just its shape.
 *
 * `Date.UTC` normalises out-of-range components silently (month 13 rolls into
 * the next year), so the parsed value is compared back against the input
 * components: if they disagree, the date did not exist.
 */
function dateError(datatype: string, lexical: string): string | null {
  const match = /^(-?\d{4,})-(\d{2})-(\d{2})/.exec(lexical);
  // No match means the lexical form is malformed, which the regex-based
  // formulations already report -- not this module's job to double-report.
  if (!match) return null;

  const [, yearText, monthText, dayText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  if (month < 1 || month > 12) return `month ${month} does not exist`;

  const parsed = new Date(Date.UTC(year, month - 1, day));
  const rolled = parsed.getUTCMonth() + 1 !== month || parsed.getUTCDate() !== day;
  if (rolled) return `${yearText}-${monthText} has no day ${day}`;

  if (datatype === 'dateTime') {
    const time = /T(\d{2}):(\d{2}):(\d{2})/.exec(lexical);
    if (time) {
      const [, h, m, s] = time.map(Number) as unknown as [string, number, number, number];
      // 24:00:00 is legal in XSD and denotes midnight ending the day; 60 seconds
      // is a leap second, also legal. Only reject what neither allows.
      if (h > 24) return `hour ${h} does not exist`;
      if (m > 59) return `minute ${m} does not exist`;
      if (s > 60) return `second ${s} does not exist`;
    }
  }
  return null;
}

function inRange(lexical: string, pattern: RegExp, min: number, max: number, label: string): string | null {
  const match = pattern.exec(lexical);
  if (!match) return null;
  const n = Number(match[1]);
  return n < min || n > max ? `${label} ${n} does not exist` : null;
}
