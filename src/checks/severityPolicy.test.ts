import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseTurtle } from '../rdf/parseDocument';
import { loadRegistry } from './registryLoader';
import { runSparqlChecks } from './sparqlRunner';
import { runShaclChecks } from './shaclRunner';
import { mergeResultRows } from './merge';
import {
  applyPolicy,
  describeChange,
  EXTENSION_CHECK_IDS,
  loadPolicy,
  OFF,
  parsePolicy,
  PolicyError,
  PolicyTarget,
  resolveStage,
  SEVERITIES,
  stageNames,
  validateStage,
} from './severityPolicy';
import type { ResultRow, Severity } from '../types';

/**
 * The severity policy, ported from the Python suite's `checks/severity_policy.py`.
 *
 * The first groups are that suite's own `tests/test_severity_policy.py`, case for case, so the two
 * ports are held to the same statements. The invariant throughout is the one that file names: a
 * policy may change what a run reports, but never invisibly -- `declaredSeverity` keeps what the
 * check said, and every re-mapping is returned to be reported.
 *
 * The last group runs both ports on the same policies, for whoever has both checkouts.
 */
const REGISTRY_DIR = path.resolve(__dirname, '../../resources/checks-registry');
const registry = loadRegistry(REGISTRY_DIR);
const KNOWN = [...registry.checksById.keys(), ...EXTENSION_CHECK_IDS];

const policyOf = (body: unknown) => parsePolicy(JSON.stringify(body), 'severities.json');
const errorOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(PolicyError);
    return (err as Error).message;
  }
  throw new Error('expected a PolicyError');
};

function row(checkId: string, severity: Severity): ResultRow {
  return { checkId, category: 'structural', title: 't', severity, focusNode: 'https://example.org/mine/x', path: null, value: null, message: 'm', remediation: null, sources: ['sparql'] };
}
const targets = (entries: Record<string, PolicyTarget>) => new Map(Object.entries(entries));

describe('loading and resolution', () => {
  it('reads a flat object as one unnamed stage', () => {
    const policy = policyOf({ 'STR-003': 'Info' });
    expect(Object.fromEntries(resolveStage(policy).resolved)).toEqual({ 'STR-003': 'Info' });
    expect(stageNames(policy)).toHaveLength(1);
  });

  it('accepts a list of single-key objects, because that is what people write by hand', () => {
    const { resolved } = resolveStage(policyOf([{ 'STR-003': 'Info' }, { 'QUA-001': 'Violation' }]));
    expect(Object.fromEntries(resolved)).toEqual({ 'STR-003': 'Info', 'QUA-001': 'Violation' });
  });

  it('takes its stage names from the file', () => {
    const policy = policyOf({ stages: { napkin: { 'STR-003': 'Info' }, 'ready-to-ship': { 'STR-003': 'Violation' }, archival: { 'STR-003': 'Violation' } } });
    expect(stageNames(policy)).toEqual(['archival', 'napkin', 'ready-to-ship']);
    expect(resolveStage(policy, 'napkin').resolved.get('STR-003')).toBe('Info');
    expect(resolveStage(policy, 'ready-to-ship').resolved.get('STR-003')).toBe('Violation');
  });

  it('inherits through extends, the nearest stage winning', () => {
    const policy = policyOf({ stages: { draft: { 'STR-003': 'Warning', 'QUA-001': 'Info' }, release: { extends: 'draft', 'STR-003': 'Violation' } } });
    expect(Object.fromEntries(resolveStage(policy, 'release').resolved)).toEqual({ 'STR-003': 'Violation', 'QUA-001': 'Info' });
  });

  it('refuses an extends cycle, showing it', () => {
    expect(errorOf(() => policyOf({ stages: { a: { extends: 'b' }, b: { extends: 'a' } } }))).toContain('cycle: a -> b -> a');
  });

  it('refuses to extend a stage that is not there, naming the ones that are', () => {
    expect(errorOf(() => policyOf({ stages: { release: { extends: 'draft' } } }))).toBe(
      "severities.json: stage 'release' extends 'draft', which is not a stage here. Stages: release",
    );
  });

  it('refuses to pick one of several stages for the user', () => {
    const policy = policyOf({ stages: { a: { 'STR-003': 'Info' }, b: { 'STR-003': 'Violation' } } });
    expect(errorOf(() => resolveStage(policy))).toBe('severities.json declares 2 stages (a, b); say which one with the ontologySuite.stringency setting');
  });

  it('lists the real stages when asked for one that is not there', () => {
    expect(errorOf(() => resolveStage(policyOf({ stages: { draft: {}, release: {} } }), 'relese'))).toBe("severities.json has no stage 'relese'. Stages: draft, release");
  });

  it('refuses a check listed twice in one stage', () => {
    expect(errorOf(() => policyOf([{ 'STR-003': 'Info' }, { 'STR-003': 'Violation' }]))).toBe(
      "severities.json: stage 'default' lists STR-003 twice, as 'Info' and as 'Violation'",
    );
  });

  it('refuses a file it cannot use, saying which', () => {
    expect(errorOf(() => policyOf({ stages: {} }))).toBe("severities.json: 'stages' must be a non-empty object");
    expect(errorOf(() => policyOf(['STR-003']))).toBe("severities.json: stage 'default' has an entry that is not an object: 'STR-003'");
    expect(errorOf(() => policyOf({ stages: { draft: 'strict' } }))).toBe("severities.json: stage 'draft' must be an object or a list of objects, found string");
    expect(errorOf(() => parsePolicy('{ "STR-003": ', 'severities.json'))).toMatch(/^severities\.json is not valid JSON: /);
    expect(errorOf(() => loadPolicy(path.join(os.tmpdir(), 'no-such-policy.json')))).toMatch(/^no severity policy at /);
  });

  it('reads a file a Windows editor saved with a byte-order mark', () => {
    expect(resolveStage(parsePolicy('﻿{ "STR-003": "Info" }', 'severities.json')).resolved.get('STR-003')).toBe('Info');
  });
});

