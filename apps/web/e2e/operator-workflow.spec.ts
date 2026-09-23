import { test, expect } from '@playwright/test';
import { login, PARTNER_EMAIL } from './helpers';

test('operator workflow: provision -> review -> partner sign-off -> lock -> audit -> export', async ({ browser }) => {
  // ── Admin session: run a provision ──
  const adminContext = await browser.newContext();
  const page = await adminContext.newPage();
  await login(page);

  await page.getByRole('link', { name: 'Provision', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Tax Provision' })).toBeVisible();

  // Use a fresh period so the backend's approved/locked-run deduplication
  // cannot turn this UI test into an empty-review-path test on reruns.
  const periodSeed = Math.floor(Date.now() / 1000);
  const testYear = 2030 + Math.floor(periodSeed / 12) % 20;
  const testMonth = (periodSeed % 12) + 1;
  const testMonthText = String(testMonth).padStart(2, '0');
  const testPeriod = `${testYear}-${testMonthText}`;
  const testPeriodStart = `${testPeriod}-01`;

  // The provision engine only runs over periods that have trial-balance rows,
  // so seed a minimal chart for the fresh period via the import API (the
  // generic import reads the period from the CSV rows; entity + accounts are
  // upserted per tenant, keeping this rerunnable).
  const adminToken = await page.evaluate(() => localStorage.getItem('taxpro_token'));
  const importResp = await adminContext.request.post('/api/import/trial-balance', {
    headers: { Authorization: `Bearer ${adminToken}` },
    data: {
      source: 'e2e',
      csv: [
        'entity,entityName,accountNumber,accountName,accountType,period,periodEnd,debit,credit,balance,currency',
        `ACME-UK,Acme UK Ltd,4000,Sales revenue,Income,${testPeriodStart},${testPeriodStart},0,285000,285000,GBP`,
        `ACME-UK,Acme UK Ltd,5200,Book depreciation - Fixed Asset,Expense,${testPeriodStart},${testPeriodStart},45000,0,-45000,GBP`,
        `ACME-UK,Acme UK Ltd,9000,Consultancy fees,Expense,${testPeriodStart},${testPeriodStart},20000,0,-20000,GBP`,
      ].join('\n'),
    },
  });
  expect([200, 201]).toContain(importResp.status());

  const monthInput = page.locator('input[type="month"]').first();
  await monthInput.fill(testPeriod);
  await page.getByRole('button', { name: 'Run Provision' }).click();
  await expect(page.getByText('Calculating Math...')).toBeVisible();

  await expect(page.getByRole('link', { name: 'Open Audit Workspace →' })).toBeVisible({ timeout: 150_000 });
  const runIdFromUrl = await page.getByRole('link', { name: 'Open Audit Workspace →' }).getAttribute('href');
  expect(runIdFromUrl).toMatch(/\/runs\//);

  // ── Run detail: resolve the deterministic review item ──
  await page.getByRole('link', { name: 'Open Audit Workspace →' }).click();
  await expect(page).toHaveURL(/\/runs\/\w+/);
  await expect(page.getByRole('heading', { name: /Provision$/ }).first()).toBeVisible();

  // ── Verify review items are displayed (should have at least one) ──
  await expect(page.getByText(/missing depreciation metadata|Review AI mapping|Missing tax mapping/i).first()).toBeVisible({ timeout: 15_000 });

  for (let i = 0; i < 8; i++) {
    const approve = page.getByRole('button', { name: 'Approve AI Choice' }).first();
    try {
      await approve.waitFor({ state: 'visible', timeout: 5000 });
      await approve.click();
      await page.waitForTimeout(400);
    } catch {
      break;
    }
  }
  await expect(page.getByRole('button', { name: 'Submit for Approval' })).toBeVisible();

  // ── Navigate to AI Findings page and verify it loads ──
  await page.getByRole('link', { name: 'AI Findings' }).click();
  await expect(page.getByRole('heading', { name: /AI|Findings|Agent/ }).first()).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('body')).not.toContainText('Error loading', { timeout: 5_000 });
  await page.getByRole('link', { name: 'Back to Run Detail' }).click();

  // ── Submit for partner approval ──
  await page.getByRole('button', { name: 'Submit for Approval' }).click();
  await expect(page.getByRole('button', { name: 'Partner Sign-off' })).toBeVisible({ timeout: 30_000 });

  // ── Partner (separate session) opens the run and signs off ──
  const partnerContext = await browser.newContext();
  const pPage = await partnerContext.newPage();
  await login(pPage, PARTNER_EMAIL);

  await pPage.getByRole('link', { name: 'Review Queue', exact: true }).click();
  const runRow = pPage.locator('tbody tr').filter({ hasText: testPeriodStart }).first();
  await runRow.click();
  await expect(pPage.getByRole('button', { name: 'Partner Sign-off' })).toBeVisible();
  await pPage.getByRole('button', { name: 'Partner Sign-off' }).click();
  await expect(pPage.getByRole('button', { name: 'Lock Final Provision' })).toBeVisible({ timeout: 30_000 });
  await partnerContext.close();

  // ── Admin locks the final provision (reload to see the partner's approval) ──
  await page.reload();
  await expect(page.getByRole('button', { name: 'Lock Final Provision' })).toBeVisible({ timeout: 30_000 });
  page.on('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'Lock Final Provision' }).click();
  await expect(page.getByText('Locked', { exact: true }).first()).toBeVisible({ timeout: 30_000 });

  // ── Locked state: TB mapping controls are read-only ──
  await page.getByRole('button', { name: 'GL Trial Balance' }).click();
  await expect(page.locator('table select')).toHaveCount(0, { timeout: 15_000 });

  // ── Mutation after lock is rejected with 409 (API-level proof) ──
  const adminRequest = await adminContext.request;
  const authHeader = { Authorization: `Bearer ${adminToken}` };
  const runId = runIdFromUrl!.replace('/runs/', '');
  const mappings = await (await adminRequest.get('/api/mapping/mappings', { headers: authHeader })).json();
  expect(Array.isArray(mappings)).toBe(true);
  const accountId = mappings[0]?.accountId ?? mappings[0]?.id;
  expect(accountId).toBeTruthy();
  const overrideResp = await adminRequest.post(`/api/mapping/mappings/${accountId}/override`, {
    headers: authHeader,
    data: { taxAccountType: 'PERM_OTHER', bookTreatment: 'permanent', provisionRunId: runId },
  });
  expect(overrideResp.status()).toBe(409);

  // ── Audit trail records the whole lifecycle ──
  await page.getByRole('link', { name: 'Audit Events' }).click();
  await expect(page.getByText('run.locked').first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('submitted_for_approval')).toBeVisible();
  await expect(page.getByText('partner.approved')).toBeVisible();

  // ── Export package downloads a valid ZIP with content verification ──
  await page.getByRole('link', { name: 'Back to Run Detail' }).click();
  await page.getByRole('link', { name: 'Exports' }).click();
  await expect(page.getByRole('heading', { name: 'Export Package' })).toBeVisible();

  // Verify export page shows validation-ready language (not filing-ready)
  const exportPageText = await page.textContent('body');
  expect(exportPageText).toContain('not filing-ready');
  expect(exportPageText).not.toMatch(/filing is ready|submit to HMRC/i);

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download Package (.zip)' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.zip$/);

  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream!) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const fullBuf = Buffer.concat(chunks);

  // Verify download is non-empty
  expect(fullBuf.length).toBeGreaterThan(100);

  // Verify ZIP magic bytes
  const head = fullBuf.subarray(0, 4);
  expect(head.subarray(0, 2).toString('latin1')).toBe('PK');

  // Verify the ZIP contains expected entries (basic check)
  const fileContent = fullBuf.toString('latin1');
  expect(fileContent).toContain('manifest.json');
  expect(fileContent).toContain('review-items.csv');
  expect(fileContent).toContain('approval-trail.json');

  // ── Dashboard shows the provision workflow checklist ──
  await page.getByRole('link', { name: 'Dashboard' }).click();
  await expect(page.getByText('Provision Workflow Checklist')).toBeVisible({ timeout: 10_000 });

  await adminContext.close();
});
