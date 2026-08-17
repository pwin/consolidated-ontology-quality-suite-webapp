import * as fs from 'node:fs';
import * as path from 'node:path';

export interface TriplifyJob {
  csvPath: string;
  queryPath: string;
}

const CSV_EXTENSIONS = new Set(['.csv', '.tsv']);
const QUERY_EXTENSIONS = new Set(['.sparql', '.rq', '.tarql', '.tq']);
/** Mirrors ontology/resolveImports.ts's DEFAULT_IMPORT_GLOB_EXTENSIONS -- kept as a
 *  local literal so this module stays dependency-free (node:fs/node:path only). */
const ONTOLOGY_EXTENSIONS = new Set(['.ttl', '.trig', '.nt', '.nq', '.turtle', '.owl', '.rdf', '.omn']);

/**
 * Ports ontology_suite/triplify/discovery.py::discover_jobs_verbose:
 * pairs a CSV named `foo.csv` with a query file whose stem is `foo`; if
 * exactly one query file exists in queriesDir with no stem match, it's
 * used as the fallback for every unmatched CSV (one CONSTRUCT query
 * applied to a whole batch of files being the common case).
 */
export function discoverJobs(csvDir: string, queriesDir: string): { jobs: TriplifyJob[]; warnings: string[] } {
  const csvFiles = listByExtension(csvDir, CSV_EXTENSIONS);
  const queryFiles = listByExtension(queriesDir, QUERY_EXTENSIONS);
  const queriesByStem = new Map<string, string>();
  for (const q of queryFiles) queriesByStem.set(stem(q), q);

  const fallbackQuery = queryFiles.length === 1 ? queryFiles[0] : undefined;
  const jobs: TriplifyJob[] = [];
  const warnings: string[] = [];

  for (const csvPath of csvFiles) {
    const queryPath = queriesByStem.get(stem(csvPath)) ?? fallbackQuery;
    if (!queryPath) {
      warnings.push(
        `No matching query for ${path.basename(csvPath)} (no query named '${stem(csvPath)}.*' and ${queryFiles.length} candidate queries in ${queriesDir}, so no single fallback applies).`,
      );
      continue;
    }
    jobs.push({ csvPath, queryPath });
  }
  return { jobs, warnings };
}

/**
 * Finds the paired CSV or query file for a single file, using the same
 * stem-matching convention as discoverJobs (used by the live preview).
 * Searches the file's own directory first, then falls back to sibling
 * directories of its parent -- e.g. a `csv/` + `queries/` split under one
 * project folder, the layout every example fixture in this repo actually
 * uses (`examples/csv/` + `examples/queries/`,
 * `examples/tutorial/csv/` + `examples/tutorial/queries/`). A same-
 * directory layout still works too; that search happens first.
 */