describe('validation', () => {
  it('refuses an unknown id, with the near miss it probably meant', () => {
    expect(errorOf(() => validateStage(new Map([['STR-0003', 'Violation']]), ['STR-003', 'QUA-001']))).toBe(
      'STR-0003 is not a check in this registry -- did you mean STR-003?',
    );
  });

  it('refuses a severity the suite does not have, naming the ones it does', () => {
    expect(errorOf(() => validateStage(new Map([['STR-003', 'Not a worry']]), ['STR-003']))).toBe(
      "STR-003: 'Not a worry' is not a severity. Use one of Violation, Warning, Info, or 'off' to leave the check out of this stage",
    );
  });

  it('names every problem at once, in id order', () => {
    const message = errorOf(() => validateStage(new Map([['STR-003', 'Error'], ['QUA-0001', 'Info']]), ['STR-003', 'QUA-001']));
    expect(message.split('; ')).toEqual([
      'QUA-0001 is not a check in this registry -- did you mean QUA-001?',
      "STR-003: 'Error' is not a severity. Use one of Violation, Warning, Info, or 'off' to leave the check out of this stage",
    ]);
  });

  it('accepts off, which is not a severity', () => {
    expect(validateStage(new Map([['STR-003', OFF]]), ['STR-003']).get('STR-003')).toBe('off');
  });

  it('accepts the ids only this extension reports', () => {
    // The Python suite would refuse these, having never heard of them; here they are findings
    // like any other, and a project may well want MDL guidance quieter while sketching.
    expect(() => validateStage(new Map(EXTENSION_CHECK_IDS.map((id) => [id, 'Info'])), KNOWN)).not.toThrow();
  });

  it('knows every id this extension reports that the registry does not', () => {
    // A check id added in code and not here would be refused by every policy that named it.
    const literals = new Set<string>();
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name)) {
          for (const m of fs.readFileSync(full, 'utf8').matchAll(/'([A-Z]{3}-\d{3})'/g)) literals.add(m[1]);
        }
      }
    };
    walk(path.resolve(__dirname, '..'));
    const unregistered = [...literals].filter((id) => !registry.checksById.has(id)).sort();
    expect(unregistered).toEqual(EXTENSION_CHECK_IDS.filter((id) => /^[A-Z]{3}-\d{3}$/.test(id)).sort());
    expect(EXTENSION_CHECK_IDS.filter((id) => registry.checksById.has(id))).toEqual([]);
  });

  it('offers the editor every check a policy can name, and the values it can take', () => {
    // The schema behind completion in .ontology-suite/severity-policy.json. Its check list is
    // written out, so that hovering an id shows the check's title -- and so it can fall behind the
    // registry, which is what this catches.
    const schema = JSON.parse(fs.readFileSync(path.join(REGISTRY_DIR, 'severity-policy.schema.json'), 'utf8')) as {
      definitions: { target: { enum: string[] }; stage: { properties: Record<string, unknown> } };
    };
    const offered = Object.keys(schema.definitions.stage.properties).filter((key) => key !== 'extends');
    expect(offered).toEqual([...KNOWN].sort());
    expect(schema.definitions.target.enum).toEqual([...SEVERITIES, OFF]);
  });
});

