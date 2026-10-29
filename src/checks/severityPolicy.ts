import * as fs from 'node:fs';
import { PROJECT_REQUIRED_CHECK_ID } from './classRules';
import type { ResultRow, Severity } from '../types';

/**
 * Stage-dependent severity, declared in one file and applied to finished findings. A port of the
 * Python suite's `checks/severity_policy.py` (its `--severity-policy` and `--stringency`, 0.25.0),
 * so that one policy file means the same thing in this editor as in that suite's CI run.
 *
 * The same fault means different things at different points in a project's life: a property with
 * no domain or range is worth knowing about while a model is being sketched, and worth blocking a
 * release over. Nothing about the check changes between those two readings, only the stringency
 * being applied -- so the answer is not to edit the check, and not `disabledChecks` either, which
 * says "never ask this" rather than "at this stage, report it as that":
 *
 *     { "stages": {
 *         "sketch":  { "STR-003": "Info" },
 *         "draft":   { "STR-003": "Warning" },
 *         "release": { "extends": "draft", "STR-003": "Violation", "QUA-004": "off" } } }
 *
 * The stage names are the project's own. `extends` pulls another stage in and applies the rest on
 * top. A file with no `stages` is one stage, and a list of one-key objects is read as one object,
 * because that is what people write by hand. `off` is not a severity: it drops the check's
 * findings from this stage, where `Info` reports them.
 *
 * Nothing is relabelled quietly. A re-mapped row keeps what its check declared in
 * `declaredSeverity`, every re-mapping comes back as a `PolicyChange` for the run to report, and a
 * policy that cannot be applied whole is refused with a `PolicyError` that names every problem: a
 * half-applied severity policy is the one outcome this exists to make impossible.
 *
 * Pure apart from reading the file, the split `projectStandardsCore.ts` makes, so it is tested
 * without VS Code. The messages are the Python suite's, except where they name a setting rather
 * than a flag.
 */

export const SEVERITIES = ['Violation', 'Warning', 'Info'] as const;
export const OFF = 'off';
export type PolicyTarget = (typeof SEVERITIES)[number] | typeof OFF;

/** Reserved inside a stage. A check id is a prefix, a dash and digits, so it cannot be one. */
const EXTENDS = 'extends';

/** The name a file without `stages` is read under. */
export const IMPLICIT_STAGE = 'default';

/**
 * The check ids this extension reports that the shared registry does not have, which a policy may
 * name here: the malformed-OWL checks, modelling guidance and the project's class rules. The Python
 * suite never produces them, so its own `--severity-policy` refuses them -- a policy file shared
 * with that suite's CI should name only registry checks.
 */
export const EXTENSION_CHECK_IDS: readonly string[] = ['MAL-001', 'MAL-002', 'MAL-003', 'MDL-001', 'MDL-002', 'MDL-003', PROJECT_REQUIRED_CHECK_ID];

/** A policy that cannot be used. The message is what the user is shown. */
export class PolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PolicyError';
  }
}

export interface SeverityPolicy {
  path: string;
  /** Stage name -> that stage's own entries, `extends` included and nothing yet checked. */
  stages: Map<string, Map<string, unknown>>;
}

/** One check's re-mapping on one run. */
export interface PolicyChange {
  checkId: string;
  declared: Severity;
  applied: PolicyTarget;
  rows: number;
}

export function describeChange(change: PolicyChange): string {
  return change.applied === OFF
    ? `${change.checkId} ${change.declared} -> off (${change.rows} finding(s) dropped)`
    : `${change.checkId} ${change.declared} -> ${change.applied} (${change.rows} finding(s))`;
}

/** Reported when a stage moved nothing: usually a wrong stage or a stale id list, and otherwise indistinguishable from a correct run. */
export function nothingChangedWarning(stage: string, checks: number): string {
  return (
    `severity policy stage '${stage}' changed nothing: none of its ${checks} check(s) produced a finding ` +
    'whose severity differed. Check the stage name if that is a surprise.'
  );
}

export function loadPolicy(path: string): SeverityPolicy {
  let text: string;
  try {
    text = fs.readFileSync(path, 'utf8');
  } catch {
    throw new PolicyError(`no severity policy at ${path}`);
  }
  return parsePolicy(text, path);
}

