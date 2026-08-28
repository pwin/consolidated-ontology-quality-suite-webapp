import * as path from 'node:path';
import type { ResultRow } from '../types';

/**
 * Cross-file review of the `BIND` statements in a folder of TARQL/oxi-gen
 * CONSTRUCT queries -- a port of
 * `consolidated_ontology_suite_python/ontology_suite/sketch/bind_analysis.py`.
 *
 * This is a *native* check: there is no graph to pattern-match. `sketch.ts`
 * deliberately keeps only a query's prefixes and its CONSTRUCT template, turning
 * each variable into a placeholder IRI; the WHERE clause, and with it every BIND
 * expression and the identity of every variable, is gone before the sketch graph
 * exists. So no SPARQL or SHACL formulation over that graph can see any of what
 * this module looks at. It reads the query text instead.
 *
 * A folder of TARQL queries is a program, and like any program it drifts. The
 * same conceptual IRI gets minted in six files, five of them the same way. That
 * drift is invisible in the output -- each query is valid, each produces triples,
 * and the two IRIs for what should be one node simply never join. It surfaces
 * much later as a dangling reference or a duplicate entity, a long way from the
 * query that caused it.
 *
 * Three findings, in descending order of how sure they are:
 *
 * - `TQL-001` -- one target variable, several *structurally different*
 *   expressions across files. Compared on a **skeleton**: the expression with
 *   every `?var` replaced by `?`. Two files minting `?nodeid_IRI` as
 *   `CONCAT("d:_Node_", ?a)` and `CONCAT("d:_Node_", ?b)` are almost certainly
 *   fine -- they read the same column under two names. Two files minting it as
 *   `CONCAT("d:_Node_", ?a)` and `CONCAT("d:_Node_", REPLACE(?a, ?special, ""))`
 *   are not: those produce different IRIs whenever the value contains the
 *   replaced character. Skeleton comparison flags the second and ignores the
 *   first; comparing raw text would report both and be ignored accordingly.
 * - `TQL-002` -- a variable whose name follows the constructed-IRI convention
 *   (`?something_IRI`) is used in the CONSTRUCT template but never bound. By that
 *   convention the variable is built, not read from a column, so nothing will
 *   bind it and the triple it appears in is dropped for every row.
 * - `TQL-003` -- the same, for a variable *not* following that convention.
 *   Reported at Info, and usually not a defect: TARQL binds each CSV header as a
 *   variable of the same name, so an unbound `?roadname` is ordinarily just a
 *   column. Telling a column from a typo means reading the CSV header, which is a
 *   reviewer's job rather than this module's.
 *
 * Requiring every CONSTRUCT variable to be bound would fire on nearly every
 * well-formed query -- TARQL's whole premise is the implicit column binding.
 * Measured upstream against a real ten-query folder: 32 of 228 CONSTRUCT
 * variables are unbound in their own file, and exactly one is a genuine defect.
 * Separating the two by naming convention is what makes the finding actionable.
 */

/**
 * The naming convention that says "this variable is constructed, not read from a
 * column". Configurable because it is a convention rather than a rule -- but a
 * widespread one, and without some such signal TQL-002 and TQL-003 cannot be told
 * apart.
 */
export const DEFAULT_CONSTRUCTED_SUFFIXES = ['_IRI', '_iri', '_URI', '_uri'];

