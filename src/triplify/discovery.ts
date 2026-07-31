import * as fs from 'node:fs';
import * as path from 'node:path';

export interface TriplifyJob {
  csvPath: string;
  queryPath: string;
}

const CSV_EXTENSIONS = new Set(['.csv', '.tsv']);
const QUERY_EXTENSIONS = new Set(['.sparql', '.rq', '.tarql', '.tq']);

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

/** Finds the paired CSV or query file for a single file, using the same convention (used by the live preview). */
export function findPair(filePath: string): string | undefined {
  const dir = path.dirname(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const base = stem(filePath);
  if (CSV_EXTENSIONS.has(ext)) {
    const queryFiles = listByExtension(dir, QUERY_EXTENSIONS);
    return queryFiles.find((q) => stem(q) === base) ?? (queryFiles.length === 1 ? queryFiles[0] : undefined);
  }
  if (QUERY_EXTENSIONS.has(ext)) {
    const csvFiles = listByExtension(dir, CSV_EXTENSIONS);
    return csvFiles.find((c) => stem(c) === base) ?? (csvFiles.length === 1 ? csvFiles[0] : undefined);
  }
  return undefined;
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
