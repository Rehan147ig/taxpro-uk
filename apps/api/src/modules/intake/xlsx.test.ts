import { describe, it, expect } from 'vitest';
import Excel from 'exceljs';
import {
  parseXlsxBuffer,
  detectHeaderRowCandidates,
  mapSheetToParsedRows,
  buildClientFingerprint,
  xlsxCellToString,
  normalizeXlsxNumericString,
} from './xlsx.js';
import { validateRow, buildBatchSummary } from './validate.js';

async function buildWorkbook(
  build: (ws: Excel.Worksheet) => void,
  sheetName = 'TB',
): Promise<Buffer> {
  const wb = new Excel.Workbook();
  const ws = wb.addWorksheet(sheetName);
  build(ws);
  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf as unknown as ArrayBuffer);
}

const CTX = { periodStart: '2026-01-01', periodEnd: '2026-12-31', defaultCurrency: 'GBP' };

const COLUMN_MAP = {
  Account: 'accountName',
  Number: 'accountNumber',
  Type: 'accountType',
  Debit: 'debit',
  Credit: 'credit',
  Period: 'period',
} as Record<string, string>;

describe('xlsx parser — header-row detection with offsets', () => {
  for (const offset of [0, 1, 2, 5]) {
    it(`detects header with ${offset} offset row(s)`, async () => {
      const buf = await buildWorkbook((ws) => {
        for (let i = 0; i < offset; i++) {
          ws.getCell(`A${i + 1}`).value = i === 0 && offset > 0 ? 'Trial Balance FY2026' : '';
        }
        const hr = offset + 1;
        ws.getCell(`A${hr}`).value = 'Account';
        ws.getCell(`B${hr}`).value = 'Number';
        ws.getCell(`C${hr}`).value = 'Type';
        ws.getCell(`D${hr}`).value = 'Debit';
        ws.getCell(`E${hr}`).value = 'Credit';
        ws.getCell(`F${hr}`).value = 'Period';
        ws.getCell(`A${hr + 1}`).value = 'Cash';
        ws.getCell(`B${hr + 1}`).value = '1000';
        ws.getCell(`C${hr + 1}`).value = 'Asset';
        ws.getCell(`D${hr + 1}`).value = 500;
        ws.getCell(`E${hr + 1}`).value = 0;
        ws.getCell(`F${hr + 1}`).value = '2026-03-31';
      });
      const wb = await parseXlsxBuffer(buf, 'tb.xlsx');
      const sheet = wb.sheets[0];
      const candidates = detectHeaderRowCandidates(sheet);
      expect(candidates).toContain(offset + 1);
    });
  }
});

