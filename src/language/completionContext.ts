import { expand } from '../rdf/vocab';
import { RDF_TYPE, RDFS_SUBCLASS_OF, RDFS_SUBPROPERTY_OF, RDFS_DOMAIN, RDFS_RANGE, OWL_EQUIVALENT_CLASS, OWL_INVERSE_OF } from '../rdf/vocab';
import type { TermKind } from '../rdf/ontologyModel';

export type Slot = 'subject' | 'predicate' | 'object' | 'unknown';

export interface PositionContext {
  slot: Slot;
  /** Resolved full IRI of the predicate governing an 'object' slot, when determinable. */
  governingPredicate?: string;
}

const PROPERTY_KINDS: TermKind[] = ['objectProperty', 'datatypeProperty', 'annotationProperty'];

/**
 * Heuristic Turtle/SPARQL-triple-pattern position detector: is the cursor
 * about to complete a subject, predicate, or object? Deliberately
 * lightweight (whitespace/punctuation scanning, not a real parser) --
 * doesn't specially handle nested `[ ... ]` blank-node property lists
 * (their contents are scanned like flat text, which can occasionally
 * misattribute the governing predicate inside a nested list). Fails open:
 * anything it can't confidently classify returns 'unknown', which callers
 * treat as "don't filter" rather than risk hiding a valid completion.
 */
export function detectPosition(textBeforeCursor: string): PositionContext {
  // Strip the in-progress partial token being typed right now (what triggered completion in
  // the first place) -- it isn't a completed token yet, and counting it as one throws off every
  // token-count branch below (e.g. "typing 'ex:' at the very start" would otherwise look like
  // one *completed* token, misread as "subject already typed, now in predicate slot").
  const withoutPartialToken = textBeforeCursor.replace(/[^\s]*$/, '');
  const masked = maskStringsAndIris(withoutPartialToken);
  const fragment = afterLastTopLevel(masked, '.');
  const semiIndex = lastTopLevelIndex(fragment, ';');
  const lastSemiGroup = semiIndex >= 0 ? fragment.slice(semiIndex + 1) : fragment;
  const hadPriorSemi = semiIndex >= 0;

  const commaIndex = lastTopLevelIndex(lastSemiGroup, ',');
  const inLaterCommaPart = commaIndex >= 0;
  const currentPart = inLaterCommaPart ? lastSemiGroup.slice(commaIndex + 1) : lastSemiGroup;

  const completeTokens = tokenize(currentPart);

  if (inLaterCommaPart) {
    // "<predicate> <obj1>, <obj2>, ..." (or "<subj> <predicate> <obj1>, ..." for the first group) --
    // either way, we're past the predicate already; recover it from the first comma-part.
    const firstCommaPart = lastSemiGroup.slice(0, commaIndex);
    const firstTokens = tokenize(firstCommaPart);
    const predicateToken = hadPriorSemi ? firstTokens[0] : firstTokens[1];
    return { slot: 'object', governingPredicate: predicateToken };
  }

  if (!hadPriorSemi) {
    // First predicate-object group of the statement: 0 tokens => subject, 1 => predicate, 2+ => object.
    if (completeTokens.length === 0) return { slot: 'subject' };
    if (completeTokens.length === 1) return { slot: 'predicate' };
    return { slot: 'object', governingPredicate: completeTokens[1] };
  }

  // A later predicate-object group (after ';'): 0 tokens => new predicate, 1+ => object.
  if (completeTokens.length === 0) return { slot: 'predicate' };
  return { slot: 'object', governingPredicate: completeTokens[0] };
}

/** Maps a detected position to which term kinds are valid there, or `null` for "don't filter". */
export function expectedKinds(context: PositionContext, prefixes: Record<string, string>): TermKind[] | null {
  if (context.slot === 'predicate') return PROPERTY_KINDS;
  if (context.slot !== 'object') return null;

  const pred = context.governingPredicate;
  if (!pred) return null;
  const resolved = pred === 'a' ? RDF_TYPE : resolveToken(pred, prefixes);
  if (!resolved) return null;

  if (resolved === RDF_TYPE) return ['class'];
  if ([RDFS_SUBCLASS_OF, OWL_EQUIVALENT_CLASS, RDFS_DOMAIN, RDFS_RANGE].includes(resolved)) return ['class'];
  if ([RDFS_SUBPROPERTY_OF, OWL_INVERSE_OF].includes(resolved)) return PROPERTY_KINDS;
  return null; // datatype-property objects are literals (not CURIE-completable); unknown/object-property objects are usually individuals but we stay permissive
}

function resolveToken(token: string, prefixes: Record<string, string>): string | undefined {
  if (token.startsWith('<') && token.endsWith('>')) return token.slice(1, -1);
  return expand(token, prefixes) ?? undefined;
}

function tokenize(s: string): string[] {
  return s
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

/** Replaces `<...>` IRIs and quoted string content with same-length placeholders so their punctuation can't be mistaken for statement structure. */
function maskStringsAndIris(text: string): string {
  return text
    .replace(/<[^>]*>/g, (m) => 'I'.repeat(m.length))
    .replace(/"""[\s\S]*?"""/g, (m) => 'S'.repeat(m.length))
    .replace(/"(?:[^"\\]|\\.)*"/g, (m) => 'S'.repeat(m.length))
    .replace(/'(?:[^'\\]|\\.)*'/g, (m) => 'S'.repeat(m.length));
}

function lastTopLevelIndex(text: string, ch: '.' | ';' | ','): number {
  // Not bracket-depth-aware (see the module doc comment); finds the last occurrence
  // of `ch` that isn't part of a decimal number (for '.') scanning the masked text.
  for (let i = text.length - 1; i >= 0; i--) {
    if (text[i] !== ch) continue;
    if (ch === '.' && /\d/.test(text[i - 1] ?? '') && /\d/.test(text[i + 1] ?? '')) continue; // decimal point
    return i;
  }
  return -1;
}

function afterLastTopLevel(text: string, ch: '.'): string {
  const idx = lastTopLevelIndex(text, ch);
  return idx >= 0 ? text.slice(idx + 1) : text;
}
