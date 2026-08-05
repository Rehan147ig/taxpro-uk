import { BadRequestError } from '../../lib/errors.js';

/**
 * RFC 4180 CSV parser.
 *
 * Handles quoted fields (embedded commas, line breaks, escaped double
 * quotes ""), CRLF / LF line endings, a UTF-8 BOM, and tracks the
 * physical line number of every data row so validation messages and
 * audit events can point at the exact source line.
 */

export interface ParsedCsvRow {
  values: string[];
  lineNumber: number;
}

export interface ParsedCsv {
  headers: string[];
  rows: ParsedCsvRow[];
}

export function parseCsv(
  text: string,
  options: { maxBytes: number; maxRows: number } = { maxBytes: 10 * 1024 * 1024, maxRows: 20_000 },
): ParsedCsv {
  if (Buffer.byteLength(text, 'utf8') > options.maxBytes) {
    throw new BadRequestError(`CSV payload exceeds the ${options.maxBytes / 1024 / 1024}MB limit`);
  }

  const clean = text.replace(/^\uFEFF/, '');
  const records: string[][] = [];
  let field = '';
  let record: string[] = [];
  let inQuotes = false;
  let physicalLine = 1;
  const firstLineOfRecord: number[] = [1];
  let i = 0;

  const pushField = () => {
    record.push(field);
    field = '';
  };

  const pushRecord = () => {
    pushField();
    records.push(record);
    record = [];
  };

  while (i < clean.length) {
    const char = clean[i];
    const next = clean[i + 1];

    if (inQuotes) {
      if (char === '"' && next === '"') {
        field += '"';
        i += 2;
        continue;
      }
      if (char === '"') {
        inQuotes = false;
        i++;
        continue;
      }
      if (char === '\r' || char === '\n') {
        if (char === '\r' && next === '\n') i++;
        physicalLine++;
      }
      field += char;
      i++;
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (char === ',') {
      pushField();
      i++;
      continue;
    }
    if (char === '\n') {
      pushRecord();
      firstLineOfRecord.push(physicalLine + 1);
      physicalLine++;
      i++;
      continue;
    }
    if (char === '\r') {
      if (next === '\n') i++;
      pushRecord();
      firstLineOfRecord.push(physicalLine + 1);
      physicalLine++;
      i++;
      continue;
    }
    field += char;
    i++;
  }

  if (field.length > 0 || record.length > 0) {
    pushRecord();
  }

  const nonEmpty = records.filter((r) => r.some((v) => v.trim().length > 0));
  if (nonEmpty.length === 0) {
    throw new BadRequestError('CSV did not contain any data rows');
  }

  const headers = nonEmpty[0].map((h) => h.trim());
  if (headers.some((h) => !h)) {
    throw new BadRequestError('CSV header row contains an empty column name');
  }

  const dataRecords = nonEmpty.slice(1);
  if (dataRecords.length > options.maxRows) {
    throw new BadRequestError(
      `CSV exceeds the ${options.maxRows.toLocaleString()} row limit (${dataRecords.length} data rows)`,
    );
  }

  const rows: ParsedCsvRow[] = dataRecords.map((values, index) => ({
    values,
    lineNumber: firstLineOfRecord[index + 1] ?? 2,
  }));

  return { headers, rows };
}

export function rowToRecord(headers: string[], values: string[]): Record<string, string> {
  return Object.fromEntries(headers.map((header, index) => [header, values[index]?.trim() ?? '']));
}