describe('application to rows', () => {
  it('keeps what the check declared', () => {
    const { rows, changes } = applyPolicy([row('STR-003', 'Warning')], targets({ 'STR-003': 'Violation' }));
    expect(rows[0].severity).toBe('Violation');
    expect(rows[0].declaredSeverity).toBe('Warning');
    expect(changes.map(describeChange)).toEqual(['STR-003 Warning -> Violation (1 finding(s))']);
  });

  it('leaves declaredSeverity unset when nothing moved', () => {
    // A populated declaredSeverity has to mean "this was re-mapped"; filling it in unconditionally
    // would make every row look overridden.
    const { rows, changes } = applyPolicy([row('STR-003', 'Warning')], targets({ 'STR-003': 'Warning' }));
    expect(rows[0].declaredSeverity).toBeUndefined();
    expect(changes).toEqual([]);
  });

  it('drops the findings of a check that is off', () => {
    const { rows, changes } = applyPolicy([row('STR-003', 'Warning'), row('QUA-001', 'Info')], targets({ 'STR-003': OFF }));
    expect(rows.map((r) => r.checkId)).toEqual(['QUA-001']);
    expect(changes.map(describeChange)).toEqual(['STR-003 Warning -> off (1 finding(s) dropped)']);
  });

  it('leaves alone the checks the policy does not mention', () => {
    const untouched = row('QUA-001', 'Info');
    expect(applyPolicy([untouched], targets({ 'STR-003': OFF })).rows[0]).toBe(untouched);
  });

  it('counts per check and declared severity, sorted', () => {
    const { changes } = applyPolicy(
      [row('STR-003', 'Warning'), row('MDL-001', 'Hint'), row('STR-003', 'Warning'), row('MDL-001', 'Hint')],
      targets({ 'STR-003': 'Info', 'MDL-001': 'Info' }),
    );
    expect(changes.map(describeChange)).toEqual(['MDL-001 Hint -> Info (2 finding(s))', 'STR-003 Warning -> Info (2 finding(s))']);
  });

  it('re-maps a check written as both a shape and a query once and wholly', () => {
    // Rewriting a check's files applies to one formulation at a time, and the shape's severity
    // silently wins. Applied to merged rows that cannot happen: both formulations are one row by
    // then, which `sources` shows.
    const fixture = path.join(__dirname, '__fixtures__/dual-formulation.ttl');
    const { quads } = parseTurtle(fixture, fs.readFileSync(fixture, 'utf8'));
    const merged = mergeResultRows(runSparqlChecks(quads, registry), runShaclChecks(quads, registry));
    const declared = registry.checksById.get('STR-002')?.default_severity;
    expect(declared).toBe('Violation');

    const { rows, changes } = applyPolicy(merged, targets({ 'STR-002': 'Info' }));
    const str002 = rows.filter((r) => r.checkId === 'STR-002');
    expect(str002.length, 'STR-002 did not fire; the fixture no longer exercises this').toBeGreaterThan(0);
    for (const r of str002) {
      expect(r.severity).toBe('Info');
      expect(r.declaredSeverity).toBe('Violation');
      expect(r.sources).toEqual(['shacl', 'sparql']);
    }
    expect(changes.map(describeChange)).toEqual([`STR-002 Violation -> Info (${str002.length} finding(s))`]);
  });
});

/**
 * Both ports, the same policies, the same answers -- for whoever has both checkouts, the way
 * `registryParity.test.ts` compares the shared files.
 *
 * Runs the Python suite's own module, loaded by path so nothing else of that suite is imported,
 * with the interpreter from its `.venv`; skipped when either is missing. Never a bare `python`,
 * which on Windows can be the Store's stub and wait for ever.
 *
 * Where the two differ by design the comparison says so: the extension names a setting where the
 * suite names a flag, and their JSON parsers word a syntax error differently.
 */
function findPythonSuite(): { python: string; module: string } | undefined {
  const configured = process.env.ONTOLOGY_SUITE_PYTHON;
  const roots = [...(configured ? [configured] : []), path.resolve(__dirname, '../../../consolidated_ontology_suite_python')];
  for (const root of roots) {
    const module = path.join(root, 'ontology_suite', 'checks', 'severity_policy.py');
    const python = [path.join(root, '.venv', 'Scripts', 'python.exe'), path.join(root, '.venv', 'bin', 'python')].find((p) => fs.existsSync(p));
    if (python && fs.existsSync(module)) return { python, module };
  }
  return undefined;
}

