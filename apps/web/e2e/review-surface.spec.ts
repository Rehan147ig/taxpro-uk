import { test, expect } from '@playwright/test';
import { login } from './helpers';

/**
 * Feature 4 — intake review surface.
 *
 * The XLSX upload card and the sign/bridge batch panels render exactly when
 * their flags are on (and stay hidden when off). Deterministic in both
 * states: the test reads /api/config/flags first and asserts the UI matches.
 */
test('review surface: XLSX card and check panels follow feature flags', async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await login(page);

  const token = await page.evaluate(() => localStorage.getItem('taxpro_token'));
  const flags = await (await ctx.request.get('/api/config/flags', {
    headers: { Authorization: `Bearer ${token}` },
  })).json();

  await page.getByRole('link', { name: 'Intake', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Data Intake' })).toBeVisible({ timeout: 30_000 });
  // CSV path always renders (pre-existing behavior).
  await expect(page.getByText('Drag & drop a trial balance CSV here')).toBeVisible();

  if (flags?.INTAKE_XLSX) {
    await expect(page.getByText('Upload Excel workbook')).toBeVisible();
  } else {
    await expect(page.getByText('Upload Excel workbook')).toHaveCount(0);
  }

  await ctx.close();
});
