import { describe, expect, it, vi, beforeEach } from 'vitest';
import { BILLING, EVENT_PROVISION_COMPLETED, EVENT_PROVISION_BILLABLE, pricePerProvision, recordUsageEvent, summarizeUsage, buildInvoiceLines, hasUsageEvent, usageIdempotencyKey } from './usage.js';

function fakeTx(rows: any[] = [], captured: any[] = []) {
  return {
    insert: () => ({
      values: (v: any) => {
        captured.push(v);
        return {
          onConflictDoNothing: async () => [],
          returning: async () => [],
        };
      },
    }),
    select: (_fields?: any) => ({
      from: () => ({
        where: () => ({
          orderBy: () => Promise.resolve(rows),
          limit: (_n?: number) => Promise.resolve(rows.slice(0, _n ?? rows.length)),
        }),
      }),
    }),
  };
}

describe('pricePerProvision', () => {
  beforeEach(() => { delete process.env.BILLING_PRICE_PER_PROVISION; });

  it('defaults to £50 per run', () => {
    expect(pricePerProvision({})).toBe(50);
  });

  it('reads the env override', () => {
    expect(pricePerProvision({ BILLING_PRICE_PER_PROVISION: '35.5' })).toBe(35.5);
  });

  it('falls back on garbage', () => {
    expect(pricePerProvision({ BILLING_PRICE_PER_PROVISION: 'abc' })).toBe(50);
    expect(pricePerProvision({ BILLING_PRICE_PER_PROVISION: '-5' })).toBe(50);
  });
});

describe('recordUsageEvent', () => {
  it('writes one event with snapshotted price and computed amount', async () => {
    const captured: any[] = [];
    await recordUsageEvent(fakeTx([], captured) as any, {
      tenantId: 't1', provisionRunId: 'r1', unitPrice: 50, metadata: { period: '2025-12-31' },
    });
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({
      tenantId: 't1',
      provisionRunId: 'r1',
      eventType: EVENT_PROVISION_BILLABLE,
      quantity: '1',
      unitPrice: '50',
      amount: '50',
    });
    expect(captured[0].metadata.period).toBe('2025-12-31');
  });

  it('honours quantity × unitPrice and custom prices', async () => {
    const captured: any[] = [];
    await recordUsageEvent(fakeTx([], captured) as any, {
      tenantId: 't1', provisionRunId: 'r1', quantity: 2, unitPrice: 37.5,
    });
    expect(captured[0].amount).toBe('75');
  });

  it('snapshots idempotency key, lifecycle, entitlement, and currency', async () => {
    const captured: any[] = [];
    await recordUsageEvent(fakeTx([], captured) as any, {
      tenantId: 't1', provisionRunId: 'r1', unitPrice: 0,
      sourceLifecycle: 'lock', entitlementDecision: 'free_trial',
    });
    expect(captured[0].idempotencyKey).toBe('t1:r1:provision_billable');
    expect(captured[0].sourceLifecycle).toBe('lock');
    expect(captured[0].entitlementDecision).toBe('free_trial');
    expect(captured[0].currency).toBe('GBP');
  });

  it('treats unique violations as duplicate (no double charge)', async () => {
    const dupTx = {
      insert: () => ({
        values: () => ({
          onConflictDoNothing: async () => {
            const err: any = new Error('duplicate key value violates unique constraint "uq_usage_events_tenant_run_event"');
            err.code = '23505';
            throw err;
          },
        }),
      }),
    };
    const res = await recordUsageEvent(dupTx as any, { tenantId: 't1', provisionRunId: 'r1' });
    expect(res.duplicate).toBe(true);
    expect(res.inserted).toBe(false);
  });

  it('builds deterministic idempotency keys', () => {
    expect(usageIdempotencyKey('t', 'r', 'provision_billable')).toBe('t:r:provision_billable');
  });
});

describe('hasUsageEvent', () => {
  it('returns true when a billable event already exists', async () => {
    const tx = fakeTx([{ id: 'x' }]);
    expect(await hasUsageEvent(tx as any, 't1', 'r1')).toBe(true);
  });

  it('returns false when no event exists', async () => {
    const tx = fakeTx([]);
    expect(await hasUsageEvent(tx as any, 't1', 'r1')).toBe(false);
  });
});