const VARIABLE_G = /[?$]([A-Za-z_][A-Za-z0-9_]*)/g;
const IRI_AT_START = /^<[^<>\s{}|\\^`"]*>/;
/** Longest first: `"""` must be recognised before the `"` it starts with. */
const QUOTES = ['"""', "'''", '"', "'"];

export interface BindStatement {
  source: string;
  target: string;
  expression: string;
  /** One-based, and true to the original file -- see stripComments. */
  line: number;
  skeleton: string;
}

export interface QueryFacts {
  source: string;
  binds: BindStatement[];
  constructVars: Set<string>;
  whereVars: Set<string>;
  /** Everything a row could actually have a value for: BIND targets plus WHERE matches. */
  bound: Set<string>;
  /** First line each CONSTRUCT-template variable appears on, for the unbound findings. */
  constructVarLines: Map<string, number>;
}

/** One target variable bound structurally differently across files. */
export interface DriftGroup {
  target: string;
  variants: { skeleton: string; statements: BindStatement[] }[];
  fileCount: number;
}

export interface UnboundVariable {
  source: string;
  variable: string;
  looksConstructed: boolean;
  line: number;
}

export interface BindReport {
  queries: QueryFacts[];
  drift: DriftGroup[];
  unbound: UnboundVariable[];
  sharedAndConsistent: { target: string; fileCount: number }[];
  bindCount: number;
  isClean: boolean;
}

/**
 * Blanks out `#` comments, leaving everything else at its original offset so
 * reported line numbers stay true.
 *
 * A naive `#`-to-end-of-line strip is wrong on SPARQL twice over: `#` is the
 * fragment separator in almost every RDF namespace, so `<http://x#y>` would lose
 * its local name, and a `#` inside a string literal -- which is exactly what
 * TARQL queries build IRIs out of -- would truncate the expression. This scanner
 * tracks IRI brackets and both quote styles, and only treats `#` as a comment
 * outside them.
 */
export function stripComments(text: string): string {
  const out: string[] = [];
  let i = 0;
  const n = text.length;
  let quote: string | undefined;
  let inIri = false;

  while (i < n) {
    const ch = text[i];
    if (quote !== undefined) {
      if (ch === '\\' && i + 1 < n) {
        out.push(text.slice(i, i + 2));
        i += 2;
        continue;
      }
      if (text.startsWith(quote, i)) {
        out.push(quote);
        i += quote.length;
        quote = undefined;
        continue;
      }
      out.push(ch);
      i += 1;
      continue;
    }
    if (inIri) {
      out.push(ch);
      if (ch === '>') inIri = false;
      i += 1;
      continue;
    }
    if (ch === '<' && IRI_AT_START.test(text.slice(i))) {
      inIri = true;
      out.push(ch);
      i += 1;
      continue;
    }
    const opened = QUOTES.find((q) => text.startsWith(q, i));
    if (opened !== undefined) {
      quote = opened;
      out.push(opened);
      i += opened.length;
      continue;
    }
    if (ch === '#') {
      const newline = text.indexOf('\n', i);
      const end = newline === -1 ? n : newline;
      out.push(' '.repeat(end - i));
      i = end;
      continue;
    }
    out.push(ch);
    i += 1;
  }
  return out.join('');
}

/** Index of the bracket closing the one at `start`, ignoring brackets inside string literals. */
function matching(text: string, start: number, open: string, close: string): number {
  let depth = 0;
  let i = start;
  const n = text.length;
  let quote: string | undefined;

  while (i < n) {
    const ch = text[i];
    if (quote !== undefined) {
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (text.startsWith(quote, i)) {
        i += quote.length;
        quote = undefined;
        continue;
      }
      i += 1;
      continue;
    }
    const opened = QUOTES.find((q) => text.startsWith(q, i));
    if (opened !== undefined) {
      quote = opened;
      i += opened.length;
      continue;
    }
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
    i += 1;
  }
  throw new Error(`unbalanced ${open}${close} from offset ${start}`);
}

/** The `{ ... }` bodies following each occurrence of `keyword`, with their offsets. */
function blocks(text: string, keyword: RegExp): { body: string; start: number }[] {
  const found: { body: string; start: number }[] = [];
  const pattern = new RegExp(keyword.source, 'gi');
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const brace = text.indexOf('{', match.index + match[0].length);
    if (brace === -1) continue;
    let end: number;
    try {
      end = matching(text, brace, '{', '}');
    } catch {
      continue;
    }
    found.push({ body: text.slice(brace + 1, end), start: brace + 1 });
  }
  return found;
}

