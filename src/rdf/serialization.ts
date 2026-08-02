import * as path from 'node:path';
import type { Quad } from 'n3';
import { FORMATS, RdfFormat, ParseResult } from './formats/types';
import { parseN3Family, serializeN3Family, isN3Family } from './formats/n3Family';
import { parseRdfXml, serializeRdfXml } from './formats/rdfxml';
import { parseManchester, serializeManchester } from './formats/manchester';

export { FORMATS };
export type { RdfFormat, ParseResult };

const EXTENSION_TO_FORMAT: Record<string, RdfFormat> = {};
for (const info of Object.values(FORMATS)) {
  for (const ext of info.extensions) EXTENSION_TO_FORMAT[ext] = info.id;
}

/**
 * `.owl`/`.ttl`-adjacent files are ambiguous in the wild (Protege defaults
 * `.owl` to RDF/XML; plenty of hand-authored `.owl` files are actually
 * Turtle) -- extension mapping alone isn't reliable for `.owl`, so it's
 * resolved by content sniffing instead. Every other extension in
 * FORMATS is unambiguous and resolved directly.
 */
export function detectFormat(filePath: string, content?: string): RdfFormat | undefined {
  const ext = path.extname(filePath).toLowerCase();
  if (ext !== '.owl' && EXTENSION_TO_FORMAT[ext]) return EXTENSION_TO_FORMAT[ext];
  if (content !== undefined) return detectFormatFromContent(content);
  return ext === '.owl' ? 'turtle' : undefined; // best-effort default without content available
}

export function detectFormatFromContent(content: string): RdfFormat {
  const head = content.slice(0, 2000).trimStart();
  if (head.startsWith('<?xml') || /^<rdf:RDF[\s>]/.test(head) || /<rdf:RDF[^>]*xmlns:rdf=/.test(head)) return 'rdfxml';
  if (/^(Prefix:|Ontology:|Class:|ObjectProperty:|DataProperty:|Individual:)/m.test(head)) return 'manchester';
  // A TriG named-graph block: `<iri> {`, `prefix:localName {`, `_:blank {`, or `GRAPH <iri> {`.
  if (/(?:GRAPH\s+)?(<[^>]*>|[A-Za-z][\w-]*:[\w-]*|_:[\w-]+)\s*\{/.test(head)) return 'trig';
  // N-Triples/N-Quads are a strict subset of Turtle with no @prefix/@base and every
  // triple fully spelled out as absolute <IRI>s -- if there's no @prefix anywhere and
  // every non-blank line starts with '<' or '_:', it's N-Triples/N-Quads rather than Turtle.
  const nonBlankLines = head.split('\n').filter((l) => l.trim().length > 0);
  if (nonBlankLines.length > 0 && !/@prefix|@base|PREFIX/i.test(head) && nonBlankLines.every((l) => /^\s*(<|_:)/.test(l))) {
    const firstLine = nonBlankLines[0];
    const iriOrBlankCount = (firstLine.match(/<[^>]*>|_:[\w-]+/g) ?? []).length;
    return iriOrBlankCount >= 4 ? 'nquads' : 'ntriples';
  }
  return 'turtle';
}

export async function parseRdf(text: string, format: RdfFormat): Promise<ParseResult> {
  if (isN3Family(format)) return parseN3Family(text, format);
  if (format === 'rdfxml') return parseRdfXml(text);
  return parseManchester(text);
}

export async function serializeRdf(quads: Quad[], format: RdfFormat, prefixes: Record<string, string> = {}): Promise<string> {
  if (isN3Family(format)) return serializeN3Family(quads, format, prefixes);
  if (format === 'rdfxml') return serializeRdfXml(quads, prefixes);
  return serializeManchester(quads, prefixes);
}
