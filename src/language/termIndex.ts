import * as vscode from 'vscode';
import { parseSparqlPrefixes, readOntologyDocument } from '../rdf/parseDocument';
import { buildOntologyModel, TermInfo } from '../rdf/ontologyModel';
import { expand } from '../rdf/vocab';
import { findStatementLineRange } from './statementRange';
import type { Quad } from 'n3';

export interface TermOccurrence {
  uri: vscode.Uri;
  range: vscode.Range;
  iri: string;
  /** True if this occurrence looks like a declaration (subject of `a owl:Class`/etc.), not just a usage. */
  isDeclaration: boolean;
}

/**
 * Every serialization this extension registers a language for, so the index covers
 * what the editor can open. It previously globbed only `{ttl,owl}` and `{rq,sparql}`,
 * which silently excluded TriG, N-Triples, N-Quads, Manchester and RDF/XML ontologies
 * -- and, after 0.11.1 registered them, `.tq`/`.tarql` queries too. Terms declared in
 * any of those were invisible to hover, completion, go-to-definition and rename.
 */
const ONTOLOGY_GLOB = '**/*.{ttl,owl,trig,nt,nq,nquads,omn,rdf}';
const QUERY_GLOB = '**/*.{rq,sparql,tarql,tq}';
const EXCLUDE_GLOB = '**/node_modules/**';
const MAX_INDEXED_FILES = 2000;

/**
 * How long the rebuild may hold the extension host before handing the event loop back.
 *
 * Parsing is synchronous per file, so a workspace with a few MB of Turtle used to run
 * as one uninterrupted burst -- long enough for VS Code to report the extension host
 * unresponsive. Yielding on this interval keeps the host answering pings during a cold
 * build.
 *
 * The yield is `setImmediate`, not `setTimeout(0)`: a zero timeout is clamped to the
 * platform timer granularity, which on Windows is ~15ms, and paying that per slice
 * nearly doubled a cold build in measurement. `setImmediate` runs in the check phase
 * of the current loop iteration, after the poll phase has read pending IPC from the
 * renderer -- which is the part that has to happen -- and costs nothing measurable.
 */
const YIELD_EVERY_MS = 40;

/**
 * Whether a file's syntax actually uses CURIEs as written tokens.
 *
 * `scanFileForCuries` records *source positions*, which only mean something where
 * `prefix:localName` is the surface syntax -- the Turtle family and Manchester. In
 * RDF/XML the same pattern is an XML QName in an attribute (`rdf:about=`), so
 * scanning it would invent occurrences of a term named `about` and offer them to
 * find-references and rename. Its quads are still indexed; only the text scan is
 * skipped.
 */
function hasCurieSyntax(uri: vscode.Uri): boolean {
  return !uri.fsPath.toLowerCase().endsWith('.rdf');
}
const CURIE_TOKEN = /(^|[\s(),;.[\]{}])((?:[A-Za-z][\w-]*)?):([A-Za-z_][\w-]*)/g;

/** One file's contribution to the index, reusable until the file itself changes. */
interface IndexedFile {
  /** `size:mtime`, the cheapest thing that changes whenever the content does. */
  stamp: string;
  quads: Quad[];
  occurrences: TermOccurrence[];
  /** Set when the file was over the size limit, so it is not re-reported every rebuild. */
  skipped?: boolean;
}

/**
 * Workspace-wide index of ontology-term occurrences across `.ttl` and
 * `.rq`/`.sparql` files, built by a text scan (N3 doesn't report source
 * positions for parsed quads) cross-referenced against each file's own
 * prefix map. Backs completion, hover, go-to-definition, find-references,
 * and rename -- kept as one in-process module (see the plan's judgment
 * call to skip a separate LSP process for v1) rather than four
 * independent implementations.
 */