const SUITE = findPythonSuite();

interface ParityCase {
  name: string;
  policy: unknown;
  stage?: string;
  rows?: [string, Severity][];
}

const PARITY_CASES: ParityCase[] = [
  { name: 'flat', policy: { 'STR-003': 'Info', 'QUA-001': 'Violation' }, rows: [['STR-003', 'Warning'], ['QUA-001', 'Warning'], ['QUA-009', 'Warning']] },
  { name: 'list', policy: [{ 'STR-003': 'Info' }, { 'QUA-004': 'off' }], rows: [['QUA-004', 'Warning'], ['QUA-004', 'Warning'], ['STR-003', 'Info']] },
  {
    name: 'staged',
    policy: { stages: { sketch: { 'STR-003': 'Info' }, draft: { 'STR-003': 'Warning', 'QUA-009': 'off' }, release: { extends: 'draft', 'STR-003': 'Violation' } } },
    stage: 'release',
    rows: [['STR-003', 'Warning'], ['QUA-009', 'Warning'], ['STY-003', 'Info']],
  },
  { name: 'unnamed stage of several', policy: { stages: { a: {}, b: {} } } },
  { name: 'unknown stage', policy: { stages: { draft: {}, release: {} } }, stage: 'relese' },
  { name: 'cycle', policy: { stages: { a: { extends: 'b' }, b: { extends: 'c' }, c: { extends: 'a' } } } },
  { name: 'unknown parent', policy: { stages: { release: { extends: 'draft' } } } },
  { name: 'duplicate', policy: [{ 'STR-003': 'Info' }, { 'STR-003': 'Violation' }] },
  { name: 'bad entry', policy: [{ 'STR-003': 'Info' }, 'QUA-001'] },
  { name: 'empty stages', policy: { stages: {} } },
  { name: 'near miss and bad severity', policy: { 'STR-0003': 'Violation', 'QUA-001': 'Error', 'ZZZ-999': 'Info' } },
  { name: 'numeric severity', policy: { 'STR-003': 3 } },
];

const PYTHON_DRIVER = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("severity_policy", sys.argv[1])
sp = importlib.util.module_from_spec(spec); sys.modules["severity_policy"] = sp; spec.loader.exec_module(sp)
class Row:
    def __init__(self, check_id, severity):
        self.check_id, self.severity, self.declared_severity = check_id, severity, None
out = []
for case in json.loads(sys.stdin.read()):
    try:
        policy = sp.SeverityPolicy.load(case["path"])
        stage, resolved = policy.resolve(case.get("stage"))
        sp.SeverityPolicy.validate(resolved, case["known"])
        rows, changes = sp.SeverityPolicy.apply([Row(c, s) for c, s in case.get("rows", [])], resolved)
        out.append({"stage": stage, "resolved": sorted(resolved.items()),
                    "rows": [[r.check_id, r.severity, r.declared_severity] for r in rows],
                    "changes": [c.describe() for c in changes]})
    except sp.PolicyError as exc:
        out.append({"error": str(exc)})
print(json.dumps(out))
`;

describe.skipIf(SUITE === undefined)('parity with the Python suite', () => {
  it('gives the same answers to the same policies', () => {
    const { python, module } = SUITE as { python: string; module: string };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'severity-policy-parity-'));
    try {
      const cases = PARITY_CASES.map((c, i) => {
        const file = path.join(dir, `policy-${i}.json`);
        fs.writeFileSync(file, JSON.stringify(c.policy));
        return { ...c, path: file, known: KNOWN };
      });

      const ours = cases.map((c) => {
        try {
          const { stage, resolved } = resolveStage(loadPolicy(c.path), c.stage);
          const { rows, changes } = applyPolicy((c.rows ?? []).map(([id, sev]) => row(id, sev)), validateStage(resolved, c.known));
          return {
            stage,
            resolved: [...resolved].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
            rows: rows.map((r) => [r.checkId, r.severity, r.declaredSeverity ?? null]),
            changes: changes.map(describeChange),
          };
        } catch (err) {
          if (!(err instanceof PolicyError)) throw err;
          return { error: err.message.replace('say which one with the ontologySuite.stringency setting', 'say which one with --stringency') };
        }
      });

      const theirs = JSON.parse(execFileSync(python, ['-I', '-c', PYTHON_DRIVER, module], { input: JSON.stringify(cases), encoding: 'utf8', timeout: 60_000 })) as unknown[];
      cases.forEach((c, i) => expect(ours[i], c.name).toEqual(theirs[i]));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
