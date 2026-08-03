import * as fs from 'node:fs';
import * as path from 'node:path';
import { DataFactory, Quad } from 'n3';
import type { ResultRow } from '../types';
import { localName } from './registryLoader';
import { resolveStandardsIris, ProjectStandards } from './projectStandardsCore';

/**
 * Schematron-Quick-Fix-style repair engine: each check's remediation is a
 * real SPARQL 1.1 Update template (resources/checks-registry/repairs/*.ru),
 * bridged to a specific finding via the same ResultRow shape every check
 * engine already normalizes to (focusNode/path/value), plus the resolved
 * project standards (the "$variables" a Schematron quick-fix would draw on).
 *
 * Variable contract every template may reference (all pre-bound via a single
 * injected VALUES row -- see buildRepairUpdate -- UNDEF where not applicable
 * to a given check):
 *   ?focusNode, ?path, ?value        -- from the finding's ResultRow
 *   ?derivedLabel                    -- humanized local name of ?focusNode
 *   ?defaultLanguageTag              -- ProjectStandards.defaultLanguageTag (plain string literal)
 *   ?categoryClass                   -- ProjectStandards.categoryClass, resolved to a full IRI
 *   ?defaultOntologyBaseIri          -- ProjectStandards.defaultOntologyBaseIri (IRI)
 *   ?defaultVersionInfo              -- ProjectStandards.defaultVersionInfo (plain string literal)
 */

export interface RepairManifestEntry {
  kind: 'insert' | 'replace';
  title: string;
  template?: string;
  templatesByPolicy?: Record<string, string>;
  policyStandardsKey?: keyof ProjectStandards;
}

interface RepairManifest {
  checks: Record<string, RepairManifestEntry>;
}

export interface RepairOutcome {
  checkId: string;
  kind: 'insert' | 'replace';
  title: string;
  /** Quads present after the update that weren't present before. */
  addedQuads: Quad[];
  /** Quads present before the update that are no longer present after. */
  removedQuads: Quad[];
  /** Full graph state after the update -- for 'replace'-kind fixes, which reserialize the whole document. */
  resultQuads: Quad[];
}

let manifestCache: { rootDir: string; manifest: RepairManifest } | undefined;

function loadManifest(rootDir: string): RepairManifest {
  if (manifestCache?.rootDir === rootDir) return manifestCache.manifest;
  const manifest = JSON.parse(fs.readFileSync(path.join(rootDir, 'manifest.json'), 'utf8')) as RepairManifest;
  manifestCache = { rootDir, manifest };
  return manifest;
}

/** True if a Quick Fix can be offered for this check at all (regardless of whether the current row qualifies). */
export function hasRepairTemplate(repairsRootDir: string, checkId: string): boolean {
  return loadManifest(repairsRootDir).checks[checkId] !== undefined;
}

function resolveTemplateFile(
  repairsRootDir: string,
  checkId: string,
  standards: ProjectStandards,
): { file: string; title: string; kind: 'insert' | 'replace' } | undefined {
  const entry = loadManifest(repairsRootDir).checks[checkId];
  if (!entry) return undefined;
  let templateName = entry.template;
  if (!templateName && entry.templatesByPolicy && entry.policyStandardsKey) {
    const policy = standards[entry.policyStandardsKey] as string;
    templateName = entry.templatesByPolicy[policy];
  }
  if (!templateName) return undefined;
  return { file: path.join(repairsRootDir, templateName), title: entry.title, kind: entry.kind };
}

/** Humanizes an IRI's local name for use as a fallback rdfs:label/skos:prefLabel (e.g. "hasOwner" -> "has Owner"). */
export function humanizeLocalName(iri: string): string {
  return localName(iri)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim();
}

