import { test, expect } from '@playwright/test';
import { login } from './helpers';

/**
 * Feature 2 — sign-convention detection.
 *
 * A TB with every sign flipped still balances, so validation passes — but
 * commit blocks with SIGN_CONVENTION_INVERTED until a reviewer confirms.
 * After confirm, commit applies the × −1 correction once (audited) and the
 * trial balance matches the standard-convention numbers.
 *
 * Requires INTAKE_SIGN_CONVENTION=true on the API (defaults off). Skips
 * otherwise so default CI stays green.
 */
test('sign convention: inverted TB blocks commit until reviewer confirms, then commits corrected', async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await login(page);

  const token = await page.evaluate(() => localStorage.getItem('taxpro_token'));
  expect(token).toBeTruthy();
  const authHeader = { Authorization: `Bearer ${token}` };
  const api = ctx.request;

  const flags = await (await api.get('/api/config/flags', { headers: authHeader })).json();
  test.skip(!flags?.INTAKE_SIGN_CONVENTION, 'INTAKE_SIGN_CONVENTION flag is off.');

  const setup = await (await api.get('/api/workbench/setup', { headers: authHeader })).json();
  const entity = setup.entities?.find((e: { name: string }) => e.name.includes('Acme UK')) ?? setup.entities?.[0];
  const period = setup.accountingPeriods?.[0] ?? setup.periods?.[0];
  expect(entity?.id).toBeTruthy();
  expect(period?.id).toBeTruthy();

  const stamp = Date.now();
  const headers = 'entityName,entityExternalId,accountName,accountNumber,accountExternalId,accountType,detailType,period,periodEnd,debit,credit,balance,currency';
  const inverted = [
    `SignCo,signco-e2e-${stamp},Sales revenue,4000,4000,Income,Income,2026-03-31,2026-03-31,48000,0,,GBP`,
    `SignCo,signco-e2e-${stamp},Salaries,5000,5000,Expense,Expense,2026-03-31,2026-03-31,0,20000,,GBP`,
    `SignCo,signco-e2e-${stamp},Cash,1000,1000,Asset,Asset,2026-03-31,2026-03-31,0,50000,,GBP`,
    `SignCo,signco-e2e-${stamp},Trade payables,2000,2000,Liability,Liability,2026-03-31,2026-03-31,30000,0,,GBP`,
  ].join('\n');

  const upload = await api.post('/api/intake/batches', {
    headers: authHeader,
    multipart: {
      entityId: entity.id,
      accountingPeriodId: period.id,
      sourceReference: `e2e-sign-inverted-${stamp}`,
      file: { name: 'tb-inverted.csv', mimeType: 'text/csv', buffer: Buffer.from(`${headers}\n${inverted}`) },
    },
  });
  expect([200, 201]).toContain(upload.status());
  const batchId = ((await upload.json()) as { batch: { id: string } }).batch.id;

  // Commit blocked: every signalling type has the wrong sign.
  const blocked = await api.post(`/api/intake/batches/${batchId}/commit`, { headers: authHeader });
  expect(blocked.status()).toBe(409);
  expect(await blocked.text()).toContain('SIGN_CONVENTION_INVERTED');

  const report = await (await api.get(`/api/intake/batches/${batchId}/sign-convention`, { headers: authHeader })).json();
  expect(report.report.classification).toBe('inverted');

  const confirm = await api.post(`/api/intake/batches/${batchId}/sign-convention/confirm`, {
    headers: { ...authHeader, 'Content-Type': 'application/json' },
    data: { reason: 'E2E: source system exports inverted signs.' },
  });
  expect(confirm.status()).toBe(200);

  const committed = await api.post(`/api/intake/batches/${batchId}/commit`, { headers: authHeader });
  expect(committed.status()).toBe(200);
  const body = (await committed.json()) as {
    committedRows: number;
    signConvention: { classification: string; applied: boolean };
  };
  expect(body.committedRows).toBe(4);
  expect(body.signConvention).toMatchObject({ classification: 'inverted', applied: true });

  const rows = (await (await api.get(`/api/intake/batches/${batchId}/rows`, { headers: authHeader })).json()) as {
    rows: { normalized: { accountName: string; balance: number } | null; raw: Record<string, string> }[];
  };
  const sales = rows.rows.find((r) => r.normalized?.accountName === 'Sales revenue');
  expect(sales?.normalized?.balance).toBe(-48000);
  expect(sales?.raw.debit).toBe('48000');

  await ctx.close();
});
