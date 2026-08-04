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
    const checkId = reason === 'disjointClasses' ? 'REA-DISJOINT' : reason === 'sameAsAndDifferentFrom' ? 'REA-SAMEDIFF' : 'REA-CONTRADICTION';

    rows.push({
      checkId,
      category: 'reasoning',
      title: 'Inferred inconsistency',
      severity: 'Violation',
      focusNode: edge.focus,
      path: null,
      value: null,
      message: messageFn ? messageFn(get) : `Reasoner-derived contradiction (${reason}).`,
      remediation: 'Review the conflicting assertions above and correct or remove one of them.',
      sources: ['reasoning'],
    });
  }
  return rows;
}
