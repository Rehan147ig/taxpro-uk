import { test, expect } from '@playwright/test';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { login, ADMIN_EMAIL, PARTNER_EMAIL, PASSWORD } from './helpers';

/**
 * Full operator lifecycle on the Apex marginal-relief scenario:
 * excel intake → sign check → commit → workbench marginal-relief run →
 * governance → partner sign-off → lock → filing-ready handoff.
 *
 * Honest wiring notes (deviations from a naive reading, all intentional):
 * - Demo reset is POST /api/demo/switch-scenario with JSON
 *   {scenario: 'apex-marginal-relief'} (not a ?scenario=apex query).
 * - The intake-committed batch is NOT auto-linked into workbench runs on
 *   this codebase version (runs calculate over workbench-imported TB rows
 *   scoped to the selected source document). The journey therefore proves
 *   ingestion (Step 1) and calculation-through-handoff (Steps 2–5) as one
 *   operator lifecycle on the same tenant — it never pretends a linkage
 *   that does not exist.
 * - Apex book ETR is ~28.8% (£36k on £125k book), NOT 19–26.5: permanent
 *   differences (entertaining + penalties) lift it above the statutory band.
 *   The s.18D check is the marginal-relief line + the 27–30% ETR window.
 * - Requires INTAKE_XLSX on the API (skips otherwise, like the other
 *   intake specs); the sign panel assertion is conditional on
 *   INTAKE_SIGN_CONVENTION.
 */
