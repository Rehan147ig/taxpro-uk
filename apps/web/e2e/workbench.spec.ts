import { test, expect } from '@playwright/test';
import { login } from './helpers';

test('workbench: import -> gated run -> recalc (new version) -> view provenance -> tenant isolation', async ({ browser }) => {
  const adminContext = await browser.newContext();
  const page = await adminContext.newPage();
  await login(page);

  // ── Workbench setup loads with UK defaults ──
  await page.getByRole('link', { name: 'Workbench', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'UK Tax-Close Workbench' })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByLabel('UK entity').locator('option').first()).toHaveText('Select entity…');
  await expect(page.getByLabel('UK entity')).toContainText('Acme UK Ltd');

  // ── Import the sample chart (idempotent) ──
  await expect(page.locator('textarea')).toContainText('4000,Sales revenue');
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(page.getByText(/Import (complete|replayed)/)).toBeVisible({ timeout: 60_000 });

  // ── First run attempt: gate may block on the seeded pending proposal ──
  await page.getByRole('button', { name: 'Run Workbench Calculation' }).click();
  const blockedBanner = page.getByText('Run blocked', { exact: false });
  let blocked = false;
  try {
    await blockedBanner.waitFor({ state: 'visible', timeout: 15_000 });
    blocked = true;
  } catch {
    // Run not blocked; the calculation went straight through.
  }
  if (blocked) {
    // Gate surfaced in the UI with its code.
    await expect(page.getByText(/mapping_proposals_pending/)).toBeVisible();

    // Human decision on the pending proposal clears the gate (AI proposes, humans decide).
    await page.getByRole('link', { name: 'Proposals & Rules' }).click();
    await expect(page.getByRole('heading', { name: /Governance/ })).toBeVisible({ timeout: 30_000 });
    const approveButton = page.getByRole('button', { name: 'Approve & Apply' }).first();
    await approveButton.waitFor({ state: 'visible', timeout: 30_000 });
    await page.getByPlaceholder('Decision reason (required)').fill('Approved in E2E: cloud hosting is deductible, VAT split confirmed.');
    await approveButton.click();
    await expect(page.getByRole('button', { name: 'Approve & Apply' })).toHaveCount(0, { timeout: 30_000 });

    // Back to the workbench and retry the run.
    await page.getByRole('link', { name: 'Workbench', exact: true }).click();
    await page.getByRole('button', { name: 'Refresh' }).click();
    await page.getByRole('button', { name: 'Run Workbench Calculation' }).click();
  }

  // ── Run succeeds; result card with summary + review items ──
  await expect(page.getByRole('link', { name: 'Open in Review →' })).toBeVisible({ timeout: 90_000 });
  await expect(page.getByText(/Total tax expense/)).toBeVisible();
  await expect(page.getByText(/input hash/)).toBeVisible();

  // Missing mapping + low-confidence mapping review items are flagged.
  await expect(page.getByText(/review item\(s\) require attention/)).toBeVisible({ timeout: 30_000 });

  // ── Recalculate creates a new version (parent link) ──
  await page.getByRole('button', { name: /Recalculate/ }).click();
  await expect(page.getByText(/Version of run/)).toBeVisible({ timeout: 60_000 });

  // ── View run from the recent-runs table: provenance, assumptions, items ──
  // The table lists ALL provision runs (incl. other specs' runs), so scope to
  // the workbench runs, which use the standard 2026-01-01 tax period.
  const wbRow = page.locator('tbody tr').filter({ hasText: '2026-01-01' }).first();
  await wbRow.getByRole('button', { name: 'View run', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Run detail' })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('Assumptions', { exact: true })).toBeVisible();
  await expect(page.getByText('25% applied per fiscal year', { exact: false })).toBeVisible();
  // The book-depreciation asset (5200, no placed-in-service date) always
  // produces a deterministic review item + engine warning on every run.
  await expect(page.getByText('missing_depreciation_metadata', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('open', { exact: true }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Close', exact: true }).click();

  // ── Run id is captured for the isolation probe ──
  const runLink = page.getByRole('link', { name: 'Open in Review →' }).first();
  const runIdFromUrl = await runLink.getAttribute('href');
  expect(runIdFromUrl).toMatch(/\/runs\//);
  const runId = runIdFromUrl!.replace('/runs/', '');

  // ── Tenant isolation: a brand-new tenant cannot read this run (RLS fail-closed) ──
  const adminToken = await page.evaluate(() => localStorage.getItem('taxpro_token'));
  const adminRequest = await adminContext.request;
  const authHeader = { Authorization: `Bearer ${adminToken}` };
  const otherTenant = `iso-${Date.now()}@taxpro.ai`;
  const reg = await adminRequest.post('/api/auth/register', {
    data: { email: otherTenant, password: 'TaxProDemo123!', tenantName: 'Isolation Ltd', tenantSlug: `iso-${Date.now()}` },
  });
  expect([200, 201]).toContain(reg.status());
  const otherBody = await reg.json();
  const otherToken = otherBody.token;
  expect(otherToken).toBeTruthy();

  const probe = await adminRequest.get(`/api/workbench/runs/${runId}`, {
    headers: { Authorization: `Bearer ${otherToken}` },
  });
  expect([400, 404]).toContain(probe.status());

  // The owner can still read it.
  const ownerProbe = await adminRequest.get(`/api/workbench/runs/${runId}`, { headers: authHeader });
  expect(ownerProbe.status()).toBe(200);

  await adminContext.close();
});
