import type { ResultRow } from '../types';

/**
 * The one check id worth offering to disable after a run, if there is one.
 *
 * A check that encodes a convention rather than a defect reports once per term,
 * so on a graph it does not suit it does not *add* findings, it **is** the
 * findings -- `QUA-009`/`QUA-010` ask for SKOS documentation and produce 52 on an
 * ontology documented with `rdfs:label`. `ontologySuite.disabledChecks` answers
 * that, but a setting nobody knows about answers nothing, so the id doing the
 * flooding gets named in the run's own summary.
 *
 * Two thresholds, and both matter. **Half the findings** is what makes an id the
 * story of the run rather than a part of it. **Ten findings** is what stops the
 * offer appearing on a graph with four findings, three of them one check -- true,
 * and not a reason to change a setting.
 *
 * Pure (no `vscode` import) so the thresholds are testable, the same split
 * `projectStandardsCore.ts` makes for the same reason: the arithmetic is the part
 * worth a test and `vscode.window` is the part that cannot have one.
 */
export function dominantCheck(rows: ResultRow[], disabled: ReadonlySet<string>): { checkId: string; count: number } | undefined {
  // The share is against what the user is actually looking at. A finding whose id
  // did not resolve still counts -- it is a diagnostic in the panel like any other
  // -- but an already-disabled id does not, since its rows were filtered out
  // before they got here and counting them would hide the next id behind a
  // denominator of findings nobody can see.
  const visible = rows.filter((row) => row.checkId === null || !disabled.has(row.checkId));

  const counts = new Map<string, number>();
  for (const row of visible) {
    if (row.checkId === null) continue;
    counts.set(row.checkId, (counts.get(row.checkId) ?? 0) + 1);
  }

  let best: { checkId: string; count: number } | undefined;
  for (const [checkId, count] of counts) {
    // Ties go to the id that sorts first, so one run always names the same check
    // rather than whichever the Map happened to yield first.
    if (!best || count > best.count || (count === best.count && checkId < best.checkId)) best = { checkId, count };
  }
  if (!best || best.count < 10 || best.count < visible.length / 2) return undefined;
  return best;
}
