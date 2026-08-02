import { Parser, Writer, Quad } from 'n3';
import type { RdfFormat, ParseResult } from './types';

const LINE_FROM_MESSAGE = /on line (\d+)/i;

const N3_FORMAT_STRING: Record<'turtle' | 'trig' | 'ntriples' | 'nquads', string> = {
  turtle: 'text/turtle',
  trig: 'application/trig',
  ntriples: 'application/n-triples',
  nquads: 'application/n-quads',
};

/**
 * Turtle, TriG, N-Triples, and N-Quads are all handled directly by N3.js
 * (the same Turtle-family grammar, varying only in named-graph and
 * prefix-abbreviation support) -- no extra dependency needed for four of
 * the six formats.
 */
export function parseN3Family(text: string, format: 'turtle' | 'trig' | 'ntriples' | 'nquads'): ParseResult {
  const prefixes: Record<string, string> = {};
  const errors: ParseResult['errors'] = [];
  let quads: Quad[] = [];

  const parser = new Parser({ format: N3_FORMAT_STRING[format] });
  try {
    quads = parser.parse(text, undefined, (prefix, iri) => {
      prefixes[prefix] = iri.value;
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const match = LINE_FROM_MESSAGE.exec(message);
    errors.push({ message, line: match ? Number(match[1]) - 1 : 0 });
  }

  return { quads, prefixes, errors };
}

export function serializeN3Family(quads: Quad[], format: 'turtle' | 'trig' | 'ntriples' | 'nquads', prefixes: Record<string, string> = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const writer = new Writer({ format: N3_FORMAT_STRING[format], prefixes: format === 'turtle' || format === 'trig' ? prefixes : undefined });
    writer.addQuads(quads);
    writer.end((err, result) => (err ? reject(err) : resolve(result)));
  });
}

export function isN3Family(format: RdfFormat): format is 'turtle' | 'trig' | 'ntriples' | 'nquads' {
  return format === 'turtle' || format === 'trig' || format === 'ntriples' || format === 'nquads';
}
