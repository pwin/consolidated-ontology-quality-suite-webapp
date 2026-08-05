export interface LineRange {
  startLine: number;
  endLine: number;
  /** Column just past the terminating `.` on `endLine` (i.e. an exclusive end column). */
  endCol: number;
}

/**
 * Best-effort span of the whole Turtle statement starting at `startLine` (from the declaration's
 * own line through the line containing its terminating top-level `.`), for revealing/highlighting
 * a term's full definition rather than just the CURIE token that names it, and for splitting a
 * document into per-statement blocks (see ontology/documentSort.ts). Text-scanning heuristic,
 * kept in a vscode-free module so it can be unit-tested and reused by pure-logic callers directly
 * (language/termIndex.ts wraps this in a vscode.Range for its own callers) -- N3 doesn't report
 * source positions, so this isn't a real Turtle parser: it tracks `[`/`(` nesting depth and skips
 * `.` inside quoted string literals, but a literal string spanning multiple lines isn't tracked
 * across the line boundary. Fails open to just the declaration line if no confident terminator is
 * found within a reasonable window.
 */
export function findStatementLineRange(text: string, startLine: number): LineRange {
  const lines = text.split(/\r?\n/);
  const MAX_LINES = 200;
  let depth = 0;
  for (let lineNo = startLine; lineNo < lines.length && lineNo < startLine + MAX_LINES; lineNo++) {
    const stripped = stripStringLiteralsAndIris(lines[lineNo]);
    for (let i = 0; i < stripped.length; i++) {
      const ch = stripped[i];
      if (ch === '[' || ch === '(') depth++;
      else if (ch === ']' || ch === ')') depth = Math.max(0, depth - 1);
      else if (ch === '.' && depth === 0) {
        const prev = stripped[i - 1];
        const next = stripped[i + 1];
        const isDecimal = prev !== undefined && next !== undefined && /\d/.test(prev) && /\d/.test(next);
        if (!isDecimal) return { startLine, endLine: lineNo, endCol: i + 1 };
      }
    }
  }
  return { startLine, endLine: startLine, endCol: lines[startLine]?.length ?? 0 };
}

/**
 * Replaces the contents of quoted string literals (`"""..."""`, `"..."`, `'...'`) and
 * angle-bracketed IRIREFs (`<...>`) with spaces of the same length, so the bracket/`.` scanning
 * above doesn't get confused by punctuation inside labels/comments (e.g.
 * `"e.g. some [bracketed] text."`) or, just as easily missed, inside the IRI itself -- a bare
 * `<http://example.org/clinic>` contains a literal `.` in "example.org" that would otherwise be
 * mistaken for the statement's terminator (confirmed as a real bug: it truncated the ontology
 * header statement in examples/tutorial/clinic.ttl mid-declaration before this fix). Not
 * escape-sequence-aware beyond `\"`/`\'`; IRIREFs are matched greedily up to the next `>`, which
 * is safe since a valid Turtle IRIREF can never itself contain `>`.
 */
export function stripStringLiteralsAndIris(line: string): string {
  return line.replace(/"""[\s\S]*?"""|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|<[^>]*>/g, (m) => ' '.repeat(m.length));
}