/**
 * The expression with every variable reduced to a bare `?`, and whitespace
 * collapsed -- what makes two BINDs "the same pattern".
 *
 * Keeping the literals and the function calls but dropping variable *names* is
 * the whole point: a difference in which column feeds a template is ordinary (the
 * same data is called `?direction` in one CSV and `?directionName` in another),
 * while a difference in the template itself changes the IRI that comes out.
 */
export function skeleton(expression: string): string {
  return expression.replace(VARIABLE_G, '?').split(/\s+/).filter((s) => s.length > 0).join(' ');
}

/**
 * Every `BIND(<expr> AS ?target)` in `text`.
 *
 * Bracket-matched rather than regexed to the first `)`: the expressions this is
 * built for nest several calls deep
 * (`tarql:expandPrefixedName(CONCAT("x", REPLACE(?a, ?b, "_")))`), and a
 * non-greedy regex stops at the wrong paren as soon as the `AS` clause is not the
 * outermost thing in the statement.
 */
export function extractBinds(text: string, source: string): BindStatement[] {
  const binds: BindStatement[] = [];
  const bindKeyword = /\bBIND\s*\(/gi;
  let match: RegExpExecArray | null;

  while ((match = bindKeyword.exec(text)) !== null) {
    const openParen = text.indexOf('(', match.index + match[0].length - 1);
    let close: number;
    try {
      close = matching(text, openParen, '(', ')');
    } catch {
      continue;
    }
    const inner = text.slice(openParen + 1, close);

    // The last *top-level* AS is the one separating expression from target: an
    // inner call's own AS, if it ever had one, sits at depth > 0.
    const tokens = /\(|\)|\bAS\b/gi;
    let depth = 0;
    let split: { start: number; end: number } | undefined;
    let token: RegExpExecArray | null;
    while ((token = tokens.exec(inner)) !== null) {
      if (token[0] === '(') depth += 1;
      else if (token[0] === ')') depth -= 1;
      else if (depth === 0) split = { start: token.index, end: token.index + token[0].length };
    }
    if (!split) continue;

    const target = new RegExp(VARIABLE_G.source).exec(inner.slice(split.end));
    if (!target) continue;

    const expression = inner.slice(0, split.start).split(/\s+/).filter((s) => s.length > 0).join(' ');
    binds.push({
      source,
      target: target[1],
      expression,
      line: lineOf(text, match.index),
      skeleton: skeleton(expression),
    });
  }
  return binds;
}

/** One-based line number of `offset`. */
function lineOf(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset; i++) if (text[i] === '\n') line += 1;
  return line;
}

export function parseQueryFacts(source: string, rawText: string): QueryFacts {
  const text = stripComments(rawText);

  const constructVars = new Set<string>();
  const constructVarLines = new Map<string, number>();
  for (const block of blocks(text, /\bCONSTRUCT\b/)) {
    const pattern = new RegExp(VARIABLE_G.source, 'g');
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(block.body)) !== null) {
      constructVars.add(match[1]);
      if (!constructVarLines.has(match[1])) constructVarLines.set(match[1], lineOf(text, block.start + match.index));
    }
  }

  const whereVars = new Set<string>();
  for (const block of blocks(text, /\bWHERE\b/)) {
    for (const match of block.body.matchAll(new RegExp(VARIABLE_G.source, 'g'))) whereVars.add(match[1]);
  }

  const binds = extractBinds(text, source);
  const bound = new Set<string>(whereVars);
  for (const bind of binds) bound.add(bind.target);

  return { source, binds, constructVars, whereVars, bound, constructVarLines };
}

