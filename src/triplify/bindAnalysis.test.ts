import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  analyseBinds,
  bindReportToRows,
  extractBinds,
  formatBindReport,
  skeleton,
  stripComments,
} from './bindAnalysis';

/**
 * Ported from `consolidated_ontology_suite_python/tests/test_bind_analysis.py`,
 * against the same two-query fixture (`examples/tarql_drift/`).
 *
 * Two things here are load-bearing and everything else is detail.
 *
 * The first is **skeleton comparison**. Comparing BIND expressions as raw text
 * reports every difference, including the ordinary one where two files feed the
 * same template from a differently-named CSV column -- which is most of them, and
 * which makes the check noise. Measured upstream on a real ten-query folder: 37
 * target variables are bound in more than one file, 8 of those with differing
 * expression text, and skeleton comparison reports 7 -- dropping the one case
 * where two files feed an identical template from differently-named columns. The
 * `?surface_IRI` case in the fixture pins that behaviour from the other side:
 * same template, different source variable, no finding.
 *
 * The second is **comment and literal handling**. These queries build IRIs out of
 * string literals containing `#`, `{`, quotes and backslashes, and they reference
 * namespaces whose IRIs contain `#`. A naive comment strip, or a regex to the
 * first paren, silently mangles exactly the expressions this module exists to
 * compare -- and the damage looks like a clean result rather than an error.
 */
const FIXTURE_DIR = path.resolve(__dirname, '../../examples/tarql_drift');

function fixtureReport() {
  const queries = fs.readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith('.rq'))
    .sort()
    .map((f) => ({ source: path.join(FIXTURE_DIR, f), text: fs.readFileSync(path.join(FIXTURE_DIR, f), 'utf8') }));
  return analyseBinds(queries);
}

describe('the three TQL checks against examples/tarql_drift', () => {
  it('fires each check exactly once on the fixture', () => {
    const counts = new Map<string, number>();
    for (const row of bindReportToRows(fixtureReport())) {
      counts.set(row.checkId as string, (counts.get(row.checkId as string) ?? 0) + 1);
    }
    expect(Object.fromEntries(counts)).toEqual({ 'TQL-001': 1, 'TQL-002': 1, 'TQL-003': 1 });
  });

  it('names both competing expressions in the drift finding', () => {
    const report = fixtureReport();
    expect(report.drift.length).toBe(1);
    expect(report.drift[0].target).toBe('road_IRI');
    expect(report.drift[0].variants.length).toBe(2);

    // The reviewer has to be able to see *what* differs without opening the
    // files, so both templates appear in the message.
    const message = bindReportToRows(report)[0].message;
    expect(message).toContain('REPLACE');
    expect(formatBindReport(report)).toContain('roads_to_rdf.rq');
  });

  it('reports an unbound constructed-IRI variable as a Violation and a plain column as Info', () => {
    const rows = new Map(bindReportToRows(fixtureReport()).map((r) => [r.checkId, r]));
    expect(rows.get('TQL-002')?.focusNode).toBe('?direction_IRI');
    expect(rows.get('TQL-002')?.severity).toBe('Violation');
    // A plain column name is the same structural situation and must not be
    // reported at the same severity, or the finding that matters is buried.
    expect(rows.get('TQL-003')?.focusNode).toBe('?roadname');
    expect(rows.get('TQL-003')?.severity).toBe('Info');
  });

  it('resolves every row against a registry entry with the same category and severity', () => {
    const registry = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, '../../resources/checks-registry/registry.json'), 'utf8'),
    ) as { checks: { id: string; category: string; default_severity: string }[] };
    const declared = new Map(registry.checks.map((c) => [c.id, c]));

    for (const row of bindReportToRows(fixtureReport())) {
      const entry = declared.get(row.checkId as string);
      expect(entry, `${row.checkId} is not in registry.json`).toBeDefined();
      expect(row.severity).toBe(entry?.default_severity);
      expect(row.category).toBe(entry?.category);
      expect(entry?.category).toBe('tarql');
    }
  });
});

