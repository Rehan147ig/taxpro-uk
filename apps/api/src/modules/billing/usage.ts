import { and, eq, gte, lte, desc } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { usageEvents } from '../../db/schema/usage-events.js';

/**
 * Per-provision metering and billing (Sprint 1 hardened).
 *
 * BILLABLE LIFECYCLE (the critical fix):
 * - POST /api/provision/run NO LONGER records usage. A raw calculation
 *   attempt is not a charge.
 * - One usage event is recorded per run at finalize OR lock (first wins),
 *   event_type = 'provision_billable', with the unit price snapshotted.
 * - Failed / rejected / never-finalized runs are never billed.
 * - Retries hit the (tenant_id, provision_run_id, event_type) unique
 *   constraint and become no-ops instead of duplicate charges.
 *
 * R&D outcome share (3-5% of claim value) and the team SaaS tier sit on top
 * of this base metering.
 */

export const BILLING = {
  DEFAULT_PRICE_PER_PROVISION: 50,   // £/run base price (SME firm plan)
  TRIAL_FREE_RUNS_PER_MONTH: 1,      // first run each month is free (acquisition)
  CURRENCY: 'GBP',
} as const;

/** Legacy event recorded at calculation time (pre-Sprint-1). Kept for history. */
export const EVENT_PROVISION_COMPLETED = 'provision_completed';
/** Billable event recorded once per run at finalize/lock. */
export const EVENT_PROVISION_BILLABLE = 'provision_billable';

export function pricePerProvision(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.BILLING_PRICE_PER_PROVISION ?? BILLING.DEFAULT_PRICE_PER_PROVISION);
  return Number.isFinite(raw) && raw >= 0 ? raw : BILLING.DEFAULT_PRICE_PER_PROVISION;
}

export function usageIdempotencyKey(tenantId: string, provisionRunId: string, eventType: string): string {
  return `${tenantId}:${provisionRunId}:${eventType}`;
}

export type EntitlementDecision = 'free_trial' | 'included' | 'overage' | 'billable';

export interface RecordUsageInput {
  tenantId: string;
  provisionRunId: string;
  quantity?: number;
  unitPrice?: number;
  metadata?: Record<string, unknown>;
  /** Defaults to EVENT_PROVISION_BILLABLE for new billable events. */
  eventType?: string;
  idempotencyKey?: string;
  sourceLifecycle?: string;
  entitlementDecision?: EntitlementDecision | string;
  currency?: string;
}

export interface RecordUsageResult {
  inserted: boolean;
  duplicate: boolean;
}

export async function recordUsageEvent(
  tx: NodePgDatabase<any>,
  input: RecordUsageInput,
): Promise<RecordUsageResult> {
  const eventType = input.eventType ?? EVENT_PROVISION_BILLABLE;
  const unitPrice = input.unitPrice ?? pricePerProvision();
  const quantity = input.quantity ?? 1;
  const idempotencyKey = input.idempotencyKey ?? usageIdempotencyKey(input.tenantId, input.provisionRunId, eventType);
  const row = {
    tenantId: input.tenantId,
    eventType,
    provisionRunId: input.provisionRunId,
    quantity: String(quantity),
    unitPrice: String(unitPrice),
    amount: String(round2(quantity * unitPrice)),
    metadata: input.metadata,
    idempotencyKey,
    sourceLifecycle: input.sourceLifecycle ?? null,
    entitlementDecision: input.entitlementDecision ?? null,
    currency: input.currency ?? BILLING.CURRENCY,
  };

  // Idempotent insert: retries / repeated lifecycle calls are no-ops.
  // Two layers (either suffices alone):
  //  1. Explicit pre-check — the common retry path, no constraint needed.
  //  2. Bare ON CONFLICT DO NOTHING (no inference target, so it is valid
  //     against full AND partial unique indexes) + 23505 catch for races.
  // Never use ON CONFLICT (cols) inference here: partial indexes do not
  // satisfy inference and Postgres raises 42P10 instead of inserting.
  // Test doubles may not implement onConflictDoNothing — fall back gracefully.
  try {
    if (await hasUsageEvent(tx, input.tenantId, input.provisionRunId, eventType)) {
      return { inserted: false, duplicate: true };
    }
    const insert: any = (tx as any).insert(usageEvents).values(row);
    if (insert && typeof insert.onConflictDoNothing === 'function') {
      await insert.onConflictDoNothing();
    } else {
      await insert;
    }
    return { inserted: true, duplicate: false };
  } catch (err: any) {
    // Unique violation (SQLSTATE 23505) = duplicate billable event. Swallow:
    // billing must never double-charge on retry.
    if (err?.code === '23505' || /duplicate|unique|uq_usage_events/i.test(String(err?.message ?? ''))) {
      return { inserted: false, duplicate: true };
    }
    throw err;
  }
}

