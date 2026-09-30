import * as fs from 'node:fs';
import * as path from 'node:path';
import { Quad } from 'n3';
import { deskolemise, skolemise, storeQuads, storeWithQuads } from '../rdf/holosStore';
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

/**
 * A single absolute IRI as `<...>`, or `UNDEF` for anything else.
 *
 * `focusNode`/`path`/`value` are not always IRIs. `path` can be a SHACL
 * property-path *expression* (`(rdfs:subClassOf)+` for LOG-001), and `value`
 * can be several values joined for one finding (`LOG-004`'s two inverses,
 * `REA-001`'s two disjoint classes) -- see sparqlRunner.ts. Wrapping either in
 * angle brackets produces a malformed IRI, and since buildRepairUpdate binds
 * every variable in one VALUES row whether the template uses it or not, a
 * single bad term makes the whole update unparseable -- breaking repairs that
 * never referenced it. So this validates rather than assuming: scheme-prefixed,
 * and free of the characters an IRI reference cannot contain.
 */
function formatIriOrUndef(iri: string | null | undefined): string {
  if (!iri) return 'UNDEF';
  const isAbsoluteIri = /^[A-Za-z][A-Za-z0-9+.-]*:/.test(iri) && !/[\s<>"{}|^`\\]/.test(iri);
  return isAbsoluteIri ? `<${iri}>` : 'UNDEF';
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


  // Skolemised across the boundary, and this is the reason the helper exists.
  //
  // holosdb takes RDF as text, and blank node labels are document-scoped: a parser may rename
  // them, and both holosdb and n3 do -- n3 even renames per Parser instance, so reading the
  // store twice gave the *same* blank node two labels and its quads looked added. That is
  // survivable where results are only reported. It is fatal here, because this function
  // diffs before against after and applyRepair writes the result back over the user's file:
  // without stable labels, every blank node in a real ontology is renamed on every repair,
  // a large spurious diff that no repair template or fixture would have caught.
  //
  // With blank nodes as IRIs the labels round-trip exactly, so the diff is plain term
  // equality and the file keeps what it had. It changes what the data means -- a skolemised
  // node answers isBlank() with false -- which is safe only because no repair template asks;
  // repairEngine.test.ts asserts that stays true.
  // Everything below this line works in skolemised space, where a blank node is an IRI and so
  // compares by value. `skolemised[i]` is `documentQuads[i]`, because skolemise maps one to
  // one in order.
  const skolemised = skolemise(documentQuads);
  const store = storeWithQuads(skolemised);
  const beforeKeys = new Set(storeQuads(store).map(quadKey));
  store.update(updateText);
  const after = storeQuads(store);
  const afterKeys = new Set(after.map(quadKey));

  // New quads are the store's, so they are the one thing that has to come back out of
  // skolemised space -- an added blank node is genuinely new and gets a fresh label.
  const addedQuads = deskolemise(after.filter((q) => !beforeKeys.has(quadKey(q))));

  // Removed quads are reported as the *document* wrote them, matched by position rather than
  // by re-serialising, so a caller showing "what this repair deletes" shows the user's own
  // terms.
  const removedQuads = documentQuads.filter((_, i) => !afterKeys.has(quadKey(skolemised[i])));

  // The document, minus what the update deleted, plus what it added -- rather than whatever
  // the store now holds, so untouched triples keep their original terms and their original
  // order and a repair's diff shows the repair.
  const removed = new Set(removedQuads);
  const resultQuads = documentQuads.filter((q) => !removed.has(q)).concat(addedQuads);

  // WASM linear memory never shrinks, so an unfreed store is heap the editor holds until it
  // exits -- once per Quick Fix applied (see 0.12.1 for the same fault in the preview path).
  // Safe to free here: every quad above is an n3 object parsed out of a document, not a
  // handle into the store.
  store.free?.();
  return { checkId: row.checkId, kind: resolved.kind, title: resolved.title, addedQuads, removedQuads, resultQuads };
}

/**
 * One quad as a comparable string.
 *
 * Both sides of the diff are quads parsed out of the *same* store dump, so a blank node's
 * label is consistent between them even though it is not the document's label. Literals
 * carry language and datatype, because `"1"` and `"1"^^xsd:integer` are different triples.
 */
function quadKey(q: Quad): string {
  return `${q.subject.value}|${q.predicate.value}|${termKeyN3(q.object)}`;
}

function termKeyN3(t: Quad['object']): string {
  if (t.termType === 'Literal') {
    const lit = t as import('n3').Literal;
    return `"${lit.value}"@${lit.language ?? ''}^^${lit.datatype?.value ?? ''}`;
  }
  return t.value;
}
