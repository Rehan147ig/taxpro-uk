import crypto from 'crypto';
import Excel from 'exceljs';
import { BadRequestError } from '../../lib/errors.js';
import type { ParsedCsvRow } from './csv.js';

/**
 * XLSX ingest with column mapping (Feature 1).
 *
 * Firms send Excel workbooks with merged headers, offset header rows, junk
 * sheets and non-canonical column names. This module parses .xlsx/.xlsm via
 * exceljs (MIT) and funnels rows into the exact same ParsedCsvRow shape used
 * by validate.ts — validation itself is never reimplemented here.
 *
 * Invariants preserved:
 * - AI prepares, never decides (no AI here — purely deterministic).
 * - Engine untouched; we only feed data into validateRow.
 * - Humans approve via the existing batch commit gate.
 */

export const XLSX_MAX_BYTES = 20 * 1024 * 1024;
export const XLSX_MAX_ROWS = 20_000;

/** Canonical fields the column map may target (must stay in sync with validate.ts aliases). */
export const CANONICAL_FIELDS = [
  'accountName',
  'accountNumber',
  'accountType',
  'debit',
  'credit',
  'balance',
  'period',
  'periodEnd',
  'currency',
  'entityName',
  'entityExternalId',
  'accountExternalId',
  'detailType',
] as const;
export type CanonicalField = (typeof CANONICAL_FIELDS)[number];
const CANONICAL_SET = new Set<string>(CANONICAL_FIELDS);

/** External-workbook reference inside a formula, e.g. '[Budget.xlsx]Sheet1'!A1 */
const EXTERNAL_REF_RE = /\[[^\]]*\.xls[xm]?\]/i;

export interface SheetGrid {
  name: string;
  /** Physical 1-indexed rows; cells are trimmed display-neutral strings. */
  rows: Array<{ rowNumber: number; cells: string[]; raws: unknown[] }>;
  maxCols: number;
}

export interface ParsedWorkbook {
  sheets: SheetGrid[];
}

export interface SheetPreview {
  name: string;
  headerCandidates: number[];
  /** First 20 physical rows (including empty ones) for operator orientation. */
  firstRows: Array<{ rowNumber: number; cells: string[] }>;
  totalRows: number;
  maxCols: number;
}

function fail(code: string, message: string, details?: Record<string, unknown>): never {
  throw new BadRequestError(`${code}: ${message}`, { code, ...(details ?? {}) });
}

export function assertXlsxFilename(filename: string): void {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.xls') && !lower.endsWith('.xlsx') && !lower.endsWith('.xlsm')) {
    fail('UNSUPPORTED_FORMAT', `Unsupported file type: ${filename}. XLSX ingest accepts .xlsx and .xlsm only (legacy .xls is rejected).`);
  }
  if (!lower.endsWith('.xlsx') && !lower.endsWith('.xlsm')) {
    fail('UNSUPPORTED_FORMAT', `Unsupported file type: ${filename}. XLSX ingest accepts .xlsx and .xlsm only.`);
  }
}

function sniffXlsx(buffer: Buffer, filename: string): void {
  // XLSX/XLSM are ZIP containers (PK\x03\x04).
  const isZip = buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04;
  if (!isZip) {
    fail('UNSUPPORTED_FORMAT', `File content does not match its extension (${filename}): expected an OOXML workbook.`);
  }
}

/** Convert an exceljs cell value to a trimmed, BOM-stripped string. Reads values, never display strings. */
export function xlsxCellToString(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return '';
    return String(value);
  }
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return '';
    return value.toISOString().slice(0, 10);
  }
  if (typeof value === 'string') {
    return value.replace(/^\uFEFF/, '').trim();
  }
  if (typeof value === 'object') {
    const v = value as Record<string, unknown>;
    // Formula cell: { formula, result }. The formula itself was already
    // checked for external refs; use the computed result value.
    if ('result' in v) {
      return xlsxCellToString(v.result);
    }
    // Rich text: { richText: [{ text }] }
    if (Array.isArray(v.richText)) {
      const text = (v.richText as Array<{ text?: unknown }>)
        .map((part) => (typeof part.text === 'string' ? part.text : ''))
        .join('');
      return text.replace(/^\uFEFF/, '').trim();
    }
    // Hyperlink: { text, hyperlink }
    if (typeof v.text === 'string') {
      return (v.text as string).replace(/^\uFEFF/, '').trim();
    }
    return '';
  }
  return String(value).replace(/^\uFEFF/, '').trim();
}

/**
 * Normalize numeric-looking strings so validateRow's parseAmount accepts them.
 * Handles negative-in-parens "(1,234.56)" → "-1234.56". £/commas/spaces are
 * left for validate.ts (it already strips them).
 */
export function normalizeXlsxNumericString(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('(') && trimmed.endsWith(')')) {
    const inner = trimmed.slice(1, -1).trim();
    // Only treat as negative if the inside looks numeric (avoid "(see note)").
    const probe = inner.replace(/[£$€,\s]/g, '');
    if (probe !== '' && Number.isFinite(Number(probe))) {
      return `-${inner}`;
    }
  }
  return trimmed;
}