export class TermIndex {
  private byIri = new Map<string, TermOccurrence[]>();
  private mergedQuads: Quad[] = [];
  private mergedModel = buildOntologyModel([]);
  /** The one rebuild allowed to be in flight, shared by every caller that asks meanwhile. */
  private building: Promise<void> | undefined;
  /** Set by `invalidate()`; cleared when a rebuild that accounts for it starts. */
  private stale = true;
  /** Bumped by `reset()`, so a rebuild already in flight discards its results. */
  private generation = 0;
  /** Suppresses repeat logging while the index keeps failing; cleared on the next success. */
  private reportedFailure = false;
  /**
   * Per-file parse results, surviving `invalidate()` and revalidated by stamp.
   *
   * Invalidation is coarse -- a save, a scaffold command, a quick fix -- but the work
   * it used to trigger was total: every ontology in the workspace re-read and re-parsed
   * to account for a change in one of them. A CPU profile of an unresponsive extension
   * host was 98% N3 lexing under `rebuild`, reached through a single hover. Keeping
   * each file's own result means a rebuild only pays for what actually changed.
   *
   * Keyed on size and mtime rather than content, so an unchanged file costs one `stat`
   * and no read. That also covers changes this extension never hears about -- a
   * `git checkout`, an external editor -- which a purely event-driven cache would miss.
   */
  private fileCache = new Map<string, IndexedFile>();
  /** False until the first successful rebuild, so the no-op fast path can't skip it. */
  private built = false;

  /**
   * Builds the index if it is stale, and -- the part that matters -- never starts a
   * second rebuild while one is running.
   *
   * Until 0.12.3 `invalidate()` dropped the in-flight promise, leaving that rebuild
   * running with nothing pointing at it while the next hover started another from
   * scratch. Invalidations arrive constantly in a real session -- every save, every
   * scaffold command -- and each rebuild costs a second or more, so several ran at
   * once, each holding its own copy of every quad in the workspace.
   *
   * That is what crashed the extension host at a 3.9 GB heap. The giveaway in the log
   * was mark-compact running 4.7s and freeing 2 MB: the memory was not garbage waiting
   * to be collected, it was N live indexes. Measured on a 7 MB workspace, four
   * interleaved hover/save cycles held 692 MB at once where one index costs 184 MB,
   * and a forced GC afterwards returned all of it -- confirming nothing leaked, the
   * copies were simply all reachable. Serialising rebuilds caps the live cost at one.
   *
   * A caller that joins an in-flight build gets an index that may predate the very
   * latest invalidation. That is bounded by one rebuild and resolved by the next call,
   * which is the better trade.
   */
  async ensureBuilt(): Promise<void> {
    const inFlight = this.building;
    if (inFlight) return inFlight;
    if (!this.stale) return;

    this.stale = false;
    // A failed build must not be cached: if the rejection stayed memoised, *every* later
    // hover, completion and go-to-definition would re-throw the same stale error until
    // something happened to invalidate it -- which is how one bad file turns into an
    // editor that looks permanently broken. Marking it stale again lets the next caller
    // retry; rethrowing keeps the failure visible rather than silently serving an empty
    // index.
    const build = this.rebuild().catch((err) => {
      this.stale = true;
      throw err;
    });
    this.building = build;
    try {
      await build;
    } finally {
      if (this.building === build) this.building = undefined;
    }
  }

  /**
   * `ensureBuilt` for the language providers, which must not throw at the user.
   *
   * A provider that lets an index failure escape turns one bad file into a raw
   * `ERR ...` notification on every hover, completion and go-to-definition -- which is
   * exactly how the 0.11.3 stack overflow presented. Returning false instead degrades
   * to "no hover this time", which is the honest outcome, and the failure is logged
   * once per streak rather than once per keystroke.
   */
  async ensureBuiltQuietly(): Promise<boolean> {
    try {
      await this.ensureBuilt();
      this.reportedFailure = false;
      return true;
    } catch (err) {
      if (!this.reportedFailure) {
        this.reportedFailure = true;
        console.error('[ontologySuite] term index unavailable; hover/completion/definition are degraded until it rebuilds:', err);
      }
      return false;
    }
  }