/** Authoritative duplicate check: has this run already produced a billable event? */
export async function hasUsageEvent(
  tx: NodePgDatabase<any>,
  tenantId: string,
  provisionRunId: string,
  eventType: string = EVENT_PROVISION_BILLABLE,
): Promise<boolean> {
  const rows = await tx.select({ id: usageEvents.id }).from(usageEvents)
    .where(and(
      eq(usageEvents.tenantId, tenantId),
      eq(usageEvents.provisionRunId, provisionRunId),
      eq(usageEvents.eventType, eventType),
    ))
    .limit(1);
  return rows.length > 0;
}

export interface UsagePeriodFilter {
  tenantId: string;
  from?: string; // ISO date
  to?: string;   // ISO date
}

export interface UsageSummary {
  runs: number;
  freeRuns: number;
  billableRuns: number;
  totalAmount: number;
  currency: string;
  events: Array<{
    id: string;
    occurredAt: string;
    eventType: string;
    provisionRunId: string | null;
    quantity: number;
    unitPrice: number;
    amount: number;
    currency: string;
    sourceLifecycle: string | null;
    entitlementDecision: string | null;
    metadata: Record<string, unknown> | null;
  }>;
}

export async function summarizeUsage(tx: NodePgDatabase<any>, filter: UsagePeriodFilter): Promise<UsageSummary> {
  const conds = [eq(usageEvents.tenantId, filter.tenantId)];
  if (filter.from) conds.push(gte(usageEvents.occurredAt, new Date(filter.from)));
  if (filter.to) conds.push(lte(usageEvents.occurredAt, new Date(filter.to)));

  const rows = await tx.select().from(usageEvents)
    .where(and(...conds))
    .orderBy(desc(usageEvents.occurredAt));

  // Free-tier runs are recorded with unit price / amount zero. This replaces
  // the old hardcoded `freeRuns = 0` — the allowance is applied at record
  // time (see entitlements.ts), the summary only counts immutable history.
  const freeRuns = rows.filter(r => Number(r.amount ?? 0) === 0).length;
  const billableRuns = rows.filter(r => Number(r.amount ?? 0) > 0).length;
  const totalAmount = rows.reduce((sum, r) => sum + Number(r.amount ?? 0), 0);

  return {
    runs: rows.length,
    freeRuns,
    billableRuns,
    totalAmount: round2(totalAmount),
    currency: BILLING.CURRENCY,
    events: rows.map(r => ({
      id: r.id,
      occurredAt: (r.occurredAt as any)?.toISOString?.() ?? String(r.occurredAt ?? ''),
      eventType: r.eventType,
      provisionRunId: (r as any).provisionRunId ?? null,
      quantity: Number((r as any).quantity ?? 1),
      unitPrice: Number((r as any).unitPrice ?? 0),
      amount: Number((r as any).amount ?? 0),
      currency: (r as any).currency ?? BILLING.CURRENCY,
      sourceLifecycle: (r as any).sourceLifecycle ?? null,
      entitlementDecision: (r as any).entitlementDecision ?? null,
      metadata: (r as any).metadata as Record<string, unknown> | null,
    })),
  };
}

/**
 * Invoice lines for a period — summed from IMMUTABLE usage-event amounts.
 *
 * The old implementation re-rated history with the current
 * `pricePerProvision()` env value, so changing BILLING_PRICE_PER_PROVISION
 * rewrote past invoices. Invoices must never change because an env var
 * changed: total = sum(event.amount).
 */
export async function buildInvoiceLines(tx: NodePgDatabase<any>, filter: UsagePeriodFilter) {
  const summary = await summarizeUsage(tx, filter);
  const billableAmount = round2(summary.totalAmount);
  const avgUnit = summary.billableRuns > 0 ? round2(billableAmount / summary.billableRuns) : 0;
  return {
    period: { from: filter.from ?? null, to: filter.to ?? null },
    currency: summary.currency,
    lines: [
      {
        description: `Tax provision runs (${summary.runs} completed, ${summary.freeRuns} free)`,
        quantity: summary.billableRuns,
        unitPrice: avgUnit,
        amount: billableAmount,
        note: summary.billableRuns > 0
          ? 'Summed from immutable usage-event amounts (price changes do not rewrite history)'
          : 'No billable runs in period',
      },
      {
        description: 'R&D claim outcome share (3-5% of claim value, charged at claim acceptance)',
        quantity: 0,
        unitPrice: 0,
        amount: 0,
        note: 'Outcome share is quoted per claim — not metered here',
      },
    ],
    total: billableAmount,
  };
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}