export function parsePolicy(text: string, path: string): SeverityPolicy {
  let raw: unknown;
  try {
    // A byte-order mark is what Windows editors put at the front of a UTF-8 file, and JSON.parse
    // rejects it. The Python suite rejects it too; refusing a file over it here helps nobody.
    raw = JSON.parse(text.replace(/^﻿/, ''));
  } catch (err) {
    throw new PolicyError(`${path} is not valid JSON: ${(err as Error).message}`);
  }

  let stages: Map<string, Map<string, unknown>>;
  if (isObject(raw) && 'stages' in raw) {
    const stagesRaw = raw.stages;
    if (!isObject(stagesRaw) || Object.keys(stagesRaw).length === 0) {
      throw new PolicyError(`${path}: 'stages' must be a non-empty object`);
    }
    stages = new Map(Object.entries(stagesRaw).map(([name, body]) => [name, stageMap(path, name, body)]));
  } else {
    stages = new Map([[IMPLICIT_STAGE, stageMap(path, IMPLICIT_STAGE, raw)]]);
  }

  const policy = { path, stages };
  checkExtends(policy);
  return policy;
}

/** One stage's id -> severity entries, from an object or a list of them. */
function stageMap(path: string, name: string, body: unknown): Map<string, unknown> {
  const items: [string, unknown][] = [];
  if (isObject(body)) {
    items.push(...Object.entries(body));
  } else if (Array.isArray(body)) {
    for (const entry of body) {
      if (!isObject(entry)) throw new PolicyError(`${path}: stage '${name}' has an entry that is not an object: ${repr(entry)}`);
      items.push(...Object.entries(entry));
    }
  } else {
    throw new PolicyError(`${path}: stage '${name}' must be an object or a list of objects, found ${typeName(body)}`);
  }

  const mapping = new Map<string, unknown>();
  for (const [key, value] of items) {
    // Keeping the last would make the file's meaning depend on its order, which is not a thing
    // anyone should have to know about a policy.
    if (mapping.has(key) && mapping.get(key) !== value) {
      throw new PolicyError(`${path}: stage '${name}' lists ${key} twice, as ${repr(mapping.get(key))} and as ${repr(value)}`);
    }
    mapping.set(key, value);
  }
  return mapping;
}

function checkExtends(policy: SeverityPolicy): void {
  for (const name of policy.stages.keys()) {
    const seen = [name];
    let cursor = name;
    for (;;) {
      const parent = policy.stages.get(cursor)?.get(EXTENDS);
      if (parent === undefined) break;
      if (typeof parent !== 'string' || !policy.stages.has(parent)) {
        throw new PolicyError(`${policy.path}: stage '${cursor}' extends '${String(parent)}', which is not a stage here. Stages: ${stageNames(policy).join(', ')}`);
      }
      if (seen.includes(parent)) {
        throw new PolicyError(`${policy.path}: stages extend each other in a cycle: ${[...seen, parent].join(' -> ')}`);
      }
      seen.push(parent);
      cursor = parent;
    }
  }
}

export function stageNames(policy: SeverityPolicy): string[] {
  return [...policy.stages.keys()].sort();
}

/**
 * The effective entries for one stage, `extends` applied, nearest stage winning.
 *
 * A policy with one stage does not need naming. A policy with several does: the alternative is
 * picking one for the user, and silently picking the wrong stringency is the failure this is
 * against.
 */
export function resolveStage(policy: SeverityPolicy, stage?: string): { stage: string; resolved: Map<string, unknown> } {
  const names = stageNames(policy);
  if (stage === undefined) {
    if (names.length !== 1) {
      throw new PolicyError(`${policy.path} declares ${names.length} stages (${names.join(', ')}); say which one with the ontologySuite.stringency setting`);
    }
    stage = names[0];
  }
  if (!policy.stages.has(stage)) {
    throw new PolicyError(`${policy.path} has no stage '${stage}'. Stages: ${names.join(', ')}`);
  }

  // checkExtends has already refused an unknown parent or a cycle, so this walk ends.
  const chain = [stage];
  for (let parent = policy.stages.get(stage)?.get(EXTENDS); typeof parent === 'string'; parent = policy.stages.get(parent)?.get(EXTENDS)) {
    chain.push(parent);
  }
  const resolved = new Map<string, unknown>();
  for (const name of chain.reverse()) {
    for (const [key, value] of policy.stages.get(name) ?? []) {
      if (key !== EXTENDS) resolved.set(key, value);
    }
  }
  return { stage, resolved };
}

