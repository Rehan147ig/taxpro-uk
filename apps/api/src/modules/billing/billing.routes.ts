import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { withTenantContext } from '../../config/db.js';
import { authMiddleware } from '../../lib/middleware/auth.js';
import { getUser } from '../../lib/middleware/rbac.js';
import { BadRequestError } from '../../lib/errors.js';
import { summarizeUsage, buildInvoiceLines, pricePerProvision } from './usage.js';
import { checkProvisionEntitlement, ensureTenantSubscription } from './entitlements.js';
import { getBillingProvider, getBillingProviderName, ProviderNotConfiguredError } from './provider.js';
import { tenantSubscriptions } from '../../db/schema/billing.js';
import { billingPlans } from '../../db/schema/billing.js';

export const billingRoutes = new Hono();
billingRoutes.use('*', authMiddleware);

billingRoutes.get('/usage', async (c) => {
  const user = getUser(c);
  const from = c.req.query('from');
  const to = c.req.query('to');
  if (from && !/^\d{4}-\d{2}-\d{2}/.test(from)) throw new BadRequestError('from must be an ISO date');
  if (to && !/^\d{4}-\d{2}-\d{2}/.test(to)) throw new BadRequestError('to must be an ISO date');

  return withTenantContext(user.tenantId, async (tx) => {
    await ensureTenantSubscription(tx, user.tenantId);
    const summary = await summarizeUsage(tx, { tenantId: user.tenantId, from, to });
    const entitlement = await checkProvisionEntitlement(tx, user.tenantId);
    return c.json({ ...summary, pricePerProvision: pricePerProvision(), entitlement });
  });
});

billingRoutes.get('/invoice', async (c) => {
  const user = getUser(c);
  const from = c.req.query('from');
  const to = c.req.query('to') ?? new Date().toISOString().slice(0, 10);
  return withTenantContext(user.tenantId, async (tx) => {
    // Totals are summed from immutable usage-event amounts — changing
    // BILLING_PRICE_PER_PROVISION never rewrites a historical invoice.
    const invoice = await buildInvoiceLines(tx, { tenantId: user.tenantId, from, to });
    return c.json({ tenantId: user.tenantId, invoice });
  });
});

/**
 * Current plan / subscription / entitlement for the tenant.
 * The frontend Billing page and the Workbench "included runs remaining"
 * display read from here. Guards (not this endpoint) enforce limits.
 */
billingRoutes.get('/subscription', async (c) => {
  const user = getUser(c);
  return withTenantContext(user.tenantId, async (tx) => {
    await ensureTenantSubscription(tx, user.tenantId);
    const entitlement = await checkProvisionEntitlement(tx, user.tenantId);
    let subscription: unknown = null;
    try {
      const rows = await tx.select({
        status: tenantSubscriptions.status,
        billingInterval: tenantSubscriptions.billingInterval,
        includedRunsPerMonth: tenantSubscriptions.includedRunsPerMonth,
        currentPeriodStart: tenantSubscriptions.currentPeriodStart,
        currentPeriodEnd: tenantSubscriptions.currentPeriodEnd,
        trialEndsAt: tenantSubscriptions.trialEndsAt,
        planCode: billingPlans.code,
        planName: billingPlans.name,
        planDescription: billingPlans.description,
        overagePricePerRun: billingPlans.overagePricePerRun,
        maxEntities: billingPlans.maxEntities,
        maxSeats: billingPlans.maxSeats,
      })
        .from(tenantSubscriptions)
        .leftJoin(billingPlans, eq(tenantSubscriptions.planId, billingPlans.id))
        .where(eq(tenantSubscriptions.tenantId, user.tenantId))
        .limit(1);
      subscription = rows?.[0] ?? null;
    } catch {
      subscription = null;
    }
    return c.json({ tenantId: user.tenantId, subscription, entitlement });
  });
});

/**
 * Provider-neutral billing endpoints (P0-neutral).
 * The frontend branches on `mode`: 'hosted' (redirect to checkoutUrl /
 * portalUrl) vs 'manual' (show sales-contact instructions). Switching
 * BILLING_PROVIDER from local → stripe/dodo later changes the response,
 * never the contract.
 */
billingRoutes.get('/provider', async (c) => {
  const provider = getBillingProviderName();
  return c.json({
    provider,
    capabilities: provider === 'local'
      ? { hostedCheckout: false, portal: false, manualBilling: true }
      : { hostedCheckout: true, portal: true, manualBilling: false },
  });
});

billingRoutes.post('/checkout', async (c) => {
  const user = getUser(c);
  const body = await c.req.json().catch(() => ({})) as { planCode?: string; billingInterval?: 'monthly' | 'annual' };
  try {
    const provider = getBillingProvider();
    const result = await provider.createCheckout({
      tenantId: user.tenantId,
      planCode: body.planCode ?? 'professional',
      billingInterval: body.billingInterval ?? 'monthly',
    });
    return c.json(result);
  } catch (err) {
    if (err instanceof ProviderNotConfiguredError) {
      return c.json({ provider: getBillingProviderName(), mode: 'manual', checkoutUrl: null, message: err.message }, 501);
    }
    throw err;
  }
});

billingRoutes.post('/portal', async (c) => {
  const user = getUser(c);
  try {
    const provider = getBillingProvider();
    return c.json(await provider.createPortalSession({ tenantId: user.tenantId }));
  } catch (err) {
    if (err instanceof ProviderNotConfiguredError) {
      return c.json({ provider: getBillingProviderName(), mode: 'manual', portalUrl: null, message: err.message }, 501);
    }
    throw err;
  }
});