function checkFormulaForExternalRef(formula: unknown, rowNumber: number, colNumber: number): void {
  if (typeof formula !== 'string' || formula === '') return;
  if (EXTERNAL_REF_RE.test(formula)) {
    fail('INVALID_FORMULA_REF', `Cell at row ${rowNumber}, column ${colNumber} references an external workbook ("${formula.slice(0, 80)}"). Remove external links before import.`, {
      rowNumber,
      colNumber,
    });
  }
}

/**
 * Parse an .xlsx/.xlsm buffer into per-sheet grids.
 * Preserves physical row numbers for error pointing; skips nothing here
 * (callers decide which rows are data vs empty).
 */
export async function parseXlsxBuffer(buffer: Buffer, filename: string): Promise<ParsedWorkbook> {
  assertXlsxFilename(filename);
  if (buffer.length > XLSX_MAX_BYTES) {
    fail('FILE_TOO_LARGE', `File too large: ${(buffer.length / 1024 / 1024).toFixed(1)}MB. Maximum XLSX upload size is ${XLSX_MAX_BYTES / 1024 / 1024}MB.`);
  }
  sniffXlsx(buffer, filename);

  const workbook = new Excel.Workbook();
  try {
    await workbook.xlsx.load(buffer as unknown as Excel.Buffer);
  } catch {
    fail('INVALID_WORKBOOK', `Workbook "${filename}" could not be parsed as .xlsx/.xlsm. Re-save it from Excel and retry.`);
  }

  const sheets: SheetGrid[] = [];
  let totalDataRows = 0;

  workbook.eachSheet((worksheet) => {
    const rows: SheetGrid['rows'] = [];
    let maxCols = 0;
    worksheet.eachRow({ includeEmpty: true }, (row, rowNumber) => {
      const cells: string[] = [];
      const raws: unknown[] = [];
      const colCount = Math.max(row.cellCount, worksheet.columnCount);
      for (let col = 1; col <= colCount; col++) {
        const cell = row.getCell(col);
        checkFormulaForExternalRef((cell as unknown as { formula?: unknown }).formula, rowNumber, col);
        const raw = cell.value as unknown;
        // Formula objects also carry .formula on the cell; check the embedded one too.
        if (raw !== null && typeof raw === 'object' && 'formula' in (raw as Record<string, unknown>)) {
          checkFormulaForExternalRef((raw as { formula?: unknown }).formula, rowNumber, col);
        }
        raws.push(raw);
        cells.push(xlsxCellToString(raw));
      }
      // Trim trailing empty columns so ragged sheets compare cleanly.
      let end = cells.length;
      while (end > 0 && cells[end - 1] === '') end--;
      const trimmedCells = cells.slice(0, end);
      const trimmedRaws = raws.slice(0, end);
      maxCols = Math.max(maxCols, trimmedCells.length);
      // Keep every physical row (even fully empty) so previews show offsets;
      // mapping skips all-empty data rows but keeps their numbers.
      rows.push({ rowNumber, cells: trimmedCells, raws: trimmedRaws });
    });
    totalDataRows += rows.length;
    sheets.push({ name: worksheet.name, rows, maxCols });
  });

  if (sheets.length === 0) {
    fail('EMPTY_WORKBOOK', 'Workbook did not contain any sheets.');
  }
  if (totalDataRows > XLSX_MAX_ROWS + 100) {
    // +100 slack for title/blank rows; the strict data-row cap is enforced in mapping.
    fail('ROW_LIMIT_EXCEEDED', `Workbook exceeds the ${XLSX_MAX_ROWS.toLocaleString()} row limit.`);
  }

  return { sheets };
}

/** A cell counts as header-like when it is a non-empty, non-numeric string. */
function isHeaderLikeCell(raw: unknown, text: string): boolean {
  if (text === '') return false;
  // Numbers, booleans and Dates are data, never headers — even when their
  // string form looks textual.
  if (typeof raw === 'number' || typeof raw === 'boolean') return false;
  if (raw instanceof Date) return false;
  if (raw !== null && typeof raw === 'object') {
    const v = raw as Record<string, unknown>;
    if ('result' in v) return isHeaderLikeCell(v.result, text);
    if (Array.isArray(v.richText)) return true;
    return false;
  }
  if (typeof raw !== 'string') return false;
  const probe = text.replace(/[£$€,\s]/g, '');
  if (probe !== '' && Number.isFinite(Number(probe))) return false;
  // Paren-negatives like "(1,234.56)" are data.
  if (/^\(.*\)$/.test(text)) {
    const inner = text.slice(1, -1).replace(/[£$€,\s]/g, '');
    if (inner !== '' && Number.isFinite(Number(inner))) return false;
  }
  // YYYY-MM-DD dates are data.
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  return true;
}

/**
 * Header-row candidates: rows where ≥ 60% of non-empty cells are
 * non-numeric strings. Purely deterministic.
 */
