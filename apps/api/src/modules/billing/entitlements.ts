import { and, eq, gte } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { tenantSubscriptions, billingPlans, tenantEntitlements } from '../../db/schema/billing.js';
import { usageEvents } from '../../db/schema/usage-events.js';
import { PLANS, getPlan, type PlanCode } from './plans.js';
import { BILLING, pricePerProvision, summarizeUsage } from './usage.js';
import { PaymentRequiredError } from '../../lib/errors.js';

/**
 * Plan / entitlement guard (Sprint 2).
 *
 * Called BEFORE starting an expensive workflow (POST /api/provision/run).
 * Determines whether the next run is free_trial / included / overage, and
 * blocks only when the subscription itself is not in good standing
 * (past_due / cancelled / expired). Overage runs are allowed but marked
 * billable with an upgrade prompt — the upgrade nudge appears at a natural
 * value boundary (after the included runs are used), not during onboarding.
 *
 * Frontend hiding alone is not sufficient: this guard runs at the API
 * boundary because users can call endpoints directly.
 */

export type EntitlementDecision = 'free_trial' | 'included' | 'overage';

export interface EntitlementCheck {
  allowed: boolean;
  decision: EntitlementDecision;
  planCode: PlanCode;
  planName: string;
  subscriptionStatus: string;
  includedRunsPerMonth: number;
  usedRuns: number;
  remainingRuns: number;
  /** Snapshot price for the NEXT run (0 when free/included). */
  unitPrice: number;
  currency: string;
  upgradeRequired: boolean;
  message: string;
}

export function currentMonthStart(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
}

interface SubscriptionRow {
  status: string;
  includedRunsPerMonth: number;
  planCode: PlanCode;
  planName: string;
  overagePrice: number;
}

async function loadSubscription(tx: any, tenantId: string): Promise<SubscriptionRow> {
  const fallback: SubscriptionRow = {
    status: 'trialing',
    includedRunsPerMonth: PLANS.pilot.includedRunsPerMonth,
    planCode: 'pilot',
    planName: PLANS.pilot.name,
    overagePrice: PLANS.pilot.overagePricePerRun,
  };
  try {
    const rows = await tx.select({
      status: tenantSubscriptions.status,
      includedRuns: tenantSubscriptions.includedRunsPerMonth,
      planCode: billingPlans.code,
      planName: billingPlans.name,
      planOverage: billingPlans.overagePricePerRun,
      planIncluded: billingPlans.includedRunsPerMonth,
    })
      .from(tenantSubscriptions)
      .leftJoin(billingPlans, eq(tenantSubscriptions.planId, billingPlans.id))
      .where(eq(tenantSubscriptions.tenantId, tenantId))
      .limit(1);
    const row = rows?.[0];
    if (!row) return fallback;
    const plan = getPlan(row.planCode as string);
    return {
      status: String(row.status ?? 'trialing'),
      includedRunsPerMonth: Number(row.includedRuns ?? row.planIncluded ?? plan.includedRunsPerMonth),
      planCode: (row.planCode as PlanCode) ?? 'pilot',
      planName: String(row.planName ?? plan.name),
      overagePrice: Number(row.planOverage ?? plan.overagePricePerRun),
    };
  } catch {
    return fallback;
  }
}

async function loadRunOverride(tx: any, tenantId: string): Promise<{ allowed: boolean; limitValue: number | null } | null> {
  try {
    const rows = await tx.select({
      allowed: tenantEntitlements.allowed,
      limitValue: tenantEntitlements.limitValue,
      expiresAt: tenantEntitlements.expiresAt,
    })
      .from(tenantEntitlements)
      .where(and(eq(tenantEntitlements.tenantId, tenantId), eq(tenantEntitlements.featureKey, 'provision_runs')))
      .limit(1);
    const row = rows?.[0];
    if (!row) return null;
    if (row.expiresAt && new Date(row.expiresAt).getTime() < Date.now()) return null;
    return { allowed: Boolean(row.allowed), limitValue: row.limitValue ?? null };
  } catch {
    return null;
  }
}

async function countMonthRuns(tx: any, tenantId: string): Promise<number> {
  try {
    const monthStart = currentMonthStart();
    const rows = await tx.select({ id: usageEvents.id }).from(usageEvents)
      .where(and(eq(usageEvents.tenantId, tenantId), gte(usageEvents.occurredAt, monthStart)));
    return rows.length;
  } catch {
    // Fall back to the summary path (works with test doubles).
    try {
      const summary = await summarizeUsage(tx as NodePgDatabase<any>, {
        tenantId,
        from: currentMonthStart().toISOString(),
      });
      return summary.runs;
    } catch {
      return 0;
    }
  }
}

