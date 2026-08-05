import type { Quad } from 'n3';
import { buildOntologyModel, TermKind } from '../rdf/ontologyModel';
import { expand } from '../rdf/vocab';
import { findStatementLineRange } from '../language/statementRange';

export type SortStrategy = 'alphabetical' | 'byType';

export interface DocumentBlock {
  /** Comment lines immediately preceding the statement (no blank line in between), verbatim. */
  attachedLines: string[];
  /** The statement itself, verbatim, from its first line through its terminating `.`. */
  statementLines: string[];
  /** Resolved IRI of the statement's leading subject token, or undefined if it couldn't be identified (e.g. an anonymous blank-node-headed statement). */
  subjectIri: string | undefined;
}

export interface SplitDocument {
  /** `@prefix`/`@base` declaration lines, in original order. */
  prefixLines: string[];
  /** Comment lines that were separated from the following statement by a blank line -- treated
   *  as a floating file-level preamble (e.g. a license/description header) rather than attached
   *  to whatever statement happens to sort first; pinned right after the prefixes. */
  preambleComments: string[];
  blocks: DocumentBlock[];
  /** Comment lines left over at end-of-file with no following statement. */
  trailingComments: string[];
}

const PREFIX_LINE = /^\s*(@prefix|@base|PREFIX|BASE)\b/i;
const LEADING_IRI = /^<([^>]*)>/;
const LEADING_CURIE = /^([A-Za-z][\w-]*)?:([A-Za-z_][\w-]*)/;

const KIND_ORDER: Record<TermKind | 'other', number> = {
  ontology: 0,
  class: 1,
  objectProperty: 2,
  datatypeProperty: 3,
  annotationProperty: 4,
  individual: 5,
  other: 6,
};

/**
 * Splits a Turtle document's text into `@prefix`/`@base` declarations, a floating preamble (any
 * comment separated from the next statement by a blank line), and one block per top-level
 * statement -- each block keeping its own directly-attached leading comment (if any) and its full
 * original text verbatim, so nothing is reformatted and no comment is lost. This is the basis for
 * Sort Document / Clean Document: reordering `blocks` and reassembling never touches statement
 * text itself, only where each block sits.
 *
 * Text-scanning heuristic (like language/termIndex.ts and language/statementRange.ts, which this
 * reuses for finding each statement's end): assumes the convention already relied on elsewhere in
 * this project that a statement's subject starts flush-left at column 0. Scoped to Turtle only --
 * TriG's `GRAPH <iri> { ... }` blocks aren't `.`-terminated the way a plain statement is, so this
 * would misparse them; callers should only invoke this for `.ttl`/`turtle`-language documents.
 */
export function splitDocumentIntoBlocks(text: string, prefixes: Record<string, string>): SplitDocument {
  const lines = text.split(/\r?\n/);
  const prefixLines: string[] = [];
  const preambleComments: string[] = [];
  const blocks: DocumentBlock[] = [];
  let pending: string[] = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed === '') {
      pending.push(line);
      i++;
      continue;
    }
    if (trimmed.startsWith('#')) {
      pending.push(line);
      i++;
      continue;
    }
    if (PREFIX_LINE.test(line)) {
      prefixLines.push(...filterCommentsOnly(pending), line);
      pending = [];
      i++;
      continue;
    }

    const range = findStatementLineRange(text, i);
    const { attached, detached } = splitPending(pending);
    preambleComments.push(...detached);
    blocks.push({
      attachedLines: attached,
      statementLines: lines.slice(i, range.endLine + 1),
      subjectIri: extractLeadingSubject(line, prefixes),
    });
    pending = [];
    i = range.endLine + 1;
  }

  return { prefixLines, preambleComments, blocks, trailingComments: filterCommentsOnly(pending) };
}

/**
 * Splits a run of pending blank/comment lines into the trailing comment run immediately touching
 * the next statement (attached, moves with it) vs. everything before that. Only comment *content*
 * from the detached portion is kept (as preamble) -- detached blank lines are pure spacing that
 * reassembly recreates on its own, so dropping them loses nothing.
 */
function splitPending(pending: string[]): { attached: string[]; detached: string[] } {
  let cut = pending.length;
  while (cut > 0 && pending[cut - 1].trim().startsWith('#')) cut--;
  return { attached: pending.slice(cut), detached: filterCommentsOnly(pending.slice(0, cut)) };
}

function filterCommentsOnly(lines: string[]): string[] {
  return lines.filter((l) => l.trim().startsWith('#'));
}

function extractLeadingSubject(line: string, prefixes: Record<string, string>): string | undefined {
  const trimmed = line.trimStart();
  const iriMatch = trimmed.match(LEADING_IRI);
  if (iriMatch) return iriMatch[1];
  const curieMatch = trimmed.match(LEADING_CURIE);
  if (curieMatch) return expand(`${curieMatch[1] ?? ''}:${curieMatch[2]}`, prefixes) ?? undefined;
  return undefined;
}