  /**
   * Marks the index stale. Per-file results are kept and revalidated by stamp on the
   * next rebuild, so invalidating costs only the files that actually changed.
   *
   * Deliberately leaves any in-flight rebuild alone -- see `ensureBuilt`.
   */
  invalidate(): void {
    this.stale = true;
  }

  /**
   * Drops everything, including cached parses -- the *Reset Index & Diagnostics* command.
   *
   * A rebuild already in flight cannot be cancelled, so the generation bump makes it
   * throw its results away rather than repopulate the cache this just cleared.
   */
  reset(): void {
    this.generation++;
    this.stale = true;
    this.fileCache.clear();
    this.built = false;
  }

  getOccurrences(iri: string): TermOccurrence[] {
    return this.byIri.get(iri) ?? [];
  }

  getModel() {
    return this.mergedModel;
  }

  private async rebuild(): Promise<void> {
    const generation = this.generation;
    const ontologyFiles = await vscode.workspace.findFiles(ONTOLOGY_GLOB, EXCLUDE_GLOB, MAX_INDEXED_FILES);
    const queryFiles = await vscode.workspace.findFiles(QUERY_GLOB, EXCLUDE_GLOB, MAX_INDEXED_FILES);

    const maxBytes = maxIndexedFileBytes();
    const next = new Map<string, IndexedFile>();
    const newlySkipped: string[] = [];
    let reparsed = 0;
    let sliceStart = Date.now();

    /** Hands the event loop back if this slice has run long enough. */
    const breathe = async (): Promise<void> => {
      if (Date.now() - sliceStart < YIELD_EVERY_MS) return;
      await new Promise((resolve) => setImmediate(resolve));
      sliceStart = Date.now();
    };

    for (const uri of ontologyFiles) {
      await breathe();
      const key = uri.toString();
      const stat = await statOf(uri);
      if (!stat) continue;
      const stamp = `${stat.size}:${stat.mtime}`;
      const hit = this.fileCache.get(key);
      if (hit && hit.stamp === stamp) {
        next.set(key, hit);
        continue;
      }
      reparsed++;
      if (stat.size > maxBytes) {
        newlySkipped.push(uri.fsPath);
        next.set(key, { stamp, quads: [], occurrences: [], skipped: true });
        continue;
      }
      const text = await readText(uri);
      if (text === undefined) continue;
      // Format-aware: the index used to assume Turtle, so a .omn or .rdf file
      // contributed nothing but parse errors even though its terms are just as real.
      const parsed = await readOntologyDocument(uri.fsPath, text);
      const declaredSubjects = new Set(parsed.quads.filter((q) => q.subject.termType === 'NamedNode').map((q) => q.subject.value));
      const occurrences = hasCurieSyntax(uri) ? scanFileForCuries(uri, text, parsed.prefixes, declaredSubjects) : [];
      next.set(key, { stamp, quads: parsed.quads, occurrences });
    }

    for (const uri of queryFiles) {
      await breathe();
      const key = uri.toString();
      const stat = await statOf(uri);
      if (!stat) continue;
      const stamp = `${stat.size}:${stat.mtime}`;
      const hit = this.fileCache.get(key);
      if (hit && hit.stamp === stamp) {
        next.set(key, hit);
        continue;
      }
      reparsed++;
      const text = await readText(uri);
      if (text === undefined) continue;
      next.set(key, { stamp, quads: [], occurrences: scanFileForCuries(uri, text, parseSparqlPrefixes(text), new Set()) });
    }

    if (newlySkipped.length > 0) {
      console.error(
        `[ontologySuite] not indexed, over ontologySuite.maxIndexedFileSizeKb (${Math.round(maxBytes / 1024)} KB) -- ` +
          `their terms will not appear in hover, completion, go-to-definition or rename: ${newlySkipped.join(', ')}`,
      );
    }

    // Nothing was reparsed and nothing disappeared, so the merged view already in hand
    // is still exactly right -- an invalidate with no underlying change costs one stat
    // per file and no more.
    // `reset()` ran while this was building, so these results describe an index the user
    // explicitly threw away. Writing them back would undo the reset.
    if (generation !== this.generation) return;

    const unchanged = reparsed === 0 && next.size === this.fileCache.size;
    this.fileCache = next;
    if (unchanged && this.built) return;

    const byIri = new Map<string, TermOccurrence[]>();
    const allQuads: Quad[] = [];
    for (const file of next.values()) {
      // Never spread into push: that makes every element a function argument, which
      // this runtime refuses at ~125k of them (see 0.11.3).
      for (const q of file.quads) allQuads.push(q);
      for (const occurrence of file.occurrences) {
        const list = byIri.get(occurrence.iri);
        if (list) list.push(occurrence);
        else byIri.set(occurrence.iri, [occurrence]);
      }
    }

    this.byIri = byIri;
    this.mergedQuads = allQuads;
    this.mergedModel = buildOntologyModel(allQuads);
    this.built = true;
  }

