/**
 * Ports ontology_suite/sketch/tarql_visualiser.py: turns a TARQL/oxi-gen
 * CONSTRUCT query's template into a Turtle "sketch" of the graph shape it
 * builds, without running it (no CSV, no SPARQL engine) -- every
 * `?variable` becomes a `:variable` entity in a scratch namespace, so the
 * template reads directly as valid-shaped Turtle.
 */
const PREFIX_LINE_PATTERN = /^\s*PREFIX\s+(\w*)\s*:\s*<([^>]*)>/gim;
const CONSTRUCT_KEYWORD_PATTERN = /\bCONSTRUCT\b/gi;
const VARIABLE_PATTERN = /\?(\w+)/g;

export interface QuerySketch {
  prefixes: Record<string, string>;
  triples: string;
}

export function extractPrefixes(text: string): Record<string, string> {
  const prefixes: Record<string, string> = {};
  let m: RegExpExecArray | null;
  PREFIX_LINE_PATTERN.lastIndex = 0;
  while ((m = PREFIX_LINE_PATTERN.exec(text))) {
    prefixes[m[1]] = m[2];
  }
  return prefixes;
}

function findMatchingBrace(text: string, openIndex: number): number {
  let depth = 0;
  for (let i = openIndex; i < text.length; i++) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  throw new Error('Unbalanced braces in CONSTRUCT clause');
}

export function extractConstructBlocks(text: string): string[] {
  const blocks: string[] = [];
  CONSTRUCT_KEYWORD_PATTERN.lastIndex = 0;
  let kw: RegExpExecArray | null;
  while ((kw = CONSTRUCT_KEYWORD_PATTERN.exec(text))) {
    const braceStart = text.indexOf('{', kw.index + kw[0].length);
    if (braceStart === -1) continue;
    let braceEnd: number;
    try {
      braceEnd = findMatchingBrace(text, braceStart);
    } catch {
      continue;
    }
    blocks.push(text.slice(braceStart + 1, braceEnd));
    CONSTRUCT_KEYWORD_PATTERN.lastIndex = braceEnd + 1;
  }
  return blocks;
}

export function variablesToEntities(constructText: string): string {
  return constructText.replace(VARIABLE_PATTERN, ':$1');
}

export function sketchQuery(text: string): QuerySketch {
  const prefixes = extractPrefixes(text);
  const blocks = extractConstructBlocks(text);
  const triples = blocks
    .map((b) => variablesToEntities(b).trim())
    .filter((b) => b.length > 0)
    .join('\n');
  return { prefixes, triples };
}

/** Renders a QuerySketch (optionally several, merged) as a standalone Turtle document. */
export function renderSketchTurtle(sketches: QuerySketch[], base = 'http://ontology-dev-suite.local/sketch/'): string {
  const mergedPrefixes: Record<string, string> = {};
  for (const s of sketches) {
    for (const [name, iri] of Object.entries(s.prefixes)) {
      if (!(name in mergedPrefixes)) mergedPrefixes[name] = iri;
    }
  }

  const lines: string[] = [];
  for (const [name, iri] of Object.entries(mergedPrefixes)) {
    lines.push(`@prefix ${name}: <${iri}> .`);
  }
  lines.push(`@base <${base}> .`);
  if (!('' in mergedPrefixes)) lines.push('@prefix : <#> .');
  lines.push('');

  for (const s of sketches) {
    if (!s.triples) continue;
    lines.push(s.triples, '');
  }
  return lines.join('\n');
}
