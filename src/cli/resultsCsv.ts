import { parseCsv } from '../triplify/csv';
import type { ResultRow, Severity } from '../types';

/**
 * Reads the `full_results.csv` the Python CLI writes into this project's own
 * `ResultRow`, so a CLI-backed finding renders exactly like an in-process one.
 *
 * The contract is that file's ten columns, and it is worth pinning rather than
 * assuming: this is the only place the two projects meet at runtime, and the
 * *other* thing joining them — the name of the executable — was silently wrong
 * for six releases (see ontologySuiteClient.ts). `__fixtures__/full_results.csv`
 * is real output, not a hand-written approximation, including the row whose
 * message carries an embedded newline and doubled quotes.
 *
 * Pure (no `vscode` import) so it can be tested, the same split
 * `checks/projectStandardsCore.ts` and `checks/findingSummary.ts` make.
 */
export function parseResultsCsv(csvText: string): ResultRow[] {
  const { rows } = parseCsv(csvText);
  return rows.map((r) => ({
    // The CLI writes UNMAPPED/unmapped for a finding it could not resolve to a
    // registry entry; this project spells that absence as null, the way the SHACL
    // runner used to before it learned to resolve nested shapes.
    checkId: r.check_id === 'UNMAPPED' ? null : r.check_id || null,
    category: r.category === 'unmapped' ? null : r.category || null,
    title: r.title || null,
    severity: (r.severity as Severity) || 'Info',
    focusNode: r.focus_node ?? '',
    path: r.path || null,
    value: r.value || null,
    message: r.message ?? '',
    remediation: r.remediation || null,
    // The CLI joins the engines that agreed on a finding with '+', which is the
    // same convention checks/merge.ts uses when it merges two of its own rows.
    sources: r.sources ? r.sources.split('+') : ['python-cli'],
  }));
}