/**
 * Refuses a resolved stage before it is applied, naming every problem at once.
 *
 * Both failure modes are silent otherwise: a severity the suite does not have cannot be applied to
 * anything, and an id nothing reports matches no finding, so its entry is never applied.
 * `STR-0003` for `STR-003` is the one to expect -- it reads as entirely plausible in a diff.
 */
export function validateStage(resolved: ReadonlyMap<string, unknown>, knownIds: Iterable<string>): Map<string, PolicyTarget> {
  const known = [...new Set(knownIds)];
  const problems: string[] = [];
  for (const [checkId, severity] of [...resolved].sort(([a], [b]) => compare(a, b))) {
    if (!known.includes(checkId)) {
      const near = known.filter((other) => squash(other) === squash(checkId)).sort();
      problems.push(`${checkId} is not a check in this registry${near.length ? ` -- did you mean ${near.join(', ')}?` : ''}`);
    }
    if (!isTarget(severity)) {
      problems.push(`${checkId}: ${repr(severity)} is not a severity. Use one of ${SEVERITIES.join(', ')}, or '${OFF}' to leave the check out of this stage`);
    }
  }
  if (problems.length) throw new PolicyError(problems.join('; '));
  return new Map(resolved as ReadonlyMap<string, PolicyTarget>);
}

/**
 * Re-maps finished rows, keeping what each check declared.
 *
 * Applied to rows rather than to checks, which is what makes it hold for every engine at once: a
 * check that ran as both a shape and a query is one row by the time the merge is done, so there is
 * no way to apply the policy to half of it. `declaredSeverity` is set only on a row the policy
 * moved, so that a populated one means "re-mapped" and nothing else.
 */
export function applyPolicy(rows: readonly ResultRow[], targets: ReadonlyMap<string, PolicyTarget>): { rows: ResultRow[]; changes: PolicyChange[] } {
  const counts = new Map<string, { checkId: string; declared: Severity; rows: number }>();
  const kept: ResultRow[] = [];
  for (const row of rows) {
    const target = row.checkId === null ? undefined : targets.get(row.checkId);
    if (row.checkId === null || target === undefined) {
      kept.push(row);
      continue;
    }
    const key = `${row.checkId}\u0000${row.severity}`;
    const count = counts.get(key) ?? { checkId: row.checkId, declared: row.severity, rows: 0 };
    count.rows++;
    counts.set(key, count);
    if (target === OFF) continue;
    kept.push(target === row.severity ? row : { ...row, severity: target, declaredSeverity: row.severity });
  }

  const changes = [...counts.values()]
    .map((count) => ({ ...count, applied: targets.get(count.checkId) as PolicyTarget }))
    .filter((change) => change.applied !== change.declared)
    .sort((a, b) => compare(a.checkId, b.checkId) || compare(a.declared, b.declared));
  return { rows: kept, changes };
}

/** A check id with its dashes and zeros removed, for near-miss hints. */
function squash(checkId: string): string {
  return checkId.replace(/-/g, '').replace(/0/g, '').toUpperCase();
}

function isTarget(value: unknown): value is PolicyTarget {
  return value === OFF || (SEVERITIES as readonly unknown[]).includes(value);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function typeName(value: unknown): string {
  if (value === null) return 'null';
  return Array.isArray(value) ? 'array' : typeof value;
}

/** A value as the Python suite's messages quote it: strings in single quotes, the rest as JSON. */
function repr(value: unknown): string {
  return typeof value === 'string' ? `'${value}'` : JSON.stringify(value);
}

/** Code-point order, as Python's `sorted` gives the suite's messages. */
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