export function analyseBinds(
  queries: { source: string; text: string }[],
  constructedSuffixes: readonly string[] = DEFAULT_CONSTRUCTED_SUFFIXES,
): BindReport {
  const facts = queries.map((q) => parseQueryFacts(q.source, q.text));

  const byTarget = new Map<string, BindStatement[]>();
  for (const query of facts) {
    for (const bind of query.binds) {
      const existing = byTarget.get(bind.target);
      if (existing) existing.push(bind);
      else byTarget.set(bind.target, [bind]);
    }
  }

  const drift: DriftGroup[] = [];
  const sharedAndConsistent: { target: string; fileCount: number }[] = [];
  for (const target of [...byTarget.keys()].sort()) {
    const statements = byTarget.get(target) as BindStatement[];
    const sources = new Set(statements.map((b) => b.source));
    if (sources.size < 2) continue; // bound in one file only: nothing to compare

    const bySkeleton = new Map<string, BindStatement[]>();
    for (const bind of statements) {
      const existing = bySkeleton.get(bind.skeleton);
      if (existing) existing.push(bind);
      else bySkeleton.set(bind.skeleton, [bind]);
    }
    if (bySkeleton.size > 1) {
      const variants = [...bySkeleton.keys()].sort().map((skel) => ({ skeleton: skel, statements: bySkeleton.get(skel) as BindStatement[] }));
      const files = new Set(variants.flatMap((v) => v.statements.map((b) => b.source)));
      drift.push({ target, variants, fileCount: files.size });
    } else {
      sharedAndConsistent.push({ target, fileCount: sources.size });
    }
  }

  const unbound: UnboundVariable[] = [];
  for (const query of facts) {
    const missing = [...query.constructVars].filter((v) => !query.bound.has(v)).sort();
    for (const variable of missing) {
      unbound.push({
        source: query.source,
        variable,
        looksConstructed: constructedSuffixes.some((suffix) => variable.endsWith(suffix)),
        line: query.constructVarLines.get(variable) ?? 1,
      });
    }
  }

  return {
    queries: facts,
    drift,
    unbound,
    sharedAndConsistent,
    bindCount: facts.reduce((total, q) => total + q.binds.length, 0),
    isClean: drift.length === 0 && !unbound.some((u) => u.looksConstructed),
  };
}

/**
 * The report as the same `ResultRow` every other check reports as.
 *
 * `focusNode` is the variable rather than an IRI: these findings are about query
 * source, and there is no graph node to point at. The file goes in `path`, which
 * is what a reviewer actually needs to open next.
 */
export function bindReportToRows(report: BindReport): ResultRow[] {
  const rows: ResultRow[] = [];

  for (const group of report.drift) {
    const detail = group.variants
      .map((v) => `${v.skeleton} [${[...new Set(v.statements.map((b) => baseName(b.source)))].sort().join(', ')}]`)
      .join('; ');
    rows.push({
      checkId: 'TQL-001',
      category: 'tarql',
      title: 'Variable bound by structurally different expressions across queries',
      severity: 'Warning',
      focusNode: `?${group.target}`,
      path: [...new Set(group.variants.flatMap((v) => v.statements.map((b) => baseName(b.source))))].sort().join(', '),
      value: null,
      message:
        `?${group.target} is bound in ${group.fileCount} query files by ${group.variants.length} ` +
        `structurally different expressions: ${detail}`,
      remediation:
        'Decide which expression is correct and use it in every file, or rename the variables so the two ' +
        'are not mistaken for one another. Differing only in which variable feeds the template is fine and ' +
        'is not reported; differing in the template itself means the same conceptual node gets two different IRIs.',
      sources: ['tarql'],
    });
  }

  for (const entry of report.unbound) {
    rows.push(entry.looksConstructed
      ? {
        checkId: 'TQL-002',
        category: 'tarql',
        title: 'Constructed-IRI variable used in CONSTRUCT but never bound',
        severity: 'Violation',
        focusNode: `?${entry.variable}`,
        path: baseName(entry.source),
        value: null,
        message:
            `?${entry.variable} is used in the CONSTRUCT template of ${baseName(entry.source)} but is never ` +
            'bound by a BIND or matched in the WHERE clause. Its naming convention says it is constructed ' +
            'rather than read from a CSV column, so nothing will bind it and every triple using it is dropped.',
        remediation: 'Add the missing BIND, or correct the variable name if it should be reading a column directly.',
        sources: ['tarql'],
      }
      : {
        checkId: 'TQL-003',
        category: 'tarql',
        title: 'CONSTRUCT variable not bound in the query',
        severity: 'Info',
        focusNode: `?${entry.variable}`,
        path: baseName(entry.source),
        value: null,
        message:
            `?${entry.variable} is used in the CONSTRUCT template of ${baseName(entry.source)} but is not bound ` +
            'in the query. This is ordinarily correct -- TARQL binds each CSV header as a variable of that ' +
            'name -- so it is reported only so a reviewer can confirm the column exists.',
        remediation:
            'Check the variable against the CSV header. If there is no such column, this is a typo and the ' +
            'triple is silently dropped for every row.',
        sources: ['tarql'],
      });
  }
  return rows;
}

