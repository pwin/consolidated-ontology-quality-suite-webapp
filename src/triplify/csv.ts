import type { CsvSample } from '../types';

/** Minimal RFC4180-ish CSV parser: quoted fields, escaped `""`, commas/newlines inside quotes. */
export function parseCsv(text: string, maxRows?: number): CsvSample {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  let i = 0;

  const pushField = () => {
    row.push(field);
    field = '';
  };
  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
  };

  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ',') {
      pushField();
      i += 1;
      continue;
    }
    if (ch === '\r') {
      i += 1;
      continue;
    }
    if (ch === '\n') {
      pushRow();
      i += 1;
      if (maxRows !== undefined && rows.length > maxRows) break;
      continue;
    }
    field += ch;
    i += 1;
  }
  if (field.length > 0 || row.length > 0) pushRow();

  const [headerRow, ...dataRows] = rows.filter((r) => !(r.length === 1 && r[0] === ''));
  const headers = headerRow ?? [];
  const limited = maxRows !== undefined ? dataRows.slice(0, maxRows) : dataRows;
  const records = limited.map((r) => {
    const record: Record<string, string> = {};
    headers.forEach((h, idx) => {
      record[h] = r[idx] ?? '';
    });
    return record;
  });
  return { headers, rows: records };
}
