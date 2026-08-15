import { describe, expect, it } from 'vitest';
import { parseTurtle } from '../rdf/parseDocument';
import { runLiteralTypingChecks } from './literalTyping';

const PREAMBLE = `
  @prefix ex: <http://example.org/demo#> .
  @prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
`;
const run = (body: string) => runLiteralTypingChecks(parseTurtle('file:///t.ttl', PREAMBLE + body).quads);
const focusNodes = (body: string) => run(body).map((r) => r.focusNode.replace(/.*#/, '')).sort();

describe('runLiteralTypingChecks', () => {
  it('flags a lexically well-formed but impossible date -- the gap the regex formulations cannot express', () => {
    expect(focusNodes('ex:a ex:when "2021-02-30"^^xsd:date .')).toEqual(['a']);
    expect(focusNodes('ex:a ex:when "2021-13-01"^^xsd:date .')).toEqual(['a']);
    // 2024 is a leap year, 2023 is not.
    expect(focusNodes('ex:a ex:when "2023-02-29"^^xsd:date .')).toEqual(['a']);
  });

  it('accepts real dates, including a leap day in a leap year', () => {
    expect(run('ex:a ex:when "2021-02-28"^^xsd:date .')).toEqual([]);
    expect(run('ex:a ex:when "2024-02-29"^^xsd:date .')).toEqual([]);
    expect(run('ex:a ex:when "2021-12-31"^^xsd:date .')).toEqual([]);
  });

  it('checks dateTime time components, allowing the two XSD legalises', () => {
    expect(focusNodes('ex:a ex:at "2021-01-01T25:00:00"^^xsd:dateTime .')).toEqual(['a']);
    expect(focusNodes('ex:a ex:at "2021-01-01T00:61:00"^^xsd:dateTime .')).toEqual(['a']);
    // 24:00:00 ends the day and 60 seconds is a leap second -- both legal.
    expect(run('ex:a ex:at "2021-01-01T24:00:00"^^xsd:dateTime .')).toEqual([]);
    expect(run('ex:a ex:at "2021-01-01T23:59:60"^^xsd:dateTime .')).toEqual([]);
  });

  it('leaves a malformed lexical form alone -- the regex formulations report those', () => {
    // Not this module's job; double-reporting would produce two findings for one fault.
    expect(run('ex:a ex:when "not-a-date"^^xsd:date .')).toEqual([]);
    expect(run('ex:a ex:count "twelve"^^xsd:integer .')).toEqual([]);
  });

  it('ignores untyped, language-tagged and non-XSD literals', () => {
    expect(run('ex:a ex:label "plain" .')).toEqual([]);
    expect(run('ex:a ex:label "tagged"@en .')).toEqual([]);
    expect(run('ex:a ex:x "whatever"^^<http://example.org/custom> .')).toEqual([]);
  });

  it('reports as DAT-001 with the predicate as path, so it merges with the regex formulations', () => {
    const [row] = run('ex:a ex:when "2021-02-30"^^xsd:date .');
    expect(row.checkId).toBe('DAT-001');
    expect(row.path).toBe('http://example.org/demo#when');
    expect(row.value).toBe('2021-02-30');
    expect(row.sources).toEqual(['sparql']);
  });

  it('does not double-report the same literal on the same subject and predicate', () => {
    expect(run('ex:a ex:when "2021-02-30"^^xsd:date, "2021-02-30"^^xsd:date .')).toHaveLength(1);
  });
});