export function detectHeaderRowCandidates(sheet: SheetGrid): number[] {
  const candidates: number[] = [];
  for (const row of sheet.rows) {
    const nonEmpty = row.cells.filter((c) => c !== '').length;
    if (nonEmpty === 0) continue;
    let headerLike = 0;
    for (let i = 0; i < row.cells.length; i++) {
      if (isHeaderLikeCell(row.raws[i], row.cells[i])) headerLike++;
    }
    if (headerLike / nonEmpty >= 0.6) candidates.push(row.rowNumber);
  }
  return candidates;
}

export function buildSheetPreviews(workbook: ParsedWorkbook): SheetPreview[] {
  return workbook.sheets.map((sheet) => ({
    name: sheet.name,
    headerCandidates: detectHeaderRowCandidates(sheet),
    firstRows: sheet.rows.slice(0, 20).map((r) => ({ rowNumber: r.rowNumber, cells: r.cells })),
    totalRows: sheet.rows.length,
    maxCols: sheet.maxCols,
  }));
}

/**
 * Deterministic client fingerprint for map reuse:
 * sha256(JSON { sortedHeaders, sheetName }).
 */
export function buildClientFingerprint(sheetName: string, headers: string[]): string {
  const sortedHeaders = [...headers].sort();
  return crypto.createHash('sha256').update(JSON.stringify({ sortedHeaders, sheetName })).digest('hex');
}

export function validateColumnMap(headerCells: string[], columnMap: Record<string, string>): void {
  const headerSet = new Set(headerCells);
  for (const [userCol, canonical] of Object.entries(columnMap)) {
    if (!headerSet.has(userCol)) {
      fail('UNKNOWN_COLUMN', `Mapped column "${userCol}" was not found in the sheet header row.`, { column: userCol });
    }
    if (!CANONICAL_SET.has(canonical)) {
      fail('UNKNOWN_FIELD', `Canonical field "${canonical}" is not a known intake field (${CANONICAL_FIELDS.join(', ')}).`, { field: canonical });
    }
  }
  const targets = new Set(Object.values(columnMap));
  for (const required of ['accountName', 'accountType', 'period'] as const) {
    if (!targets.has(required)) {
      fail('MISSING_REQUIRED', `Column map must include a mapping to "${required}".`, { field: required });
    }
  }
}

const AMOUNT_FIELDS = new Set(['debit', 'credit', 'balance']);

/**
 * Convert a mapped sheet into the same ParsedCsvRow shape used by
 * validate.ts. Header row is 1-indexed physical. Rows after the header with
 * all mapped cells empty are skipped (empty rows in the middle); physical
 * row numbers are preserved as lineNumber for error pointing.
 */
export function mapSheetToParsedRows(
  sheet: SheetGrid,
  headerRow: number,
  columnMap: Record<string, string>,
): { headers: string[]; rows: ParsedCsvRow[] } {
  const headerGridRow = sheet.rows.find((r) => r.rowNumber === headerRow);
  if (!headerGridRow) {
    fail('INVALID_HEADER_ROW', `Header row ${headerRow} was not found in sheet "${sheet.name}".`);
  }
  const headerCells = (headerGridRow as { cells: string[] }).cells;
  if (headerCells.every((c) => c === '')) {
    fail('INVALID_HEADER_ROW', `Header row ${headerRow} in sheet "${sheet.name}" is empty.`);
  }
  validateColumnMap(headerCells, columnMap);

  // Column order follows the sheet's physical order for mapped columns.
  const mappedCols: Array<{ index: number; canonical: string }> = [];
  // Guard against duplicate user-visible names from merged headers: exceljs
  // repeats the master value across the merge, so map each physical column
  // independently (first occurrence wins for lookup, all map identically).
  for (let i = 0; i < headerCells.length; i++) {
    const userCol = headerCells[i];
    const canonical = columnMap[userCol];
    if (canonical) mappedCols.push({ index: i, canonical });
  }
  if (mappedCols.length === 0) {
    fail('EMPTY_COLUMN_MAP', 'Column map did not match any columns in the header row.');
  }

  const headers = mappedCols.map((c) => c.canonical);
  const rows: ParsedCsvRow[] = [];
  for (const row of sheet.rows) {
    if (row.rowNumber <= headerRow) continue;
    const values = mappedCols.map(({ index, canonical }) => {
      const raw = row.cells[index] ?? '';
      if (AMOUNT_FIELDS.has(canonical)) return normalizeXlsxNumericString(raw);
      return raw;
    });
    if (values.every((v) => v === '')) continue; // skip empty rows, keep numbers
    rows.push({ values, lineNumber: row.rowNumber });
  }

  if (rows.length > XLSX_MAX_ROWS) {
    fail('ROW_LIMIT_EXCEEDED', `Sheet exceeds the ${XLSX_MAX_ROWS.toLocaleString()} row limit (${rows.length} data rows).`);
  }

  return { headers, rows };
}