function baseName(filePath: string): string {
  return path.basename(filePath);
}

/**
 * A reviewer-facing rendering: what to look at, in what order, with the competing
 * expressions side by side so the judgement can be made without opening both files.
 */
export function formatBindReport(report: BindReport, showConsistent = true): string {
  const lines: string[] = [];
  const distinctTargets = new Set(report.queries.flatMap((q) => q.binds.map((b) => b.target))).size;

  lines.push('TARQL BIND review');
  lines.push('='.repeat(60));
  lines.push(
    `${report.queries.length} query file(s), ${report.bindCount} BIND statement(s), ` +
    `${distinctTargets} distinct target variable(s).`,
  );
  lines.push('');

  lines.push(`1. Variables bound differently across files (${report.drift.length})`);
  lines.push('-'.repeat(60));
  if (report.drift.length === 0) lines.push('   None. Every variable bound in more than one file uses the same pattern.');
  for (const group of report.drift) {
    lines.push(`   ?${group.target}  -- ${group.variants.length} patterns across ${group.fileCount} files`);
    for (const variant of group.variants) {
      const files = [...variant.statements]
        .sort((a, b) => a.source.localeCompare(b.source))
        .map((b) => `${baseName(b.source)}:${b.line}`)
        .join(', ');
      lines.push(`       ${variant.skeleton}`);
      lines.push(`           ${files}`);
    }
  }
  lines.push('');

  const constructed = report.unbound.filter((u) => u.looksConstructed);
  lines.push(`2. Constructed-IRI variables never bound (${constructed.length})`);
  lines.push('-'.repeat(60));
  if (constructed.length === 0) lines.push('   None.');
  for (const entry of constructed) lines.push(`   ?${entry.variable.padEnd(34)} ${baseName(entry.source)}`);
  lines.push('');

  const columns = report.unbound.filter((u) => !u.looksConstructed);
  lines.push(`3. CONSTRUCT variables not bound in the query (${columns.length})`);
  lines.push('-'.repeat(60));
  lines.push('   Expected to be CSV columns. Confirm each against its header.');
  const byFile = new Map<string, string[]>();
  for (const entry of columns) {
    const name = baseName(entry.source);
    const existing = byFile.get(name);
    if (existing) existing.push(entry.variable);
    else byFile.set(name, [entry.variable]);
  }
  for (const name of [...byFile.keys()].sort()) {
    lines.push(`   ${name}`);
    lines.push(`       ${(byFile.get(name) as string[]).sort().map((v) => `?${v}`).join(', ')}`);
  }
  if (columns.length === 0) lines.push('   None.');

  if (showConsistent && report.sharedAndConsistent.length > 0) {
    lines.push('');
    lines.push(`4. Shared and consistent (${report.sharedAndConsistent.length})`);
    lines.push('-'.repeat(60));
    lines.push('   Bound in several files, always the same way -- no action needed.');
    for (const entry of [...report.sharedAndConsistent].sort((a, b) => a.target.localeCompare(b.target))) {
      lines.push(`   ?${entry.target.padEnd(34)} ${entry.fileCount} files`);
    }
  }
  return lines.join('\n');
}
