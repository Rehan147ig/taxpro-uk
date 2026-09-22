import { test, expect } from '@playwright/test';
import { login } from './helpers';

const QUOTA_402 = {
  error: 'Included runs used (1/1 on Pilot). This run bills at £50 — upgrade for more included runs.',
  details: {
    planCode: 'pilot',
    subscriptionStatus: 'trialing',
    includedRunsPerMonth: 1,
    usedRuns: 1,
    upgradeRequired: true,
  },
};

async function openProvision(page: any) {
  await page.getByRole('link', { name: 'Provision', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Tax Provision' })).toBeVisible();
}

test('quota wall: 402 opens the upgrade modal with usage and plan details', async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await login(page);
  await openProvision(page);

  await page.route('**/api/provision/run', (route) =>
    route.fulfill({ status: 402, contentType: 'application/json', body: JSON.stringify(QUOTA_402) }),
  );
  await page.route('**/api/billing/provider', (route) =>
    route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ provider: 'local', capabilities: { hostedCheckout: false, portal: false, manualBilling: true } }),
    }),
  );

  await page.getByRole('button', { name: 'Run Provision Engine' }).click();
  const dialog = page.getByRole('dialog', { name: 'Billing quota wall' });
  await expect(dialog).toBeVisible({ timeout: 15_000 });
  await expect(dialog.getByText('Monthly runs used up')).toBeVisible();
  await expect(dialog.getByText('1 of 1 included runs')).toBeVisible();
  await expect(dialog.getByText(/pilot plan/)).toBeVisible();

  await ctx.close();
});

test('quota wall: manual provider shows sales instructions, hosted shows checkout link', async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await login(page);
  await openProvision(page);

  await page.route('**/api/provision/run', (route) =>
    route.fulfill({ status: 402, contentType: 'application/json', body: JSON.stringify(QUOTA_402) }),
  );
  await page.route('**/api/billing/provider', (route) =>
    route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ provider: 'local', capabilities: { hostedCheckout: false, portal: false, manualBilling: true } }),
    }),
  );
  await page.route('**/api/billing/checkout', (route) =>
    route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({
        provider: 'local', checkoutUrl: null, mode: 'manual',
        message: 'Manual billing: contact sales to activate professional (monthly).',
      }),
    }),
  );

  await page.getByRole('button', { name: 'Run Provision Engine' }).click();
  const dialog = page.getByRole('dialog', { name: 'Billing quota wall' });
  await expect(dialog).toBeVisible({ timeout: 15_000 });
  await dialog.getByRole('button', { name: 'Upgrade to professional' }).click();
  await expect(dialog.getByText(/Manual billing: contact sales/)).toBeVisible();

  // Hosted branch: checkout URL renders as a real link (no surprise redirect).
  // Re-trigger the wall for a fresh modal — the first checkout is already done.
  await page.route('**/api/billing/checkout', (route) =>
    route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({
        provider: 'dodo', checkoutUrl: 'https://checkout.example/s/ses_1', mode: 'hosted',
        message: 'Hosted Dodo checkout for professional (monthly).',
      }),
    }),
  );
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole('button', { name: 'Run Provision Engine' }).click();
  await expect(dialog).toBeVisible({ timeout: 15_000 });
  await dialog.getByRole('button', { name: 'Upgrade to professional' }).click();
  const link = dialog.getByRole('link', { name: /Continue to secure checkout/ });
  await expect(link).toBeVisible();
  expect(await link.getAttribute('href')).toBe('https://checkout.example/s/ses_1');

  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).toHaveCount(0);

  await ctx.close();
});