  getMergedQuads(): Quad[] {
    return this.mergedQuads;
  }

  lookupTerm(iri: string): TermInfo | undefined {
    return this.mergedModel.terms.get(iri);
  }
}

/**
 * Size above which a file is stat'd but not parsed.
 *
 * A multi-MB data graph is not what hover and rename are for, and parsing one costs
 * seconds of blocked extension host for terms nobody is going to look up. The default
 * is well clear of any hand-authored ontology -- gist core is under 1 MB -- and the
 * setting exists because "well clear" is a guess about someone else's project.
 */
function maxIndexedFileBytes(): number {
  const kb = vscode.workspace.getConfiguration('ontologySuite').get<number>('maxIndexedFileSizeKb', 5120);
  return Math.max(1, kb) * 1024;
}

async function statOf(uri: vscode.Uri): Promise<vscode.FileStat | undefined> {
  try {
    return await vscode.workspace.fs.stat(uri);
  } catch {
    return undefined;
  }
}

/**
 * vscode.Range-returning wrapper around language/statementRange.ts's pure line-range finder --
 * see that module for the algorithm and its documented limitations.
 */
export function findStatementRange(text: string, startLine: number): vscode.Range {
  const r = findStatementLineRange(text, startLine);
  return new vscode.Range(r.startLine, 0, r.endLine, r.endCol);
}

async function readText(uri: vscode.Uri): Promise<string | undefined> {
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    return new TextDecoder('utf-8').decode(bytes);
  } catch {
    return undefined;
  }
}

function scanFileForCuries(
  uri: vscode.Uri,
  text: string,
  prefixes: Record<string, string>,
  declarationSubjectIris: Set<string>,
): TermOccurrence[] {
  const occurrences: TermOccurrence[] = [];
  const lines = text.split(/\r?\n/);
  for (let lineNo = 0; lineNo < lines.length; lineNo++) {
    const line = lines[lineNo];
    if (line.trimStart().startsWith('#')) continue;
    CURIE_TOKEN.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = CURIE_TOKEN.exec(line))) {
      const leading = m[1];
      const prefix = m[2];
      const local = m[3];
      const curie = `${prefix}:${local}`;
      const iri = expand(curie, prefixes);
      if (!iri) continue;
      const startCol = m.index + leading.length;
      const endCol = startCol + curie.length;
      const range = new vscode.Range(lineNo, startCol, lineNo, endCol);
      const isDeclaration = declarationSubjectIris.has(iri) && startCol === line.search(/\S/);

      occurrences.push({ uri, range, iri, isDeclaration });
    }
  }
  return occurrences;
}
