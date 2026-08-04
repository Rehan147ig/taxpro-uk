import { test, expect } from '@playwright/test';
import { login, ADMIN_EMAIL, PARTNER_EMAIL } from './helpers';

test('handoff: run -> review -> submit -> partner sign-off -> lock -> filing-ready -> package -> record external filing -> tenant isolation', async ({ browser }) => {
  const adminContext = await browser.newContext();
  const page = await adminContext.newPage();
  await login(page, ADMIN_EMAIL);

  // ── Workbench: import sample chart, run a calculation ──
  await page.getByRole('link', { name: 'Workbench', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'UK Tax-Close Workbench' })).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(page.getByText(/Import (complete|replayed)/)).toBeVisible({ timeout: 60_000 });

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
    // Seeded pending proposal must be decided by a human first (AI proposes, humans decide).
    await expect(page.getByText(/mapping_proposals_pending/)).toBeVisible();
    await page.getByRole('link', { name: 'Proposals & Rules' }).click();
    await expect(page.getByRole('heading', { name: /Governance/ })).toBeVisible({ timeout: 30_000 });
    const approveButton = page.getByRole('button', { name: 'Approve & Apply' }).first();
    await approveButton.waitFor({ state: 'visible', timeout: 30_000 });
    await page.getByPlaceholder('Decision reason (required)').fill('Approved in handoff E2E: deductible cloud hosting.');
    await approveButton.click();
    await expect(page.getByRole('button', { name: 'Approve & Apply' })).toHaveCount(0, { timeout: 30_000 });
    await page.getByRole('link', { name: 'Workbench', exact: true }).click();
    await page.getByRole('button', { name: 'Refresh' }).click();
    await page.getByRole('button', { name: 'Run Workbench Calculation' }).click();
  }

  // ── Run succeeds; capture the run id ──
  const runLink = page.getByRole('link', { name: 'Open in Review →' }).first();
  await runLink.waitFor({ state: 'visible', timeout: 90_000 });
  const runId = (await runLink.getAttribute('href'))!.replace('/runs/', '');
  expect(runId).toMatch(/^[0-9a-f-]{36}$/);

  // ── Resolve review items, submit, partner sign-off (different user), lock ──
  await runLink.click();
  await expect(page.getByRole('heading', { name: /Provision/ })).toBeVisible({ timeout: 30_000 });

  const approveAll = page.getByRole('button', { name: 'Approve All Items' });
  if (await approveAll.isVisible().catch(() => false)) {
    await approveAll.click();
    await expect(page.getByRole('button', { name: 'Approve All Items' })).toHaveCount(0, { timeout: 30_000 });
  }

  await page.getByRole('button', { name: 'Submit for Approval' }).click();
  await expect(page.getByRole('button', { name: 'Partner Sign-off' })).toBeVisible({ timeout: 30_000 });

  // Partner signs off from their own session (self-approval is forbidden).
  const partnerContext = await browser.newContext();
  const partnerPage = await partnerContext.newPage();
  await login(partnerPage, PARTNER_EMAIL);
  await partnerPage.goto(`/runs/${runId}`);
  await expect(page.getByRole('button', { name: 'Partner Sign-off' })).toBeVisible({ timeout: 30_000 });
  await partnerPage.getByRole('button', { name: 'Partner Sign-off' }).click();
  await expect(partnerPage.getByText(/Approved by/)).toBeVisible({ timeout: 30_000 });
  await partnerContext.close();

  // Back in the admin session: reload the run page and lock it.
  await page.reload();
  await expect(page.getByRole('button', { name: 'Lock Final Provision' })).toBeVisible({ timeout: 30_000 });
  page.on('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'Lock Final Provision' }).click();
  await expect(page.getByText('Locked', { exact: true }).first()).toBeVisible({ timeout: 30_000 });

  // ── Workbench run detail: filing-handoff panel on the locked run ──
  await page.getByRole('link', { name: 'Workbench', exact: true }).click();
  await page.getByRole('button', { name: 'Refresh' }).click();
  const lockedRow = page.locator('tbody tr').filter({ hasText: 'locked' }).first();
  await lockedRow.getByRole('button', { name: 'View run', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Run detail' })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('Filing handoff', { exact: true })).toBeVisible({ timeout: 30_000 });

  // Honesty contract is rendered, gates are clean, validation shown.
  await expect(page.getByText(/TaxPro does not submit to HMRC/)).toBeVisible();
  await expect(page.getByText(/Filing-ready handoff is blocked/)).toHaveCount(0);
  await expect(page.getByText('CT600 figures', { exact: false })).toBeVisible();
  await expect(page.getByText(/valid/, { exact: false }).first()).toBeVisible();

  // ── Mark filing-ready (handoff) ──
  await page.getByRole('button', { name: 'Mark filing-ready (handoff)' }).click();
  await expect(page.getByText('Filing-ready handoff', { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('button', { name: 'Mark filing-ready (handoff)' })).toHaveCount(0);

  // ── Download the deterministic package; manifest SHA-256 is captured ──
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download filing package (ZIP)' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^taxpro-uk-filing-package-2026-01-01\.zip$/);

  const checksumLine = page.getByText(/manifest sha256: [0-9a-f]{64}/);
  await expect(checksumLine).toBeVisible({ timeout: 30_000 });
  const manifestSha = (await checksumLine.textContent())!.replace(/.*sha256: /, '').trim();

  // The checksum is auto-prefilled into the filing form from the package header.
  const checksumInput = page.getByPlaceholder('Manifest SHA-256 (from package)');
  await expect(checksumInput).toHaveValue(manifestSha, { timeout: 15_000 });

  // ── A tampered checksum is refused (re-verified against the deterministic manifest) ──
  await page.getByPlaceholder('Filing provider (e.g. IRIS)').fill('IRIS');
  await page.getByPlaceholder('Filing reference').fill(`E2E-BAD-${Date.now()}`);
  await checksumInput.fill('a'.repeat(64));
  await page.locator('input[type="date"]').fill('2026-08-04');
  await page.getByRole('button', { name: 'Record filing', exact: true }).click();
  await expect(page.getByText(/does not match/)).toBeVisible({ timeout: 30_000 });

  // ── Record an EXTERNAL filing (already submitted outside TaxPro) ──
  const filingReference = `E2E-${Date.now()}`;
  await checksumInput.fill(manifestSha);
  await page.getByPlaceholder('Filing reference').fill(filingReference);
  await page.locator('input[type="date"]').fill('2026-08-05');
  await page.getByRole('button', { name: 'Record filing', exact: true }).click();

  await expect(page.getByText('External filing records', { exact: true })).toBeVisible({ timeout: 30_000 });
  const filingRow = page.locator('tbody tr').filter({ hasText: filingReference });
  await expect(filingRow).toBeVisible();
  await expect(filingRow).toContainText('IRIS');
  await expect(page.getByText('Filed externally (recorded)', { exact: true })).toBeVisible();
  await expect(page.getByText(/TaxPro did not submit this return/)).toBeVisible();

  // ── Tenant isolation: a new tenant cannot read the handoff surface ──
  const adminToken = await page.evaluate(() => localStorage.getItem('taxpro_token'));
  const apiRequest = adminContext.request;
  const authHeader = { Authorization: `Bearer ${adminToken}` };
  const otherTenant = `handoff-iso-${Date.now()}@taxpro.ai`;
  const reg = await apiRequest.post('/api/auth/register', {
    data: { email: otherTenant, password: 'TaxProDemo123!', tenantName: 'Isolation Ltd', tenantSlug: `handoff-${Date.now()}` },
  });
  expect([200, 201]).toContain(reg.status());
  const otherBody = await reg.json();

  const probeView = await apiRequest.get(`/api/handoff/runs/${runId}`, {
    headers: { Authorization: `Bearer ${otherBody.token}` },
  });
  expect([400, 404]).toContain(probeView.status());
  const probePackage = await apiRequest.get(`/api/handoff/runs/${runId}/package`, {
    headers: { Authorization: `Bearer ${otherBody.token}` },
  });
  expect([400, 403, 404]).toContain(probePackage.status());

  // The owner can still read the handoff view and re-download a deterministic package.
  const ownerView = await apiRequest.get(`/api/handoff/runs/${runId}`, { headers: authHeader });
  expect(ownerView.status()).toBe(200);
  const ownerJson = await ownerView.json();
  expect(ownerJson.lifecycle.stage).toBe('filed_externally');
  expect(ownerJson.externalFilings.some((f: any) => f.filingReference === filingReference)).toBe(true);

  const ownerPackage = await apiRequest.get(`/api/handoff/runs/${runId}/package`, { headers: authHeader });
  expect(ownerPackage.status()).toBe(200);
  expect(ownerPackage.headers()['x-manifest-sha256']).toBe(manifestSha);

  await adminContext.close();
});
