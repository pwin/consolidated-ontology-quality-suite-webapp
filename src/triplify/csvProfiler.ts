import * as path from 'node:path';
import type { CsvSample } from '../types';

export type ColumnKind = 'date' | 'integer' | 'decimal' | 'boolean' | 'enum' | 'string';

export interface ColumnProfile {
  header: string;
  kind: ColumnKind;
  distinctValues: string[];
  isLikelyKey: boolean;
  nonEmptyCount: number;
}

export interface CsvProfile {
  columns: ColumnProfile[];
  keyColumn: ColumnProfile | null;
  rowCount: number;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2})?$/;
const INTEGER_RE = /^-?\d+$/;
const DECIMAL_RE = /^-?\d+\.\d+$/;
const BOOLEAN_RE = /^(true|false|yes|no)$/i;
const ENUM_MAX_DISTINCT = 12;

/**
 * Statistical/heuristic CSV column profiler -- not ML, fully explainable.
 * Backs both "Infer Ontology + Query from CSV" and the live triplify
 * preview's column-shape awareness.
 */
export function profileCsv(sample: CsvSample): CsvProfile {
  const columns: ColumnProfile[] = sample.headers.map((header) => {
    const values = sample.rows.map((r) => r[header]).filter((v) => v !== undefined && v !== '');
    const distinct = Array.from(new Set(values));
    const kind = inferKind(values);
    const isLikelyKey =
      /(^|_)id$/i.test(header) || /Id$/.test(header) ? true : distinct.length === values.length && values.length > 1;
    return { header, kind, distinctValues: distinct.slice(0, ENUM_MAX_DISTINCT), isLikelyKey, nonEmptyCount: values.length };
  });

  const keyColumn =
    columns.find((c) => /(^|_)id$/i.test(c.header) || /Id$/.test(c.header)) ??
    columns.find((c) => c.isLikelyKey) ??
    null;

  return { columns, keyColumn, rowCount: sample.rows.length };
}

function inferKind(values: string[]): ColumnKind {
  if (values.length === 0) return 'string';
  const distinct = new Set(values);
  if (distinct.size <= ENUM_MAX_DISTINCT && distinct.size < values.length && values.length > 1) return 'enum';
  if (values.every((v) => DATE_RE.test(v))) return 'date';
  if (values.every((v) => BOOLEAN_RE.test(v))) return 'boolean';
  if (values.every((v) => INTEGER_RE.test(v))) return 'integer';
  if (values.every((v) => DECIMAL_RE.test(v) || INTEGER_RE.test(v))) return 'decimal';
  return 'string';
}

const XSD_BY_KIND: Record<ColumnKind, string> = {
  date: 'xsd:date',
  integer: 'xsd:integer',
  decimal: 'xsd:decimal',
  boolean: 'xsd:boolean',
  enum: 'xsd:string',
  string: 'xsd:string',
};

export interface DraftResult {
  ontologyFragment: string;
  constructQuery: string;
}

/**
 * Drafts a starter ontology fragment and CONSTRUCT query from a CSV
 * profile -- the "Infer-from-CSV" differentiator: attacks the actual
 * first-mile problem of both ontology authoring and TARQL-style query
 * authoring, which today both start from a blank file.
 */
export function draftFromProfile(csvFilePath: string, profile: CsvProfile, baseIri = 'https://example.org/demo/'): DraftResult {
  const className = toPascalCase(path.basename(csvFilePath, path.extname(csvFilePath)));
  const nonKeyColumns = profile.columns.filter((c) => c !== profile.keyColumn);

  const ontologyLines: string[] = [
    '@prefix ex: <' + baseIri + '> .',
    '@prefix owl: <http://www.w3.org/2002/07/owl#> .',
    '@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .',
    '@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .',
    '',
    `ex:${className} a owl:Class ;`,
    `  rdfs:label "${humanize(className)}" .`,
    '',
  ];

  for (const col of nonKeyColumns) {
    const propName = `has${toPascalCase(col.header)}`;
    if (col.kind === 'enum') {
      ontologyLines.push(
        `# ${col.header}: ${col.distinctValues.length} distinct value(s) (${col.distinctValues.slice(0, 5).join(', ')}${col.distinctValues.length > 5 ? ', …' : ''})`,
        `# -- low-cardinality; consider a gist:Category-style controlled vocabulary instead of an owl:Class per value (see MDL-003).`,
        `ex:${propName} a owl:ObjectProperty ;`,
        `  rdfs:domain ex:${className} ;`,
        `  rdfs:label "${humanize(col.header)}" .`,
        '',
      );
    } else {
      ontologyLines.push(
        `ex:${propName} a owl:DatatypeProperty ;`,
        `  rdfs:domain ex:${className} ;`,
        `  rdfs:range ${XSD_BY_KIND[col.kind]} ;`,
        `  rdfs:label "${humanize(col.header)}" .`,
        '',
      );
    }
  }

  const keyVar = profile.keyColumn?.header ?? profile.columns[0]?.header ?? 'id';
  const queryLines: string[] = [
    `PREFIX ex: <${baseIri}>`,
    'PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>',
    '',
    'CONSTRUCT {',
    `  ?entity a ex:${className} ;`,
  ];
  for (const col of nonKeyColumns) {
    const propName = `has${toPascalCase(col.header)}`;
    const varName = safeVar(col.header);
    const bound = col.kind === 'string' || col.kind === 'enum' ? `?${varName}` : `?${varName}Typed`;
    queryLines.push(`    ex:${propName} ${bound} ;`);
  }
  // Replace trailing " ;" on the last property line with " ." to close the block correctly.
  const lastIdx = queryLines.length - 1;
  queryLines[lastIdx] = queryLines[lastIdx].replace(/;\s*$/, '.');
  queryLines.push('}', 'WHERE {', `  BIND(IRI(CONCAT("${baseIri}${toCamelCase(className)}-", ?${safeVar(keyVar)})) AS ?entity)`);
  for (const col of nonKeyColumns) {
    if (col.kind === 'date') {
      queryLines.push(`  BIND(STRDT(?${safeVar(col.header)}, xsd:date) AS ?${safeVar(col.header)}Typed)`);
    } else if (col.kind === 'integer') {
      queryLines.push(`  BIND(STRDT(?${safeVar(col.header)}, xsd:integer) AS ?${safeVar(col.header)}Typed)`);
    } else if (col.kind === 'decimal') {
      queryLines.push(`  BIND(STRDT(?${safeVar(col.header)}, xsd:decimal) AS ?${safeVar(col.header)}Typed)`);
    } else if (col.kind === 'boolean') {
      queryLines.push(`  BIND(STRDT(LCASE(?${safeVar(col.header)}), xsd:boolean) AS ?${safeVar(col.header)}Typed)`);
    }
  }
  queryLines.push('}');

  return { ontologyFragment: ontologyLines.join('\n'), constructQuery: queryLines.join('\n') };
}

function toPascalCase(s: string): string {
  return s
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join('');
}
function toCamelCase(s: string): string {
  const pascal = toPascalCase(s);
  return pascal ? pascal[0].toLowerCase() + pascal.slice(1) : pascal;
}
function safeVar(header: string): string {
  const cleaned = header.replace(/[^a-zA-Z0-9_]/g, '_');
  return /^[0-9]/.test(cleaned) ? `_${cleaned}` : cleaned;
}
function humanize(s: string): string {
  return s
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim();
}