const WHERE_BLOCK = /\bWHERE\s*\{/i;

function sparqlStringLiteral(value: string): string {
  const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
  return `"${escaped}"`;
}

function formatIriOrUndef(iri: string | null | undefined): string {
  return iri ? `<${iri}>` : 'UNDEF';
}

export function buildRepairUpdate(
  templateText: string,
  row: Pick<ResultRow, 'focusNode' | 'path' | 'value'>,
  standards: ProjectStandards,
  resolvedStandardsIris: Record<string, string>,
): string {
  const match = WHERE_BLOCK.exec(templateText);
  if (!match) throw new Error('Repair template has no WHERE clause');

  const vars = ['?focusNode', '?path', '?value', '?derivedLabel', '?defaultLanguageTag', '?categoryClass', '?defaultOntologyBaseIri', '?defaultVersionInfo'];
  const values = [
    formatIriOrUndef(row.focusNode),
    formatIriOrUndef(row.path),
    formatIriOrUndef(row.value),
    sparqlStringLiteral(humanizeLocalName(row.focusNode)),
    sparqlStringLiteral(standards.defaultLanguageTag),
    formatIriOrUndef(resolvedStandardsIris.categoryClass),
    formatIriOrUndef(resolvedStandardsIris.defaultOntologyBaseIri),
    sparqlStringLiteral(standards.defaultVersionInfo),
  ];
  const valuesClause = `VALUES (${vars.join(' ')}) {\n    (${values.join(' ')})\n  }`;

  const insertAt = match.index + match[0].length;
  return `${templateText.slice(0, insertAt)}\n  ${valuesClause}\n${templateText.slice(insertAt)}`;
}

/**
 * Runs the repair for a single finding against the document's own quads (an
 * isolated in-memory Oxigraph store, not the workspace-wide merged graph --
 * so a fix never reaches across file boundaries) and returns the resulting
 * delta. Returns undefined if the check has no repair template, or if the
 * finding's checkId is missing.
 */
export function computeRepair(
  repairsRootDir: string,
  row: Pick<ResultRow, 'checkId' | 'focusNode' | 'path' | 'value'>,
  documentQuads: Quad[],
  documentPrefixes: Record<string, string>,
  standards: ProjectStandards,
): RepairOutcome | undefined {
  if (!row.checkId) return undefined;
  const resolved = resolveTemplateFile(repairsRootDir, row.checkId, standards);
  if (!resolved) return undefined;

  const templateText = fs.readFileSync(resolved.file, 'utf8');
  const resolvedStandardsIris = resolveStandardsIris(standards, documentPrefixes);
  const updateText = buildRepairUpdate(templateText, row, standards, resolvedStandardsIris);


  const oxigraph = require('oxigraph') as typeof import('oxigraph');
  const store = new oxigraph.Store();
  for (const q of documentQuads) store.add(toOxiQuad(oxigraph, q));

  const beforeKeys = new Set(quadKeys(store.match(null, null, null, null) as OxiQuadLike[]));
  store.update(updateText);
  const afterOxiQuads = store.match(null, null, null, null) as OxiQuadLike[];
  const afterKeys = new Set(quadKeys(afterOxiQuads));

  const resultQuads = afterOxiQuads.map(fromOxiQuad);
  const addedQuads = resultQuads.filter((_, i) => !beforeKeys.has(quadKey(afterOxiQuads[i])));
  const beforeBySignature = new Map<string, Quad>();
  for (const q of documentQuads) beforeBySignature.set(`${q.subject.value}|${q.predicate.value}|${termKeyN3(q.object)}`, q);
  const removedQuads = [...beforeKeys]
    .filter((k) => !afterKeys.has(k))
    .map((k) => beforeBySignature.get(k))
    .filter((q): q is Quad => q !== undefined);

  return { checkId: row.checkId, kind: resolved.kind, title: resolved.title, addedQuads, removedQuads, resultQuads };
}

interface OxiTermLike {
  termType: string;
  value: string;
  language?: string;
  datatype?: { value: string };
}
interface OxiQuadLike {
  subject: OxiTermLike;
  predicate: OxiTermLike;
  object: OxiTermLike;
}

function quadKey(q: OxiQuadLike): string {
  return `${q.subject.value}|${q.predicate.value}|${termKeyOxi(q.object)}`;
}
function quadKeys(quads: OxiQuadLike[]): string[] {
  return quads.map(quadKey);
}
function termKeyOxi(t: OxiTermLike): string {
  if (t.termType === 'Literal') return `"${t.value}"@${t.language ?? ''}^^${t.datatype?.value ?? ''}`;
  return t.value;
}
function termKeyN3(t: Quad['object']): string {
  if (t.termType === 'Literal') {
    const lit = t as import('n3').Literal;
    return `"${lit.value}"@${lit.language ?? ''}^^${lit.datatype?.value ?? ''}`;
  }
  return t.value;
}

function toOxiQuad(oxi: typeof import('oxigraph'), q: Quad) {
  const toTerm = (term: Quad['subject'] | Quad['predicate'] | Quad['object']) => {
    switch (term.termType) {
      case 'NamedNode':
        return oxi.namedNode(term.value);
      case 'BlankNode':
        return oxi.blankNode(term.value);
      case 'Literal': {
        const lit = term as import('n3').Literal;
        return lit.language ? oxi.literal(lit.value, lit.language) : oxi.literal(lit.value, oxi.namedNode(lit.datatype.value));
      }
      default:
        return oxi.namedNode(term.value);
    }
  };
  return oxi.quad(toTerm(q.subject) as never, toTerm(q.predicate) as never, toTerm(q.object) as never);
}

function fromOxiQuad(q: OxiQuadLike): Quad {
  const toTerm = (t: OxiTermLike) => {
    switch (t.termType) {
      case 'NamedNode':
        return DataFactory.namedNode(t.value);
      case 'BlankNode':
        return DataFactory.blankNode(t.value);
      case 'Literal':
        return t.language
          ? DataFactory.literal(t.value, t.language)
          : DataFactory.literal(t.value, t.datatype ? DataFactory.namedNode(t.datatype.value) : undefined);
      default:
        return DataFactory.namedNode(t.value);
    }
  };
  return DataFactory.quad(toTerm(q.subject) as never, toTerm(q.predicate) as never, toTerm(q.object) as never);
}