export function findPair(filePath: string): string | undefined {
  const dir = path.dirname(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const base = stem(filePath);
  const searchDirs = [dir, ...siblingDirs(dir)];
  const wantExtensions = CSV_EXTENSIONS.has(ext) ? QUERY_EXTENSIONS : QUERY_EXTENSIONS.has(ext) ? CSV_EXTENSIONS : undefined;
  if (!wantExtensions) return undefined;

  const allCandidates: string[] = [];
  for (const searchDir of searchDirs) {
    const candidates = listByExtension(searchDir, wantExtensions);
    const stemMatch = candidates.find((c) => stem(c) === base);
    if (stemMatch) return stemMatch;
    allCandidates.push(...candidates);
  }
  return allCandidates.length === 1 ? allCandidates[0] : undefined;
}

/**
 * Every ontology a query should be checked against, in the order they were found.
 *
 * The Python suite takes these explicitly -- `--ontology` is `required=True` and
 * `action="append"`, so it never guesses and it accepts several. This extension has
 * to infer them, so it looks where the project layouts in this repo actually put
 * them, and returns *all* of them rather than one: an extension ontology plus the
 * upper ontology it builds on is the normal case, not an edge case.
 *
 * Search order, first non-empty directory wins:
 *   1. the query's own directory  -- a flat project
 *   2. its parent                -- `queries/foo.rq` beside `../clinic.ttl`, which is
 *                                   exactly `examples/tutorial`'s layout and was found
 *                                   by nothing before this
 *   3. its sibling directories   -- an `ontology/` beside `queries/`
 *
 * Stopping at the first directory that yields anything is deliberate: collecting
 * across all three would drag unrelated ontologies from elsewhere in the project
 * into the conformance check, and a spurious "undeclared property" is worse than a
 * missing one. `queryOntologyPaths` is the escape hatch when the guess is wrong.
 */
export function findOntologies(queryPath: string): string[] {
  const dir = path.dirname(queryPath);
  for (const searchDir of [dir, path.dirname(dir), ...siblingDirs(dir)]) {
    const found = listByExtension(searchDir, ONTOLOGY_EXTENSIONS);
    if (found.length > 0) return found;
  }
  return [];
}

/** Characters that make an entry a pattern rather than a literal path. */
const GLOB_METACHARACTERS = /[*?[]/;

/**
 * Resolves `queryOntologyPaths` entries -- literal paths, glob patterns, or a mix
 * -- into concrete file paths, relative entries taken against `baseDir`.
 *
 * A literal entry passes straight through **without checking it exists**, which
 * is deliberate: a mistyped path then surfaces as a read error naming the file,
 * rather than vanishing silently as "no ontology found". A pattern that matches
 * nothing, by contrast, contributes nothing -- there is no single path to blame,
 * and `*_ontology.ttl` matching none is a normal state for a project that has not
 * written one yet.
 *
 * Supports `*` (any run within one path segment), `?` (one character) and `**`
 * (any depth of directories). Matching is case-insensitive, since the extension
 * targets Windows and macOS as much as Linux, and results are sorted so a run
 * over one project is reproducible.
 */
export function resolveOntologyPatterns(entries: string[], baseDir: string): string[] {
  const out: string[] = [];
  for (const entry of entries) {
    const resolved = path.isAbsolute(entry) ? entry : path.join(baseDir, entry);
    if (!GLOB_METACHARACTERS.test(entry)) {
      out.push(resolved);
      continue;
    }
    out.push(...expandGlob(resolved));
  }
  // Distinct, because a literal and a pattern can name the same file, and the
  // conformance check should not read one ontology twice.
  return [...new Set(out)];
}

/** Expands one absolute glob pattern by walking from its deepest fixed ancestor. */
function expandGlob(pattern: string): string[] {
  const normalised = pattern.replace(/\\/g, '/');
  // Walk from the last directory before the first wildcard, so `a/b/**/ *.ttl`
  // never scans above `a/b`.
  const firstGlob = normalised.search(GLOB_METACHARACTERS);
  const rootEnd = normalised.lastIndexOf('/', firstGlob);
  const root = rootEnd <= 0 ? normalised.slice(0, firstGlob) : normalised.slice(0, rootEnd);
  const recursive = normalised.includes('**');

  const matcher = globToRegExp(normalised);
  return walkFiles(root, recursive)
    .filter((file) => matcher.test(file.replace(/\\/g, '/')))
    .sort();
}

/**
 * A glob as an anchored, case-insensitive regular expression. `**` is handled
 * before `*` so the two do not collide, and `**` followed by a separator also
 * matches *zero* directories -- `a/**` + `/x.ttl` should find `a/x.ttl`, which is
 * what someone writing that pattern means.
 */
function globToRegExp(pattern: string): RegExp {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        if (pattern[i + 2] === '/') {
          out += '(?:[^/]*/)*';
          i += 2;
        } else {
          out += '.*';
          i += 1;
        }
      } else {
        out += '[^/]*';
      }
    } else if (c === '?') {
      out += '[^/]';
    } else {
      out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${out}$`, 'i');
}

/** Every file under `dir`, one level deep unless `recursive`. Bounded so a symlink loop cannot spin. */
function walkFiles(dir: string, recursive: boolean, depth = 0): string[] {
  if (depth > 12) return [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isFile()) out.push(full);
    else if (recursive && e.isDirectory()) out.push(...walkFiles(full, true, depth + 1));
  }
  return out;
}

/** Direct sibling directories of `dir`'s parent, excluding `dir` itself. */
function siblingDirs(dir: string): string[] {
  const parent = path.dirname(dir);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(parent, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.filter((e) => e.isDirectory() && path.join(parent, e.name) !== dir).map((e) => path.join(parent, e.name));
}

function stem(filePath: string): string {
  return path.basename(filePath, path.extname(filePath));
}

function listByExtension(dir: string, extensions: Set<string>): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && extensions.has(path.extname(e.name).toLowerCase()))
    .map((e) => path.join(dir, e.name))
    .sort();
}