/** Ensure the tenant has a subscription row (auto-provision pilot/trialing). Best-effort. */
export async function ensureTenantSubscription(tx: any, tenantId: string): Promise<void> {
  try {
    const existing = await tx.select({ id: tenantSubscriptions.id }).from(tenantSubscriptions)
      .where(eq(tenantSubscriptions.tenantId, tenantId)).limit(1);
    if (existing?.length > 0) return;
    let planId: string | null = null;
    try {
      const plans = await tx.select({ id: billingPlans.id }).from(billingPlans)
        .where(eq(billingPlans.code, 'pilot')).limit(1);
      planId = plans?.[0]?.id ?? null;
    } catch {
      planId = null;
    }
    const insert: any = (tx as any).insert(tenantSubscriptions).values({
      tenantId,
      planId,
      status: 'trialing',
      billingInterval: 'monthly',
      includedRunsPerMonth: BILLING.TRIAL_FREE_RUNS_PER_MONTH,
      currentPeriodStart: currentMonthStart(),
      currentPeriodEnd: new Date(Date.UTC(
        currentMonthStart().getUTCFullYear(), currentMonthStart().getUTCMonth() + 1, 1,
      )),
    });
    if (insert && typeof insert.onConflictDoNothing === 'function') {
      await insert.onConflictDoNothing({ target: [tenantSubscriptions.tenantId] });
    } else {
      await insert;
    }
  } catch {
    // Best-effort: entitlement checks fall back to pilot defaults.
  }
}

export async function checkProvisionEntitlement(
  tx: any,
  tenantId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<EntitlementCheck> {
  const sub = await loadSubscription(tx, tenantId);
  const override = await loadRunOverride(tx, tenantId);

  if (override && override.allowed === false) {
    const usedForOverride = await countMonthRuns(tx, tenantId);
    return {
      allowed: false,
      decision: 'overage',
      planCode: sub.planCode,
      planName: sub.planName,
      subscriptionStatus: sub.status,
      includedRunsPerMonth: sub.includedRunsPerMonth,
      usedRuns: usedForOverride,
      remainingRuns: 0,
      unitPrice: pricePerProvision(env),
      currency: BILLING.CURRENCY,
      upgradeRequired: true,
      message: 'Provision runs are disabled for this workspace. Contact your billing administrator.',
    };
  }

  const included = override?.limitValue != null
    ? Math.max(sub.includedRunsPerMonth, override.limitValue)
    : sub.includedRunsPerMonth;
  const usedRuns = await countMonthRuns(tx, tenantId);
  const remainingRuns = Math.max(0, included - usedRuns);

  if (['past_due', 'cancelled', 'expired'].includes(sub.status)) {
    return {
      allowed: false,
      decision: 'overage',
      planCode: sub.planCode,
      planName: sub.planName,
      subscriptionStatus: sub.status,
      includedRunsPerMonth: included,
      usedRuns,
      remainingRuns: 0,
      unitPrice: pricePerProvision(env),
      currency: BILLING.CURRENCY,
      upgradeRequired: true,
      message: `Subscription is ${sub.status}. Update payment details or contact sales to resume provision runs.`,
    };
  }

  if (usedRuns < included) {
    const isFirstFree = usedRuns === 0 && sub.status === 'trialing';
    return {
      allowed: true,
      decision: isFirstFree ? 'free_trial' : 'included',
      planCode: sub.planCode,
      planName: sub.planName,
      subscriptionStatus: sub.status,
      includedRunsPerMonth: included,
      usedRuns,
      remainingRuns,
      unitPrice: 0,
      currency: BILLING.CURRENCY,
      upgradeRequired: false,
      message: isFirstFree
        ? `First run this month is free (${sub.planName} plan).`
        : `${remainingRuns} of ${included} included runs remaining this month (${sub.planName}).`,
    };
  }

  const overage = Number.isFinite(sub.overagePrice) && sub.overagePrice >= 0
    ? sub.overagePrice
    : pricePerProvision(env);
  return {
    allowed: true,
    decision: 'overage',
    planCode: sub.planCode,
    planName: sub.planName,
    subscriptionStatus: sub.status,
    includedRunsPerMonth: included,
    usedRuns,
    remainingRuns: 0,
    unitPrice: overage,
    currency: BILLING.CURRENCY,
    upgradeRequired: true,
    message: `Included runs used (${usedRuns}/${included} on ${sub.planName}). This run bills at £${overage} — upgrade for more included runs.`,
  };
}

/** Guard wrapper: throws 402 with upgrade metadata when the run may not start. */
export async function assertProvisionEntitlement(tx: any, tenantId: string): Promise<EntitlementCheck> {
  const check = await checkProvisionEntitlement(tx, tenantId);
  if (!check.allowed) {
    throw new PaymentRequiredError(check.message, {
      planCode: check.planCode,
      subscriptionStatus: check.subscriptionStatus,
      includedRunsPerMonth: check.includedRunsPerMonth,
      usedRuns: check.usedRuns,
      upgradeRequired: true,
    });
  }
  return check;
}
