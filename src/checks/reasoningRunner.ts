import * as fs from 'node:fs';
import { Parser, Quad, Writer } from 'n3';
import type { ResultRow } from '../types';

/** This engine's own internal bookkeeping namespace (contradiction/reason/class1/class2/other) -- not real ontology vocabulary, so consumers of computeInferredClosure that visualize/display the closure (e.g. graphView.ts's "Show inferred" overlay) should filter it out rather than show it as if it were a genuine domain-level inference. */
export const OQR = 'https://ontology-dev-suite.local/reasoning#';
const OQR_CONTRADICTION = `${OQR}contradiction`;
const OQR_REASON = `${OQR}reason`;
const OQR_CLASS1 = `${OQR}class1`;
const OQR_CLASS2 = `${OQR}class2`;
const OQR_OTHER = `${OQR}other`;

const REASON_MESSAGES: Record<string, (get: (p: string) => string | undefined) => string> = {
  disjointClasses: (get) =>
    `Individual is asserted as both ${get(OQR_CLASS1)} and ${get(OQR_CLASS2)}, which are declared owl:disjointWith each other.`,
  sameAsAndDifferentFrom: (get) => `Individual is asserted both owl:sameAs and owl:differentFrom ${get(OQR_OTHER)}.`,
};

/**
 * The registry check each contradiction reason reports as.
 *
 * These used to be `REA-DISJOINT`/`REA-SAMEDIFF`/`REA-CONTRADICTION`, ids no
 * registry entry declared -- so the reasoning tier spoke a private vocabulary
 * while `registry.json` declared `REA-001`..`REA-004` that this runner never
 * produced. Worse for `disjointClasses`, which *is* `REA-001`: the asserted case
 * is caught by both this and `sparql/reasoning/REA-001.rq`, so one defect
 * reached the Problems panel as two findings under two ids. Sharing the id and
 * the value makes them merge instead, exactly as the SHACL and SPARQL
 * formulations of every other check do.
 *
 * `value` therefore has to match what the `.rq` twin binds, not merely be
 * present -- see the call site.
 */
const REASON_CHECKS: Record<string, { checkId: string; title: string; value?: (get: (p: string) => string | undefined) => string | null }> = {
  disjointClasses: {
    checkId: 'REA-001',
    title: 'Individual in two disjoint classes (post-closure)',
    value: (get) => {
      const classes = [get(OQR_CLASS1), get(OQR_CLASS2)].filter((c): c is string => c !== undefined);
      return classes.length > 0 ? [...new Set(classes)].sort().join(', ') : null;
    },
  },
  sameAsAndDifferentFrom: {
    checkId: 'REA-005',
    title: 'Individual both owl:sameAs and owl:differentFrom the same node',
    value: (get) => get(OQR_OTHER) ?? null,
  },
  // Reached only if core-rules.n3 grows a reason this reader has not. Reporting
  // it under a declared id beats dropping a contradiction the reasoner found.
  unknown: { checkId: 'REA-006', title: 'Reasoner-derived contradiction (unclassified)' },
};

/**
 * OWL2-RL-ish inference/consistency, the "always available, no JVM" tier --
 * runs a compact hand-written RDFS/OWL2-RL-subset N3 ruleset
 * (resources/reasoning/core-rules.n3) via the EYE reasoner (`eyereasoner`,
 * a WebAssembly build of the mature Prolog-heritage EYE engine). Not a
 * certified OWL2 DL reasoner -- full completeness (HermiT/Pellet) remains
 * the Python CLI's deep-validation fallback.
 */
export async function runReasoningChecks(quads: Quad[], rulesPath: string): Promise<ResultRow[]> {
  const resultText = await computeDeductiveClosureText(quads, rulesPath);
  if (resultText === undefined) return [];
  return extractContradictions(resultText);
}

/**
 * Full EYE deductive closure (asserted quads + everything core-rules.n3 can derive from them),
 * parsed back into quads -- e.g. for the Graph View's "Show inferred" overlay (graphView.ts),
 * which needs the whole closure to diff against the asserted graph, not just the contradiction
 * findings runReasoningChecks extracts from the same closure text.
 */
export async function computeInferredClosure(quads: Quad[], rulesPath: string): Promise<Quad[]> {
  const resultText = await computeDeductiveClosureText(quads, rulesPath);
  if (resultText === undefined) return [];
  try {
    return new Parser().parse(resultText);
  } catch {
    return [];
  }
}

async function computeDeductiveClosureText(quads: Quad[], rulesPath: string): Promise<string | undefined> {
  const { n3reasoner } = await import('eyereasoner');
  const rules = fs.readFileSync(rulesPath, 'utf8');
  const dataText = await serializeToTurtle(quads);
  const combined = `${rules}\n${dataText}`;

  try {
    return (await n3reasoner(combined, undefined, { output: 'deductive_closure', outputType: 'string' })) as string;
  } catch (err) {
    console.error('[ontologySuite] EYE reasoner run failed:', err);
    return undefined;
  }
}

function serializeToTurtle(quads: Quad[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const writer = new Writer({ format: 'text/turtle' });
    writer.addQuads(quads);
    writer.end((err, result) => (err ? reject(err) : resolve(result)));
  });
}

function extractContradictions(turtle: string): ResultRow[] {
  let quads: Quad[];
  try {
    quads = new Parser().parse(turtle);
  } catch {
    return [];
  }

  const byBlankNode = new Map<string, Quad[]>();
  const contradictionEdges: { focus: string; node: string }[] = [];
  for (const q of quads) {
    if (q.predicate.value === OQR_CONTRADICTION) {
      contradictionEdges.push({ focus: q.subject.value, node: q.object.value });
      continue;
    }
    if (q.subject.termType === 'BlankNode') {
      const key = q.subject.value;
      if (!byBlankNode.has(key)) byBlankNode.set(key, []);
      byBlankNode.get(key)!.push(q);
    }
  }

  const rows: ResultRow[] = [];
  for (const edge of contradictionEdges) {
    const details = byBlankNode.get(edge.node) ?? [];
    const get = (pred: string): string | undefined => details.find((d) => d.predicate.value === pred)?.object.value;
    const reason = get(OQR_REASON) ?? 'unknown';
    const messageFn = REASON_MESSAGES[reason];
    const kind = REASON_CHECKS[reason] ?? REASON_CHECKS.unknown;

    rows.push({
      checkId: kind.checkId,
      category: 'reasoning',
      title: kind.title,
      severity: 'Violation',
      focusNode: edge.focus,
      path: null,
      // The value is what lets a REA-001 found here merge with the one
      // sparql/reasoning/REA-001.rq finds: that query binds `sh:value ?c1, ?c2`,
      // which extractRows renders as the distinct values sorted and joined with
      // ", ". Producing anything else -- including nothing -- leaves the asserted
      // case reported twice, which is how this pair behaved when the reasoner
      // used ids of its own.
      value: kind.value?.(get) ?? null,
      message: messageFn ? messageFn(get) : `Reasoner-derived contradiction (${reason}).`,
      remediation: 'Review the conflicting assertions above and correct or remove one of them.',
      sources: ['reasoning'],
    });
  }
  return rows;
}
