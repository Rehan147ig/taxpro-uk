import { describe, expect, it } from 'vitest';
import { checkProvisionEntitlement, assertProvisionEntitlement } from './entitlements.js';

/**
 * Minimal tx double. checkProvisionEntitlement performs three selects:
 *  1. subscription (+ plan join) — .limit(1)
 *  2. entitlement override — .limit(1)
 *  3. month usage count — no limit (array length = used runs)
 * We serve them from a queue in call order.
 */
function queueTx(selectResults: any[][]) {
  let calls = 0;
  return {
    select: () => ({
      from: () => ({
        leftJoin: () => ({
          where: () => ({
            limit: async () => selectResults[calls++] ?? [],
          }),
        }),
        where: () => ({
          limit: async () => selectResults[calls++] ?? [],
          // month-count path: `where(...)` awaited via .then-less array?
          // countMonthRuns awaits the array directly.
          then: undefined,
        }),
      }),
    }),
  };
}

/** Simpler: direct stub where each select stage is pre-wired. */
function stubTx(opts: {
  subscription?: any;
  override?: any;
  usageCount?: number;
}) {
  let selectCalls = 0;
  return {
    select: () => ({
      from: () => ({
        leftJoin: () => ({
          where: () => ({
            limit: async () => {
              selectCalls++;
              return opts.subscription ? [opts.subscription] : [];
            },
          }),
        }),
        where: (..._args: any[]) => {
          const callIndex = selectCalls++;
          // Second select (override) uses .limit(); third (usage) is awaited
          // as a full array. Distinguish by whether caller chains .limit.
          const usageRows = Array.from({ length: opts.usageCount ?? 0 }, (_, i) => ({ id: `u${i}` }));
          return {
            limit: async () => (callIndex === 1 ? (opts.override ? [opts.override] : []) : usageRows),
            // Make the object thenable so `await where(...)` resolves to usage rows
            // when countMonthRuns uses the summarizeUsage fallback path.
            then: (resolve: any) => resolve(callIndex === 1 ? (opts.override ? [opts.override] : []) : usageRows),
          };
        },
      }),
    }),
  };
}

const pilotSub = {
  status: 'trialing',
  includedRuns: 1,
  planCode: 'pilot',
  planName: 'Pilot',
  planOverage: '50',
  planIncluded: 1,
};

describe('checkProvisionEntitlement', () => {
  it('grants the first monthly run as free_trial with unit price 0', async () => {
    const tx = stubTx({ subscription: pilotSub, usageCount: 0 });
    const check = await checkProvisionEntitlement(tx as any, 't1');
    expect(check.allowed).toBe(true);
    expect(check.decision).toBe('free_trial');
    expect(check.unitPrice).toBe(0);
    expect(check.upgradeRequired).toBe(false);
  });

  it('marks overage runs billable with an upgrade prompt (not blocked)', async () => {
    const tx = stubTx({ subscription: pilotSub, usageCount: 1 });
    const check = await checkProvisionEntitlement(tx as any, 't1');
    expect(check.allowed).toBe(true);
    expect(check.decision).toBe('overage');
    expect(check.unitPrice).toBe(50);
    expect(check.upgradeRequired).toBe(true);
    expect(check.message).toMatch(/upgrade/i);
  });

  it('blocks runs when the subscription is past_due', async () => {
    const tx = stubTx({
      subscription: { ...pilotSub, status: 'past_due' },
      usageCount: 0,
    });
    const check = await checkProvisionEntitlement(tx as any, 't1');
    expect(check.allowed).toBe(false);
    expect(check.upgradeRequired).toBe(true);
  });

  it('falls back to pilot defaults when no subscription row exists', async () => {
    const tx = stubTx({ usageCount: 0 });
    const check = await checkProvisionEntitlement(tx as any, 't1');
    expect(check.allowed).toBe(true);
    expect(check.planCode).toBe('pilot');
    expect(check.decision).toBe('free_trial');
  });

  it('honours professional included runs (10/month)', async () => {
    const tx = stubTx({
      subscription: {
        status: 'active',
        includedRuns: 10,
        planCode: 'professional',
        planName: 'Professional',
        planOverage: '50',
        planIncluded: 10,
      },
      usageCount: 5,
    });
    const check = await checkProvisionEntitlement(tx as any, 't1');
    expect(check.allowed).toBe(true);
    expect(check.decision).toBe('included');
    expect(check.unitPrice).toBe(0);
    expect(check.remainingRuns).toBe(5);
  });
});

describe('assertProvisionEntitlement', () => {
  it('throws 402 with upgrade metadata when blocked', async () => {
    const tx = stubTx({
      subscription: { ...pilotSub, status: 'cancelled' },
      usageCount: 0,
    });
    await expect(assertProvisionEntitlement(tx as any, 't1')).rejects.toMatchObject({
      statusCode: 402,
    });
  });

  it('passes through the check when allowed', async () => {
    const tx = stubTx({ subscription: pilotSub, usageCount: 0 });
    const check = await assertProvisionEntitlement(tx as any, 't1');
    expect(check.allowed).toBe(true);
  });
});