describe('summarizeUsage', () => {
  it('aggregates rows into a billing summary', async () => {
    const rows = [
      { id: 'a', occurredAt: new Date('2026-01-01'), eventType: 'provision_completed', provisionRunId: 'r1', quantity: '1', unitPrice: '50', amount: '50', currency: 'GBP', metadata: null },
      { id: 'b', occurredAt: new Date('2026-01-02'), eventType: 'provision_completed', provisionRunId: 'r2', quantity: '1', unitPrice: '50', amount: '50', currency: 'GBP', metadata: { jurisdiction: 'UK' } },
      { id: 'c', occurredAt: new Date('2026-01-03'), eventType: 'provision_billable', provisionRunId: 'r3', quantity: '1', unitPrice: '0', amount: '0', currency: 'GBP', metadata: null },
    ];
    const s = await summarizeUsage(fakeTx(rows) as any, { tenantId: 't1', from: '2026-01-01', to: '2026-01-31' });
    expect(s.runs).toBe(3);
    expect(s.billableRuns).toBe(2);
    expect(s.freeRuns).toBe(1);
    expect(s.totalAmount).toBe(100);
    expect(s.events[0].metadata).toBeNull();
    expect(s.events[1].metadata).toEqual({ jurisdiction: 'UK' });
  });

  it('counts free runs from zero-amount events (not hardcoded 0)', async () => {
    const rows = [
      { id: 'a', occurredAt: new Date(), eventType: 'provision_billable', provisionRunId: 'r1', quantity: '1', unitPrice: '0', amount: '0', currency: 'GBP', metadata: null },
    ];
    const s = await summarizeUsage(fakeTx(rows) as any, { tenantId: 't1' });
    expect(s.freeRuns).toBe(1);
    expect(s.billableRuns).toBe(0);
    expect(s.totalAmount).toBe(0);
  });
});

describe('buildInvoiceLines', () => {
  it('produces a per-run line plus the R&D outcome-share note', async () => {
    const rows = [
      { id: 'a', occurredAt: new Date(), eventType: 'provision_completed', provisionRunId: 'r1', quantity: '1', unitPrice: '50', amount: '50', currency: 'GBP', metadata: null },
      { id: 'b', occurredAt: new Date(), eventType: 'provision_completed', provisionRunId: 'r2', quantity: '1', unitPrice: '50', amount: '50', currency: 'GBP', metadata: null },
    ];
    const inv = await buildInvoiceLines(fakeTx(rows) as any, { tenantId: 't1' });
    expect(inv.lines[0].description).toContain('2 completed');
    expect(inv.lines[0].amount).toBe(100);
    expect(inv.total).toBe(100);
    expect(inv.lines[1].note).toMatch(/outcome share/i);
  });

  it('sums immutable event amounts even when the env price changes', async () => {
    const rows = [
      { id: 'a', occurredAt: new Date(), eventType: 'provision_billable', provisionRunId: 'r1', quantity: '1', unitPrice: '50', amount: '50', currency: 'GBP', metadata: null },
      { id: 'b', occurredAt: new Date(), eventType: 'provision_billable', provisionRunId: 'r2', quantity: '1', unitPrice: '50', amount: '50', currency: 'GBP', metadata: null },
    ];
    process.env.BILLING_PRICE_PER_PROVISION = '999';
    try {
      const inv = await buildInvoiceLines(fakeTx(rows) as any, { tenantId: 't1' });
      // Historical £50 events must NOT re-rate to £999.
      expect(inv.total).toBe(100);
      expect(inv.lines[0].amount).toBe(100);
    } finally {
      delete process.env.BILLING_PRICE_PER_PROVISION;
    }
  });
});

describe('pricing guardrails', () => {
  it('keeps the free trial slice visible', () => {
    expect(BILLING.TRIAL_FREE_RUNS_PER_MONTH).toBe(1);
    expect(BILLING.DEFAULT_PRICE_PER_PROVISION).toBe(50);
  });

  it('exposes the billable event type', () => {
    expect(EVENT_PROVISION_BILLABLE).toBe('provision_billable');
    expect(EVENT_PROVISION_COMPLETED).toBe('provision_completed');
  });
});
