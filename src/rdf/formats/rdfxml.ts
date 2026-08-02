import { Readable } from 'node:stream';
import type { Quad, NamedNode, Literal } from 'n3';
import type { ParseResult } from './types';

const RDF_NS = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';

/** Reads RDF/XML via `rdfxml-streaming-parser` (no RDF/JS RDF/XML serializer exists on npm, only this parser). */
export async function parseRdfXml(text: string): Promise<ParseResult> {
  const { RdfXmlParser } = await import('rdfxml-streaming-parser');
  const prefixes: Record<string, string> = {};
  const quads: Quad[] = [];
  const errors: ParseResult['errors'] = [];

  await new Promise<void>((resolve) => {
    const parser = new RdfXmlParser();
    Readable.from([text])
      .pipe(parser)
      .on('data', (q: Quad) => quads.push(q))
      .on('prefix', (prefix: string, iri: NamedNode) => {
        prefixes[prefix] = iri.value;
      })
      .on('error', (err: Error) => {
        errors.push({ message: err.message, line: 0 });
        resolve();
      })
      .on('end', () => resolve());
  });

  return { quads, prefixes, errors };
}

/**
 * Hand-written RDF/XML writer -- no `@rdfjs/serializer-rdfxml` (or
 * equivalent) exists on npm; `rdf-serialize` (the closest "universal"
 * serializer found) only wires up JSON-LD/Turtle-family/SHACL-Compact
 * actors, no RDF/XML. Deliberately simple/"flat" output (one
 * `rdf:Description` per subject, no abbreviated `rdf:parseType="Resource"`
 * nesting) -- valid and re-parseable, not the most compact form.
 */
export function serializeRdfXml(quads: Quad[], prefixes: Record<string, string> = {}): string {
  const byNamespace = new Map<string, string>(); // namespace -> prefix
  for (const [prefix, ns] of Object.entries(prefixes)) {
    if (prefix) byNamespace.set(ns, prefix);
  }
  let autoCounter = 0;
  const ensurePrefix = (namespace: string): string => {
    let prefix = byNamespace.get(namespace);
    if (!prefix) {
      prefix = `ns${autoCounter++}`;
      byNamespace.set(namespace, prefix);
    }
    return prefix;
  };
  const qname = (iri: string): string => {
    const splitAt = Math.max(iri.lastIndexOf('#'), iri.lastIndexOf('/'));
    if (splitAt <= 0) return `rdf:_unqualified_${escapeXmlAttr(iri)}`;
    const namespace = iri.slice(0, splitAt + 1);
    const local = iri.slice(splitAt + 1);
    if (!/^[A-Za-z_][\w.-]*$/.test(local)) return `rdf:_unqualified_${escapeXmlAttr(iri)}`;
    return `${ensurePrefix(namespace)}:${local}`;
  };

  const bySubject = new Map<string, Quad[]>();
  for (const q of quads) {
    const key = q.subject.termType === 'BlankNode' ? `_:${q.subject.value}` : q.subject.value;
    if (!bySubject.has(key)) bySubject.set(key, []);
    bySubject.get(key)!.push(q);
  }

  // Predicate QNames must be resolved before the header is written (namespaces are auto-minted on demand).
  const bodyParts: string[] = [];
  for (const [subjectKey, subjectQuads] of bySubject) {
    const isBlank = subjectKey.startsWith('_:');
    const aboutAttr = isBlank ? `rdf:nodeID="${escapeXmlAttr(subjectKey.slice(2))}"` : `rdf:about="${escapeXmlAttr(subjectKey)}"`;
    const propertyElements = subjectQuads
      .map((q) => {
        const pred = qname(q.predicate.value);
        if (q.object.termType === 'NamedNode') {
          return `    <${pred} rdf:resource="${escapeXmlAttr(q.object.value)}"/>`;
        }
        if (q.object.termType === 'BlankNode') {
          return `    <${pred} rdf:nodeID="${escapeXmlAttr(q.object.value)}"/>`;
        }
        const lit = q.object as Literal;
        const langAttr = lit.language ? ` xml:lang="${escapeXmlAttr(lit.language)}"` : '';
        const dtAttr = !lit.language && lit.datatype && lit.datatype.value !== 'http://www.w3.org/2001/XMLSchema#string' ? ` rdf:datatype="${escapeXmlAttr(lit.datatype.value)}"` : '';
        return `    <${pred}${langAttr}${dtAttr}>${escapeXmlText(lit.value)}</${pred}>`;
      })
      .join('\n');
    bodyParts.push(`  <rdf:Description ${aboutAttr}>\n${propertyElements}\n  </rdf:Description>`);
  }

  const namespaceDecls = [...byNamespace.entries()]
    .map(([ns, prefix]) => `xmlns:${prefix}="${escapeXmlAttr(ns)}"`)
    .join('\n  ');

  return `<?xml version="1.0" encoding="UTF-8"?>\n<rdf:RDF\n  xmlns:rdf="${RDF_NS}"\n  ${namespaceDecls}>\n${bodyParts.join('\n')}\n</rdf:RDF>\n`;
}

function escapeXmlText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escapeXmlAttr(s: string): string {
  return escapeXmlText(s).replace(/"/g, '&quot;');
}
