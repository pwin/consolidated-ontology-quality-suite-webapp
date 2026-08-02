import type { TermKind } from '../rdf/ontologyModel';

export type Section = 'frame-header' | 'SubClassOf' | 'EquivalentTo' | 'Domain' | 'Range' | 'SubPropertyOf' | 'Types' | 'Annotations' | 'other';
export type FrameKind = 'Class' | 'ObjectProperty' | 'DataProperty' | 'AnnotationProperty' | 'Individual' | undefined;

const SECTION_RE = /^\s*(SubClassOf|EquivalentTo|Domain|Range|SubPropertyOf|Types|Annotations)\s*:/;
const FRAME_RE = /^(Class|ObjectProperty|DataProperty|AnnotationProperty|Individual)\s*:/;

export const EXPRESSION_KEYWORDS = ['and', 'or', 'not', 'some', 'only', 'value', 'Self', 'min', 'max', 'exactly'];

export const SECTION_KINDS: Partial<Record<Section, TermKind[]>> = {
  // A class expression can start with an atomic class OR a property immediately
  // followed by a restriction keyword ("hasOwner some Person") -- both are valid here.
  SubClassOf: ['class', 'objectProperty', 'datatypeProperty'],
  EquivalentTo: ['class', 'objectProperty', 'datatypeProperty'],
  Types: ['class', 'objectProperty', 'datatypeProperty'],
  Domain: ['class'],
  Range: ['class'],
  SubPropertyOf: ['objectProperty', 'datatypeProperty', 'annotationProperty'],
};

export const FRAME_KINDS: Record<Exclude<FrameKind, undefined>, TermKind[]> = {
  Class: ['class'],
  ObjectProperty: ['objectProperty'],
  DataProperty: ['datatypeProperty'],
  AnnotationProperty: ['annotationProperty'],
  Individual: ['individual'],
};

/**
 * Scans backward from `offset` through `fullText`'s lines to find the most
 * recent section (`SubClassOf:`/`Domain:`/...) or frame (`Class:`/...)
 * header governing the cursor. Kept dependency-free of the VS Code API
 * (unlike manchesterCompletion.ts, which wraps this for the actual
 * CompletionItemProvider) so it's testable standalone with plain Node.
 */
export function detectSection(fullText: string, offset: number): { section: Section; frameKind: FrameKind } {
  const textBeforeCursor = fullText.slice(0, offset);
  const lines = textBeforeCursor.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const text = lines[i];
    const sectionMatch = SECTION_RE.exec(text);
    if (sectionMatch) return { section: sectionMatch[1] as Section, frameKind: undefined };
    const frameMatch = FRAME_RE.exec(text.trim());
    if (frameMatch) return { section: 'frame-header', frameKind: frameMatch[1] as FrameKind };
  }
  return { section: 'other', frameKind: undefined };
}

export function parseManchesterPrefixes(text: string): Record<string, string> {
  const prefixes: Record<string, string> = {};
  const re = /^Prefix:\s*([\w-]*)\s*:\s*<([^>]+)>/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) prefixes[m[1]] = m[2];
  return prefixes;
}