describe('xlsx parser — workbook shapes', () => {
  it('selects the correct sheet in a multi-sheet workbook', async () => {
    const wb = new Excel.Workbook();
    const junk = wb.addWorksheet('Instructions');
    junk.getCell('A1').value = 'Do not edit';
    junk.getCell('A2').value = 'Contact finance';
    const tb = wb.addWorksheet('TB');
    tb.getCell('A1').value = 'Account';
    tb.getCell('B1').value = 'Number';
    tb.getCell('C1').value = 'Type';
    tb.getCell('D1').value = 'Debit';
    tb.getCell('E1').value = 'Credit';
    tb.getCell('F1').value = 'Period';
    tb.getCell('A2').value = 'Cash';
    tb.getCell('B2').value = '1000';
    tb.getCell('C2').value = 'Asset';
    tb.getCell('D2').value = 100;
    tb.getCell('E2').value = 0;
    tb.getCell('F2').value = '2026-03-31';
    const buf = Buffer.from((await wb.xlsx.writeBuffer()) as unknown as ArrayBuffer);

    const parsed = await parseXlsxBuffer(buf, 'tb.xlsx');
    expect(parsed.sheets.map((s) => s.name).sort()).toEqual(['Instructions', 'TB']);
    const tbSheet = parsed.sheets.find((s) => s.name === 'TB')!;
    const { headers, rows } = mapSheetToParsedRows(tbSheet, 1, COLUMN_MAP);
    expect(headers).toContain('accountName');
    expect(rows).toHaveLength(1);
    expect(rows[0].lineNumber).toBe(2);
  });

  it('handles merged header cells (exceljs repeats the master value)', async () => {
    const buf = await buildWorkbook((ws) => {
      ws.mergeCells('A1:B1');
      ws.getCell('A1').value = 'Account Info';
      ws.getCell('C1').value = 'Type';
      ws.getCell('D1').value = 'Debit';
      ws.getCell('E1').value = 'Credit';
      ws.getCell('F1').value = 'Period';
      // Real header on row 2
      ws.getCell('A2').value = 'Account';
      ws.getCell('B2').value = 'Number';
      ws.getCell('C2').value = 'Type';
      ws.getCell('D2').value = 'Debit';
      ws.getCell('E2').value = 'Credit';
      ws.getCell('F2').value = 'Period';
      ws.getCell('A3').value = 'Cash';
      ws.getCell('B3').value = '1000';
      ws.getCell('C3').value = 'Asset';
      ws.getCell('D3').value = 10;
      ws.getCell('E3').value = 0;
      ws.getCell('F3').value = '2026-03-31';
    });
    const parsed = await parseXlsxBuffer(buf, 'merged.xlsx');
    const sheet = parsed.sheets[0];
    // Merged title row is still header-like; the real header must also be found.
    expect(detectHeaderRowCandidates(sheet)).toContain(2);
    const { rows } = mapSheetToParsedRows(sheet, 2, COLUMN_MAP);
    expect(rows).toHaveLength(1);
    const res = validateRow(rows[0], ['accountName', 'accountNumber', 'accountType', 'debit', 'credit', 'period'], CTX);
    expect(res.status).not.toBe('error');
  });

  it('skips empty rows in the middle but preserves physical row numbers', async () => {
    const buf = await buildWorkbook((ws) => {
      ws.getCell('A1').value = 'Account';
      ws.getCell('B1').value = 'Number';
      ws.getCell('C1').value = 'Type';
      ws.getCell('D1').value = 'Debit';
      ws.getCell('E1').value = 'Credit';
      ws.getCell('F1').value = 'Period';
      ws.getCell('A2').value = 'Cash';
      ws.getCell('B2').value = '1000';
      ws.getCell('C2').value = 'Asset';
      ws.getCell('D2').value = 10;
      ws.getCell('E2').value = 0;
      ws.getCell('F2').value = '2026-03-31';
      // Row 3 left fully empty
      ws.getCell('A4').value = 'Bank';
      ws.getCell('B4').value = '1001';
      ws.getCell('C4').value = 'Asset';
      ws.getCell('D4').value = 20;
      ws.getCell('E4').value = 0;
      ws.getCell('F4').value = '2026-03-31';
    });
    const parsed = await parseXlsxBuffer(buf, 'gaps.xlsx');
    const { rows } = mapSheetToParsedRows(parsed.sheets[0], 1, COLUMN_MAP);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.lineNumber)).toEqual([2, 4]);
  });
});