describe('skeleton comparison -- the design decision the check rests on', () => {
  it('does not report the same template fed from a differently-named variable', () => {
    // ?surface_IRI is bound in both fixture files from differently-named columns
    // through an identical template. Reporting it would be wrong.
    const report = fixtureReport();
    expect(report.drift.map((g) => g.target)).not.toContain('surface_IRI');
    expect(report.sharedAndConsistent).toContainEqual({ target: 'surface_IRI', fileCount: 2 });
  });

  it('keeps literals and structure while dropping variable names and whitespace', () => {
    const same = skeleton('CONCAT("exd:_Road_", ?a)');
    expect(skeleton('CONCAT("exd:_Road_",   ?b)')).toBe(same);

    expect(skeleton('CONCAT("exd:_Rodd_", ?a)')).not.toBe(same); // a literal typo changes the minted IRI
    expect(skeleton('CONCAT("exd:_Road_", REPLACE(?a, " ", "_"))')).not.toBe(same); // so does an extra call
  });
});

describe('parsing', () => {
  it('does not treat a # inside an IRI or a string literal as a comment', () => {
    const text = 'prefix geo: <http://www.opengis.net/ont/geosparql#>\nWHERE { BIND(CONCAT("a#b", ?x) AS ?y) }\n';
    const stripped = stripComments(text);

    expect(stripped).toContain('geosparql#');
    expect(stripped).toContain('a#b');
    expect(extractBinds(stripped, 't.rq').map((b) => b.target)).toEqual(['y']);
  });

  it('removes a real comment without shifting line numbers', () => {
    const text = 'line one\n# BIND(1 AS ?ghost)\nWHERE { BIND(2 AS ?real) }\n';
    const binds = extractBinds(stripComments(text), 't.rq');

    expect(binds.map((b) => b.target)).toEqual(['real']); // a commented-out BIND must not count
    expect(binds[0].line).toBe(3); // offsets are preserved, so line numbers stay true
  });

  it('parses nested calls out to the outer paren', () => {
    // A non-greedy regex stops at the first `)`, which truncates every expression
    // of the shape this module is built for.
    const text = 'BIND(tarql:expandPrefixedName(CONCAT("x:_A_", REPLACE(?a, ?b, "_"))) as ?out)';
    const binds = extractBinds(text, 't.rq');

    expect(binds.length).toBe(1);
    expect(binds[0].target).toBe('out');
    expect(binds[0].expression.startsWith('tarql:expandPrefixedName')).toBe(true);
    expect(binds[0].expression.endsWith('"_")))')).toBe(true);
  });

  it('does not let a brace inside a string literal break block matching', () => {
    const text = 'CONSTRUCT { ?s ?p "a { brace" } WHERE { BIND(1 AS ?s) }';
    expect(extractBinds(text, 't.rq').map((b) => b.target)).toEqual(['s']);
  });

  it('records the CONSTRUCT-template line an unbound variable is used on', () => {
    // Not in the upstream port: the Python report has no line for an unbound
    // variable because it renders to a text review, while a VS Code diagnostic
    // needs a range to attach to.
    const text = [
      'prefix ex: <https://example.org/>',
      'CONSTRUCT {',
      '  ?a_IRI a ex:Thing ;',
      '    ex:related ?missing_IRI .',
      '}',
      'WHERE { BIND(IRI("x") AS ?a_IRI) }',
    ].join('\n');
    const report = analyseBinds([{ source: 'q.rq', text }]);

    expect(report.unbound.map((u) => [u.variable, u.line])).toEqual([['missing_IRI', 4]]);
  });
});

describe('a folder with nothing to compare', () => {
  it('invents no drift finding from a single clean query', () => {
    // One query cannot drift against itself.
    const text = [
      'prefix ex: <https://example.org/>',
      'CONSTRUCT { ?a_IRI a ex:Thing }',
      'WHERE { BIND(IRI(CONCAT("https://example.org/", ?id)) AS ?a_IRI) }',
    ].join('\n');
    const report = analyseBinds([{ source: 'only.rq', text }]);

    expect(report.drift).toEqual([]);
    expect(report.unbound).toEqual([]);
    expect(report.isClean).toBe(true);
  });
});
