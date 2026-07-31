import { Parser, Quad } from 'n3';
import type { ParsedDocument, PrefixMap } from '../types';

const LINE_FROM_MESSAGE = /on line (\d+)/i;

/**
 * Parses a Turtle document with N3, tolerating a trailing syntax error by
 * still returning whatever quads/prefixes were read before the failure --
 * live diagnostics need a best-effort document, not an all-or-nothing parse.
 */
export function parseTurtle(uri: string, text: string): ParsedDocument {
  const prefixes: PrefixMap = {};
  const errors: { message: string; line: number }[] = [];
  let quads: Quad[] = [];

  const parser = new Parser({ format: 'text/turtle' });
  try {
    quads = parser.parse(text, undefined, (prefix, iri) => {
      prefixes[prefix] = iri.value;
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const match = LINE_FROM_MESSAGE.exec(message);
    errors.push({ message, line: match ? Number(match[1]) - 1 : 0 });
    // Fall back to a lenient line-by-line parse so the rest of the document
    // (before/after the bad line) still contributes quads/prefixes for
    // completion, hover, and the outline -- one bad line shouldn't blank
    // out diagnostics/symbols for an otherwise-valid file.
    quads = tryParseValidPrefixedLines(text, prefixes);
  }

  return { uri, text, quads, prefixes, errors };
}

function tryParseValidPrefixedLines(text: string, prefixes: PrefixMap): Quad[] {
  const prefixLines = text
    .split(/\r?\n/)
    .filter((line) => /^\s*@prefix\s/i.test(line))
    .join('\n');
  if (!prefixLines) return [];
  try {
    const parser = new Parser({ format: 'text/turtle' });
    return parser.parse(`${prefixLines}\n`, undefined, (prefix, iri) => {
      prefixes[prefix] = iri.value;
    });
  } catch {
    return [];
  }
}

/** Parses a CONSTRUCT/query file's PREFIX block only (query bodies aren't valid Turtle). */
export function parseSparqlPrefixes(text: string): PrefixMap {
  const prefixes: PrefixMap = {};
  const re = /PREFIX\s+([\w-]*)\s*:\s*<([^>]+)>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    prefixes[m[1]] = m[2];
  }
  return prefixes;
}