/**
 * Sorts a split document's blocks. `docQuads` (this document's own parsed quads -- not merged
 * with imports, since sort/clean operates on one file) is used to look up each block's subject's
 * kind for `'byType'`, via the *whole-document* model rather than reparsing each block in
 * isolation -- so a block that only adds supplementary triples to a subject declared `a owl:Class`
 * elsewhere in the same document still groups correctly.
 */
export function sortBlocks(blocks: DocumentBlock[], strategy: SortStrategy, docQuads: Quad[]): DocumentBlock[] {
  const docModel = buildOntologyModel(docQuads);
  return blocks
    .map((block, index) => ({ block, index }))
    .sort((x, y) => {
      if (strategy === 'byType') {
        const kindDiff = KIND_ORDER[kindOf(x.block.subjectIri, docModel)] - KIND_ORDER[kindOf(y.block.subjectIri, docModel)];
        if (kindDiff !== 0) return kindDiff;
      }
      const nameDiff = sortKey(x.block.subjectIri).localeCompare(sortKey(y.block.subjectIri));
      if (nameDiff !== 0) return nameDiff;
      return x.index - y.index; // stable tie-break for blocks with no distinguishable subject
    })
    .map((x) => x.block);
}

function kindOf(subjectIri: string | undefined, docModel: ReturnType<typeof buildOntologyModel>): TermKind | 'other' {
  if (!subjectIri) return 'other';
  // buildOntologyModel records the ontology subject in its own `ontologyIri` field, not in
  // `kinds` (confirmed by reading rdf/ontologyModel.ts's `a owl:Ontology` branch) -- checked
  // first since a term's `kinds` array can never contain 'ontology' to match against below.
  if (subjectIri === docModel.ontologyIri) return 'ontology';
  const kinds = docModel.terms.get(subjectIri)?.kinds ?? [];
  const priority: TermKind[] = ['class', 'objectProperty', 'datatypeProperty', 'annotationProperty', 'individual'];
  return priority.find((k) => kinds.includes(k)) ?? 'other';
}

function sortKey(iri: string | undefined): string {
  if (!iri) return '￿'; // sorts after every identifiable subject
  const idx = Math.max(iri.lastIndexOf('#'), iri.lastIndexOf('/'));
  return (idx >= 0 ? iri.slice(idx + 1) : iri).toLowerCase();
}

/**
 * Removes `@prefix` declarations that are never referenced (as `prefix:`) anywhere in `bodyText`.
 * `@base` declarations are always kept -- nothing in this module tracks relative-IRI usage.
 * `bodyText` must be the document's statement/comment text *excluding* the prefix lines
 * themselves (otherwise a declaration would trivially "reference" its own prefix).
 */
export function removeUnusedPrefixDeclarations(prefixLines: string[], bodyText: string): string[] {
  return prefixLines.filter((line) => {
    const m = line.match(/^\s*@prefix\s+([A-Za-z][\w-]*)?:/i);
    if (!m) return true;
    const prefix = (m[1] ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const usagePattern = new RegExp(`(^|[\\s(),;.\\[\\]{}])${prefix}:[A-Za-z_]`);
    return usagePattern.test(bodyText);
  });
}

/** Joins a split document's parts back into text: prefixes, then the preamble (if any), then each
 *  block (its attached comment immediately above its statement), then any trailing comments. */
export function reassembleDocument(split: Pick<SplitDocument, 'prefixLines' | 'preambleComments' | 'trailingComments'>, sortedBlocks: DocumentBlock[]): string {
  const sections: string[] = [];
  if (split.prefixLines.length > 0) sections.push(split.prefixLines.join('\n'));
  if (split.preambleComments.length > 0) sections.push(split.preambleComments.join('\n'));
  for (const block of sortedBlocks) sections.push([...block.attachedLines, ...block.statementLines].join('\n'));
  if (split.trailingComments.length > 0) sections.push(split.trailingComments.join('\n'));
  return `${sections.join('\n\n')}\n`;
}

export interface OrganizeOptions {
  removeUnusedPrefixes: boolean;
  sortStrategy: SortStrategy | 'none';
}

/** Top-level entry point combining split -> (optional unused-prefix removal) -> (optional sort) -> reassemble. */
export function organizeDocument(text: string, prefixes: Record<string, string>, docQuads: Quad[], options: OrganizeOptions): string {
  const split = splitDocumentIntoBlocks(text, prefixes);
  const bodyText = [
    ...split.preambleComments,
    ...split.blocks.flatMap((b) => [...b.attachedLines, ...b.statementLines]),
    ...split.trailingComments,
  ].join('\n');

  const prefixLines = options.removeUnusedPrefixes ? removeUnusedPrefixDeclarations(split.prefixLines, bodyText) : split.prefixLines;
  const sortedBlocks = options.sortStrategy === 'none' ? split.blocks : sortBlocks(split.blocks, options.sortStrategy, docQuads);

  return reassembleDocument({ ...split, prefixLines }, sortedBlocks);
}