test('full operator lifecycle: excel intake -> commit -> workbench marginal relief -> lock -> handoff', async ({ browser }) => {
  const consoleErrors: string[] = [];
  const adminContext = await browser.newContext();
  const page = await adminContext.newPage();
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  await login(page, ADMIN_EMAIL);

  const adminToken = await page.evaluate(() => localStorage.getItem('taxpro_token'));
  const authHeader = { Authorization: `Bearer ${adminToken}` };
  const api = adminContext.request;

  // ── Flags gate the whole journey ──
  const flags = await (await api.get('/api/config/flags', { headers: authHeader })).json();
  test.skip(!flags?.INTAKE_XLSX, 'INTAKE_XLSX flag is off.');

  // ── Reset: Apex marginal-relief scenario (JSON body, full scenario id) ──
  const switched = await api.post('/api/demo/switch-scenario', {
    headers: { ...authHeader, 'Content-Type': 'application/json' },
    data: { scenario: 'apex-marginal-relief' },
  });
  expect([200, 201]).toContain(switched.status());
  const switchedBody = await switched.json();
  expect(switchedBody.entity.name).toContain('Apex');

  // ══ Step 1: Excel ingestion at /intake ══
  await page.getByRole('link', { name: 'Intake', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Data Intake' })).toBeVisible({ timeout: 30_000 });

  // Pin the Apex entity so the batch lands in the scenario tenant slice.
  const entitySelect = page.locator('select').filter({ has: page.getByRole('option', { name: 'Apex Manufacturing Ltd' }) }).first();
  await entitySelect.selectOption({ label: 'Apex Manufacturing Ltd' });

  const here = dirname(fileURLToPath(import.meta.url));
  await page.locator('input[accept=".xlsx,.xlsm"]').setInputFiles(join(here, 'fixtures', 'tb-offset-headers.xlsx'));
  await expect(page.getByText(/Workbook parsed: 2 sheet/)).toBeVisible({ timeout: 30_000 });

  await page.getByLabel(/Sheet \(\d+\)/).selectOption('TB');
  await page.getByLabel('Header row').selectOption('3');
  const columnMap: Record<string, string> = {
    accountName: 'Account', accountNumber: 'Number', accountType: 'Type',
    debit: 'Debit', credit: 'Credit', period: 'Period',
  };
  for (const [canonical, userCol] of Object.entries(columnMap)) {
    await page.getByLabel(new RegExp(`^${canonical}`)).selectOption(userCol);
  }
  await page.getByRole('button', { name: 'Create import batch from sheet' }).click();
  await expect(page.getByText(/XLSX batch created/)).toBeVisible({ timeout: 30_000 });

  // Sign check: the fixture is standard-convention, so the panel renders the
  // summary table with no confirm action required.
  if (flags?.INTAKE_SIGN_CONVENTION) {
    await expect(page.getByText(/Sign convention: standard/)).toBeVisible({ timeout: 30_000 });
  }

  await page.getByRole('button', { name: 'Commit batch' }).click();
  await expect(page.getByText('committed', { exact: false }).first()).toBeVisible({ timeout: 30_000 });

  // ══ Step 2: Workbench marginal-relief calculation on Apex ══
  await page.getByRole('link', { name: 'Workbench', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'UK Tax-Close Workbench' })).toBeVisible({ timeout: 30_000 });

  const setup = await (await api.get('/api/workbench/setup', { headers: authHeader })).json();
  const apex = setup.entities.find((e: any) => e.name === 'Apex Manufacturing Ltd');
  expect(apex?.id).toBeTruthy();
  const apexAp = setup.accountingPeriods.find((p: any) => p.entityId === apex.id && p.startDate === '2026-01-01');
  const apexTp = setup.taxPeriods.find((p: any) => p.entityId === apex.id && p.startDate === '2026-01-01');
  const apexDoc = setup.documents.find((d: any) => d.filename.includes('apex')) ?? setup.documents[0];
  await page.getByLabel('UK entity').selectOption(apex.id);
  if (apexAp) await page.getByLabel('Accounting period').selectOption(apexAp.id);
  if (apexTp) await page.getByLabel('Tax period').selectOption(apexTp.id);
  if (apexDoc) await page.getByLabel('Source document').selectOption(apexDoc.id);

  // Apex-scale chart reusing the scenario's namespaced accounts (which carry
  // active mappings), so the run computes instead of excluding everything.
  const apexChart = [
    'APEX-MFG:1010,Cash at bank,Asset,Bank,125000',
    'APEX-MFG:2000,Bad debt provision,Expense,Expense,20000',
    'APEX-MFG:4000,Sales revenue,Income,Income,-800000',
    'APEX-MFG:5000,Cost of sales,Expense,COGS,250000',
    'APEX-MFG:6000,Salaries and wages,Expense,Expense,200000',
    'APEX-MFG:6100,Factory rent,Expense,Expense,120000',
    'APEX-MFG:6200,Utilities,Expense,Expense,30000',
    'APEX-MFG:6300,Client entertaining,Expense,Expense,15000',
    'APEX-MFG:6400,HMRC penalties,Expense,Expense,10000',
    'APEX-MFG:7000,Software subscriptions,Expense,Expense,25000',
    'APEX-MFG:7100,Freight and carriage,Expense,Expense,5000',
  ].join('\n');
  await page.locator('textarea').fill(apexChart);
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(page.getByText(/Import (complete|replayed)/)).toBeVisible({ timeout: 60_000 });

  await page.getByRole('button', { name: 'Run Workbench Calculation' }).click();
  const blockedBanner = page.getByText('Run blocked', { exact: false });
  let blocked = false;
  try {
    await blockedBanner.waitFor({ state: 'visible', timeout: 15_000 });
    blocked = true;
  } catch { /* calculation went straight through */ }
  if (blocked) {
    // Seeded pending proposal (SaaS subscriptions) must be human-decided first.
    await expect(page.getByText(/mapping_proposals_pending/)).toBeVisible();
    await page.getByRole('link', { name: 'Proposals & Rules' }).click();
    await expect(page.getByRole('heading', { name: /Governance/ })).toBeVisible({ timeout: 30_000 });
    const approveButton = page.getByRole('button', { name: 'Approve & Apply' }).first();
    await approveButton.waitFor({ state: 'visible', timeout: 30_000 });
    await page.getByPlaceholder('Decision reason (required)').fill('Approved in intake journey E2E: SaaS is deductible.');
    await approveButton.click();
    await expect(page.getByRole('button', { name: 'Approve & Apply' })).toHaveCount(0, { timeout: 30_000 });
    await page.getByRole('link', { name: 'Workbench', exact: true }).click();
    await page.getByRole('button', { name: 'Refresh' }).click();
    await page.getByRole('button', { name: 'Run Workbench Calculation' }).click();
  }

  const runLink = page.getByRole('link', { name: 'Open in Review →' }).first();
  await runLink.waitFor({ state: 'visible', timeout: 90_000 });
  const runId = (await runLink.getAttribute('href'))!.replace('/runs/', '');
  expect(runId).toMatch(/^[0-9a-f-]{36}$/);
  await expect(page.getByText(/Total tax expense/)).toBeVisible();
  await expect(page.getByText(/input hash/)).toBeVisible();

  // s.18D proof: marginal-relief line present and book ETR in the 27–30%
  // window (£36k CT on £125k book = 28.8% per the scenario's expectedOutcome).
  const detail = await (await api.get(`/api/workbench/runs/${runId}`, { headers: authHeader })).json();
  const etr = detail?.result?.detail?.summary?.effectiveTaxRate ?? detail?.result?.effectiveTaxRate;
  expect(typeof etr).toBe('number');
  expect(etr).toBeGreaterThanOrEqual(0.27);
  expect(etr).toBeLessThanOrEqual(0.30);
  expect(JSON.stringify(detail).toLowerCase()).toContain('marginal');

  // ══ Step 3: governance → submit ══
  await runLink.click();
  await expect(page.getByRole('heading', { name: /Provision/ })).toBeVisible({ timeout: 30_000 });
  const approveAll = page.getByRole('button', { name: 'Approve All Items' });
  if (await approveAll.isVisible().catch(() => false)) {
    await approveAll.click();
    await expect(page.getByRole('button', { name: 'Approve All Items' })).toHaveCount(0, { timeout: 30_000 });
  }
  await page.getByRole('button', { name: 'Submit for Approval' }).click();
  await expect(page.getByRole('button', { name: 'Partner Sign-off' })).toBeVisible({ timeout: 30_000 });

  // ══ Step 4: partner sign-off + lock (segregation of duties) ══
  const partnerContext = await browser.newContext();
  const partnerPage = await partnerContext.newPage();
  partnerPage.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  await login(partnerPage, PARTNER_EMAIL, PASSWORD);
  await partnerPage.goto(`/runs/${runId}`);
  await expect(partnerPage.getByRole('button', { name: 'Partner Sign-off' })).toBeVisible({ timeout: 30_000 });
  await partnerPage.getByRole('button', { name: 'Partner Sign-off' }).click();
  await expect(partnerPage.getByText(/Approved by/)).toBeVisible({ timeout: 30_000 });
  await partnerContext.close();

  await page.reload();
  await expect(page.getByRole('button', { name: 'Lock Final Provision' })).toBeVisible({ timeout: 30_000 });
  page.on('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'Lock Final Provision' }).click();
  await expect(page.getByText('Locked', { exact: true }).first()).toBeVisible({ timeout: 30_000 });

  // 409 lock invariant at the API level.
  const mappings = await (await api.get('/api/mapping/mappings', { headers: authHeader })).json();
  expect(Array.isArray(mappings)).toBe(true);
  const accountId = mappings[0]?.accountId ?? mappings[0]?.id;
  const overrideResp = await api.post(`/api/mapping/mappings/${accountId}/override`, {
    headers: authHeader,
    data: { taxAccountType: 'PERM_OTHER', bookTreatment: 'permanent', provisionRunId: runId },
  });
  expect(overrideResp.status()).toBe(409);

  // ══ Step 5: filing-ready handoff ══
  await page.getByRole('link', { name: 'Workbench', exact: true }).click();
  await page.getByRole('button', { name: 'Refresh' }).click();
  const lockedRow = page.locator('tbody tr').filter({ hasText: 'locked' }).first();
  await lockedRow.getByRole('button', { name: 'View run', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Run detail' })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('Filing handoff', { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/TaxPro does not submit to HMRC/)).toBeVisible();
  await expect(page.getByText('CT600 figures', { exact: false })).toBeVisible();
  await expect(page.getByText(/valid/, { exact: false }).first()).toBeVisible();

  await page.getByRole('button', { name: 'Mark filing-ready (handoff)' }).click();
  await expect(page.getByText('Filing-ready handoff', { exact: true })).toBeVisible({ timeout: 30_000 });

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download filing package (ZIP)' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^taxpro-uk-filing-package-2026-01-01\.zip$/);
  const checksumLine = page.getByText(/manifest sha256: [0-9a-f]{64}/);
  await expect(checksumLine).toBeVisible({ timeout: 30_000 });
  const manifestSha = (await checksumLine.textContent())!.replace(/.*sha256: /, '').trim();

  await page.getByPlaceholder('Filing provider (e.g. IRIS)').fill('IRIS');
  const filingReference = `E2E-JOURNEY-${Date.now()}`;
  await page.getByPlaceholder('Filing reference').fill(filingReference);
  await page.getByPlaceholder('Manifest SHA-256 (from package)').fill(manifestSha);
  await page.locator('input[type="date"]').fill('2026-08-05');
  await page.getByRole('button', { name: 'Record filing', exact: true }).click();
  await expect(page.getByText('External filing records', { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('tbody tr').filter({ hasText: filingReference })).toBeVisible();
  await expect(page.getByText('Filed externally (recorded)', { exact: true })).toBeVisible();

  // Tenant isolation still holds after the full lifecycle.
  const otherTenant = `journey-iso-${Date.now()}@taxpro.ai`;
  const reg = await api.post('/api/auth/register', {
    data: { email: otherTenant, password: 'TaxProDemo123!', tenantName: 'Isolation Ltd', tenantSlug: `journey-${Date.now()}` },
  });
  expect([200, 201]).toContain(reg.status());
  const otherToken = (await reg.json()).token;
  const probe = await api.get(`/api/handoff/runs/${runId}`, {
    headers: { Authorization: `Bearer ${otherToken}` },
  });
  expect([400, 404]).toContain(probe.status());

  // Zero console errors across both sessions.
  expect(consoleErrors).toEqual([]);

  await adminContext.close();
});