describe('xlsx parser — values and formatting', () => {
  it('reads numeric variants: £, thousand separators, parens negatives', async () => {
    expect(xlsxCellToString(1234.56)).toBe('1234.56');
    expect(xlsxCellToString('£1,234.56')).toBe('£1,234.56');
    expect(normalizeXlsxNumericString('(1,234.56)')).toBe('-1,234.56');
    expect(normalizeXlsxNumericString('£1,234.56')).toBe('£1,234.56');

    const buf = await buildWorkbook((ws) => {
      ws.getCell('A1').value = 'Account';
      ws.getCell('B1').value = 'Number';
      ws.getCell('C1').value = 'Type';
      ws.getCell('D1').value = 'Debit';
      ws.getCell('E1').value = 'Credit';
      ws.getCell('F1').value = 'Period';
      ws.getCell('A2').value = 'Cash';
      ws.getCell('B2').value = '1000';
      ws.getCell('C2').value = 'Asset';
      ws.getCell('D2').value = 1234.56; // native number (formatted £ in Excel)
      ws.getCell('E2').value = 0;
      ws.getCell('F2').value = '2026-03-31';
      ws.getCell('A3').value = 'Bank';
      ws.getCell('B3').value = '1001';
      ws.getCell('C3').value = 'Asset';
      ws.getCell('D3').value = '(2,000.00)'; // string parens negative
      ws.getCell('E3').value = 0;
      ws.getCell('F3').value = '2026-03-31';
    });
    const parsed = await parseXlsxBuffer(buf, 'nums.xlsx');
    const { headers, rows } = mapSheetToParsedRows(parsed.sheets[0], 1, COLUMN_MAP);
    const r1 = validateRow(rows[0], headers, CTX);
    expect(r1.status).not.toBe('error');
    expect(r1.normalized?.debit).toBeCloseTo(1234.56, 5);
    const r2 = validateRow(rows[1], headers, CTX);
    expect(r2.normalized?.debit).toBeCloseTo(-2000, 5);
  });

  it('uses formula results, not formula text', async () => {
    const buf = await buildWorkbook((ws) => {
      ws.getCell('A1').value = 'Account';
      ws.getCell('B1').value = 'Number';
      ws.getCell('C1').value = 'Type';
      ws.getCell('D1').value = 'Debit';
      ws.getCell('E1').value = 'Credit';
      ws.getCell('F1').value = 'Period';
      ws.getCell('A2').value = 'Cash';
      ws.getCell('B2').value = '1000';
      ws.getCell('C2').value = 'Asset';
      ws.getCell('D2').value = { formula: 'SUM(E2+100)', result: 150 } as unknown as string;
      ws.getCell('E2').value = 0;
      ws.getCell('F2').value = '2026-03-31';
    });
    const parsed = await parseXlsxBuffer(buf, 'formula.xlsx');
    const { headers, rows } = mapSheetToParsedRows(parsed.sheets[0], 1, COLUMN_MAP);
    const res = validateRow(rows[0], headers, CTX);
    expect(res.normalized?.debit).toBe(150);
  });

  it('rejects formulas referencing external workbooks with INVALID_FORMULA_REF', async () => {
    const buf = await buildWorkbook((ws) => {
      ws.getCell('A1').value = 'Account';
      ws.getCell('B1').value = 'Type';
      ws.getCell('C1').value = 'Period';
      ws.getCell('A2').value = 'Cash';
      ws.getCell('B2').value = 'Asset';
      ws.getCell('C2').value = { formula: "'[Budget.xlsx]Sheet1'!A1", result: 5 } as unknown as string;
    });
    await expect(parseXlsxBuffer(buf, 'ext.xlsx')).rejects.toThrow(/INVALID_FORMULA_REF/);
  });

  it('rejects legacy .xls with UNSUPPORTED_FORMAT', async () => {
    const buf = Buffer.from('PK\x03\x04fake');
    await expect(parseXlsxBuffer(buf, 'legacy.xls')).rejects.toThrow(/UNSUPPORTED_FORMAT/);
  });

  it('strips BOM and trims strings like the CSV path', () => {
    expect(xlsxCellToString('﻿  Cash  ')).toBe('Cash');
  });
});

describe('xlsx parser — mapping and validation reuse', () => {
  it('funnels into the exact same validateRow and control totals', async () => {
    const buf = await buildWorkbook((ws) => {
      ws.getCell('A3').value = 'Account';
      ws.getCell('B3').value = 'Number';
      ws.getCell('C3').value = 'Type';
      ws.getCell('D3').value = 'Debit';
      ws.getCell('E3').value = 'Credit';
      ws.getCell('F3').value = 'Period';
      ws.getCell('A4').value = 'Sales';
      ws.getCell('B4').value = '4000';
      ws.getCell('C4').value = 'Income';
      ws.getCell('D4').value = 0;
      ws.getCell('E4').value = 1000;
      ws.getCell('F4').value = '2026-03-31';
      ws.getCell('A5').value = 'Rent';
      ws.getCell('B5').value = '5000';
      ws.getCell('C5').value = 'Expense';
      ws.getCell('D5').value = 1000;
      ws.getCell('E5').value = 0;
      ws.getCell('F5').value = '2026-03-31';
    });
    const parsed = await parseXlsxBuffer(buf, 'tb3.xlsx');
    // Headers on row 3 with junk above
    expect(detectHeaderRowCandidates(parsed.sheets[0])).toContain(3);
    const { headers, rows } = mapSheetToParsedRows(parsed.sheets[0], 3, COLUMN_MAP);
    const results = rows.map((r) => ({ lineNumber: r.lineNumber, result: validateRow(r, headers, CTX) }));
    const summary = buildBatchSummary(results);
    expect(summary.okCount).toBe(2);
    expect(summary.controlTotals.balanced).toBe(true);
  });

  it('builds a deterministic client fingerprint from sorted headers + sheet', () => {
    const a = buildClientFingerprint('TB', ['B', 'A', 'C']);
    const b = buildClientFingerprint('TB', ['A', 'B', 'C']);
    const c = buildClientFingerprint('Other', ['A', 'B', 'C']);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});
