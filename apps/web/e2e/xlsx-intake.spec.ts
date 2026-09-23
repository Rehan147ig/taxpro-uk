import { test, expect } from '@playwright/test';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { login } from './helpers';

/**
 * Feature 1 — XLSX ingest with column mapping.
 *
 * Operator drops a real-looking Excel TB (headers on row 3, one junk sheet
 * named "Instructions"), previews sheets, maps columns, and reaches the same
 * committed import batch state as the CSV path — with the map remembered.
 *
 * Requires INTAKE_XLSX=true on the API (defaults off). When the flag is off
 * the scenario skips so the default CI stays green.
 */
test('xlsx intake: offset headers → preview → column-map → commit (map remembered)', async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await login(page);

  const token = await page.evaluate(() => localStorage.getItem('taxpro_token'));
  expect(token).toBeTruthy();
  const authHeader = { Authorization: `Bearer ${token}` };
  const api = ctx.request;

  const flags = await (await api.get('/api/config/flags', { headers: authHeader })).json();
  test.skip(!flags?.INTAKE_XLSX, 'INTAKE_XLSX flag is off — enable with INTAKE_XLSX=true to run the XLSX pilot path.');

  // Demo tenant pickers: reuse the seeded Acme UK Ltd FY2026 period.
  const setup = await (await api.get('/api/workbench/setup', { headers: authHeader })).json();
  const entity = setup.entities?.find((e: { name: string }) => e.name.includes('Acme UK')) ?? setup.entities?.[0];
  const period = setup.accountingPeriods?.[0] ?? setup.periods?.[0];
  expect(entity?.id).toBeTruthy();
  expect(period?.id).toBeTruthy();

  const here = dirname(fileURLToPath(import.meta.url));
  const xlsxPath = join(here, 'fixtures', 'tb-offset-headers.xlsx');
  const xlsxBytes = readFileSync(xlsxPath);

  // 1. Upload the workbook → uploadId + sheet list.
  const uploadResp = await api.post('/api/intake/xlsx-upload', {
    headers: authHeader,
    multipart: {
      file: { name: 'tb-offset-headers.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: xlsxBytes },
    },
  });
  expect([200, 201]).toContain(uploadResp.status());
  const upload = await uploadResp.json();
  expect(upload.sheets).toEqual(expect.arrayContaining(['TB', 'Instructions']));
  const uploadId = upload.uploadId as string;
  expect(uploadId).toMatch(/^[0-9a-f-]{36}$/);

  // 2. Preview: first 20 rows per sheet + header candidates + sheet names.
  const previewResp = await api.post('/api/intake/preview', {
    headers: { ...authHeader, 'Content-Type': 'application/json' },
    data: { uploadId },
  });
  expect(previewResp.status()).toBe(200);
  const preview = await previewResp.json();
  const tbPreview = preview.previews.find((p: { name: string }) => p.name === 'TB');
  expect(tbPreview.headerCandidates).toContain(3);
  expect(preview.sheets).toEqual(expect.arrayContaining(['TB']));

  // 3. Column-map headers on row 3 → canonical fields → import batch.
  const columnMap = {
    Account: 'accountName',
    Number: 'accountNumber',
    Type: 'accountType',
    Debit: 'debit',
    Credit: 'credit',
    Period: 'period',
  };
  const mapResp = await api.post('/api/intake/column-map', {
    headers: { ...authHeader, 'Content-Type': 'application/json' },
    data: {
      uploadId,
      sheetName: 'TB',
      headerRow: 3,
      columnMap,
      entityId: entity.id,
      accountingPeriodId: period.id,
      sourceReference: 'e2e-xlsx-offset-headers',
    },
  });
  expect([200, 201]).toContain(mapResp.status());
  const mapped = await mapResp.json();
  expect(mapped.clientFingerprint).toMatch(/^[0-9a-f]{64}$/);
  const batchId = mapped.batch.id as string;

  // Idempotent re-runs: checksum dedupe may return an already-committed batch
  // from a previous run instead of a fresh ready_for_review one — that *is*
  // the committed end state, so assert it and continue instead of failing.
  if (mapped.batch.status === 'committed') {
    expect(mapped.duplicate).toBe(true);
  } else {
    expect(mapped.batch.status).toBe('ready_for_review');
    expect(mapped.summary.rows).toBe(4);
    expect(mapped.summary.errors).toBe(0);

    // 4. Commit → same end state as the CSV path.
    const commitResp = await api.post(`/api/intake/batches/${batchId}/commit`, {
      headers: authHeader,
    });
    expect(commitResp.status()).toBe(200);
    const committed = await commitResp.json();
    expect(committed.batch.status).toBe('committed');
    expect(committed.committedRows).toBe(4);
  }

  // 5. Map remembered for next period via fingerprint lookup.
  const remembered = await api.get(`/api/intake/column-maps?fingerprint=${mapped.clientFingerprint}`, {
    headers: authHeader,
  });
  expect(remembered.status()).toBe(200);
  const rememberedBody = await remembered.json();
  expect(rememberedBody.map.columnMap).toMatchObject(columnMap);

  await ctx.close();
});
