// ─────────────────────────────────────────────────────────────────────────────
// Feature 2 — sign-convention detection on the intake commit gate.
// Covers: standard commits untouched; inverted blocks with
// SIGN_CONVENTION_INVERTED until a reviewer confirms (× −1 applied once,
// audited) or rejects (stays blocked); mixed commits with a warning item;
// RBAC (reviewer+ to decide); flag-off 403s. Pure detection is covered in
// modules/intake/sign-convention.test.ts.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Hono } from 'hono';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { and, eq } from 'drizzle-orm';
import { withTenantContext } from '../config/db.js';
import { env } from '../config/env.js';
import { errorHandler } from '../lib/middleware/error-handler.js';
import { intakeRoutes } from '../modules/intake/intake.routes.js';
import { tenants } from '../db/schema/tenants.js';
import { users } from '../db/schema/users.js';
import { entities } from '../db/schema/entities.js';
import { accountingPeriods } from '../db/schema/accounting-periods.js';
import { accounts } from '../db/schema/accounts.js';
import { trialBalance } from '../db/schema/trial-balance.js';
import { importBatches, importBatchRows, importBatchEvents } from '../db/schema/import-batches.js';
import { reviewItems } from '../db/schema/review-items.js';
import { reviewItemEvents } from '../db/schema/review-item-events.js';
import { dataLineageEdges } from '../db/schema/lineage.js';

const FLAG_ORIGINAL = process.env.INTAKE_SIGN_CONVENTION;

const TENANT = crypto.randomUUID();
const ADMIN = crypto.randomUUID();
const REVIEWER = crypto.randomUUID();
const PREPARER = crypto.randomUUID();
const ENTITY = crypto.randomUUID();
const PERIOD_AP = crypto.randomUUID();

const app = new Hono();
app.onError(errorHandler);
app.route('/api/intake', intakeRoutes);

function tokenFor(userId: string, role: string): string {
  return jwt.sign({ userId, tenantId: TENANT, email: `sign-${role}@test.local`, role }, env.JWT_SECRET, { expiresIn: '1h' });
}

const HEADERS = 'entityName,entityExternalId,accountName,accountNumber,accountExternalId,accountType,detailType,period,periodEnd,debit,credit,balance,currency';
// Balanced at 82,000 / 82,000 under the standard convention.
const ROWS_STANDARD = [
  'SignCo,signco,Sales revenue,4000,4000,Income,Income,2026-03-31,2026-03-31,0,48000,,GBP',
  'SignCo,signco,Salaries,5000,5000,Expense,Expense,2026-03-31,2026-03-31,20000,0,,GBP',
  'SignCo,signco,Office rent,5100,5100,Expense,Expense,2026-03-31,2026-03-31,12000,0,,GBP',
  'SignCo,signco,Cash,1000,1000,Asset,Asset,2026-03-31,2026-03-31,50000,0,,GBP',
  'SignCo,signco,Trade payables,2000,2000,Liability,Liability,2026-03-31,2026-03-31,0,30000,,GBP',
  'SignCo,signco,Share capital,3000,3000,Equity,Equity,2026-03-31,2026-03-31,0,4000,,GBP',
];
// Same TB with every debit/credit swapped: fully inverted, still balanced.
const ROWS_INVERTED = [
  'SignCo,signco,Sales revenue,4000,4000,Income,Income,2026-03-31,2026-03-31,48000,0,,GBP',
  'SignCo,signco,Salaries,5000,5000,Expense,Expense,2026-03-31,2026-03-31,0,20000,,GBP',
  'SignCo,signco,Office rent,5100,5100,Expense,Expense,2026-03-31,2026-03-31,0,12000,,GBP',
  'SignCo,signco,Cash,1000,1000,Asset,Asset,2026-03-31,2026-03-31,0,50000,,GBP',
  'SignCo,signco,Trade payables,2000,2000,Liability,Liability,2026-03-31,2026-03-31,30000,0,,GBP',
  'SignCo,signco,Share capital,3000,3000,Equity,Equity,2026-03-31,2026-03-31,4000,0,,GBP',
];
// Only revenue flipped: mixed.
const ROWS_MIXED = [
  'SignCo,signco,Sales revenue,4000,4000,Income,Income,2026-03-31,2026-03-31,48000,0,,GBP',
  ...ROWS_STANDARD.slice(1),
];

async function uploadCsv(token: string, rows: string[], ref: string, filename = 'tb-sign.csv') {
  const form = new FormData();
  form.append('entityId', ENTITY);
  form.append('accountingPeriodId', PERIOD_AP);
  form.append('sourceReference', ref);
  form.append('file', new File([[HEADERS, ...rows].join('\n')], filename, { type: 'text/csv' }));
  return app.request('/api/intake/batches', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
}

async function signItems(batchId: string) {
  return withTenantContext(TENANT, async (tx) =>
    tx.select().from(reviewItems).where(and(eq(reviewItems.tenantId, TENANT), eq(reviewItems.sourceRef, `import_batch:${batchId}`))));
}

let standardBatchId = '';
let invertedBatchId = '';

beforeAll(async () => {
  process.env.INTAKE_SIGN_CONVENTION = 'true';
  await withTenantContext(TENANT, async (tx) => {
    await tx.insert(tenants).values({ id: TENANT, name: 'Sign Co', slug: TENANT, taxRate: '0.25' }).onConflictDoNothing();
    for (const [id, role, email] of [
      [ADMIN, 'admin', 'sign-admin@test.local'],
      [REVIEWER, 'reviewer', 'sign-reviewer@test.local'],
      [PREPARER, 'preparer', 'sign-preparer@test.local'],
    ] as const) {
      await tx.insert(users).values({ id, tenantId: TENANT, email, passwordHash: 'x', role }).onConflictDoNothing();
    }
    await tx.insert(entities).values({
      id: ENTITY, tenantId: TENANT, externalId: ENTITY, name: 'Sign Co', type: 'Limited Company',
      currency: 'GBP', taxJurisdiction: 'UK_FRS102', isConsolidated: false,
    }).onConflictDoNothing();
    await tx.insert(accountingPeriods).values({
      id: PERIOD_AP, tenantId: TENANT, entityId: ENTITY, name: 'FY2026',
      startDate: '2026-01-01', endDate: '2026-12-31', periodType: 'annual', status: 'open',
    }).onConflictDoNothing();
  });
});

afterAll(async () => {
  if (FLAG_ORIGINAL === undefined) delete process.env.INTAKE_SIGN_CONVENTION;
  else process.env.INTAKE_SIGN_CONVENTION = FLAG_ORIGINAL;
  // Best-effort: ledgers are append-only by design, tenants are random per run.
  await withTenantContext(TENANT, async (tx) => {
    await Promise.allSettled([
      tx.delete(dataLineageEdges).where(eq(dataLineageEdges.tenantId, TENANT)),
      tx.delete(reviewItemEvents).where(eq(reviewItemEvents.tenantId, TENANT)),
      tx.delete(reviewItems).where(eq(reviewItems.tenantId, TENANT)),
      tx.delete(trialBalance).where(eq(trialBalance.tenantId, TENANT)),
      tx.delete(accounts).where(eq(accounts.tenantId, TENANT)),
    ]);
    await Promise.allSettled([
      tx.delete(importBatches).where(eq(importBatches.tenantId, TENANT)),
      tx.delete(accountingPeriods).where(eq(accountingPeriods.tenantId, TENANT)),
      tx.delete(entities).where(eq(entities.tenantId, TENANT)),
      tx.delete(users).where(eq(users.tenantId, TENANT)),
      tx.delete(tenants).where(eq(tenants.id, TENANT)),
    ]);
  });
});

describe('Feature 2 — sign-convention commit gate', () => {
  it('commits a standard-convention TB untouched', async () => {
    const admin = tokenFor(ADMIN, 'admin');
    const res = await uploadCsv(admin, ROWS_STANDARD, 'sign-standard');
    expect(res.status).toBe(201);
    const batchId = (await res.json()).batch.id as string;
    standardBatchId = batchId;

    const commit = await app.request(`/api/intake/batches/${batchId}/commit`, { method: 'POST', headers: { Authorization: `Bearer ${admin}` } });
    expect(commit.status).toBe(200);
    const body = await commit.json();
    expect(body.batch.status).toBe('committed');
    expect(body.signConvention).toMatchObject({ classification: 'standard', code: 'SIGN_CONVENTION_OK', applied: false });
    expect(await signItems(batchId)).toHaveLength(0);
  });

  it('blocks commit of a fully inverted TB with SIGN_CONVENTION_INVERTED', async () => {
    const admin = tokenFor(ADMIN, 'admin');
    const res = await uploadCsv(admin, ROWS_INVERTED, 'sign-inverted');
    expect(res.status).toBe(201);
    invertedBatchId = (await res.json()).batch.id as string;

    const commit = await app.request(`/api/intake/batches/${invertedBatchId}/commit`, { method: 'POST', headers: { Authorization: `Bearer ${admin}` } });
    expect(commit.status).toBe(409);
    expect(await commit.text()).toContain('SIGN_CONVENTION_INVERTED');

    const items = await signItems(invertedBatchId);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ itemType: 'SIGN_CONVENTION_INVERTED', severity: 'error', status: 'open' });
  });

  it('exposes the INVERTED report without duplicating the review item', async () => {
    const admin = tokenFor(ADMIN, 'admin');
    const res = await app.request(`/api/intake/batches/${invertedBatchId}/sign-convention`, { headers: { Authorization: `Bearer ${admin}` } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.report).toMatchObject({ classification: 'inverted', code: 'SIGN_CONVENTION_INVERTED', severity: 'error' });

    // Retrying commit reuses the same open item — no duplicates.
    await app.request(`/api/intake/batches/${invertedBatchId}/commit`, { method: 'POST', headers: { Authorization: `Bearer ${admin}` } });
    expect(await signItems(invertedBatchId)).toHaveLength(1);
  });

  it('refuses confirmation from a preparer (reviewer+ only)', async () => {
    const res = await app.request(`/api/intake/batches/${invertedBatchId}/sign-convention/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenFor(PREPARER, 'preparer')}` },
      body: JSON.stringify({ reason: 'preparer tried to confirm' }),
    });
    expect(res.status).toBe(403);
  });

  it('reviewer confirm unblocks commit; signs are corrected once and audited', async () => {
    const admin = tokenFor(ADMIN, 'admin');
    const reviewer = tokenFor(REVIEWER, 'reviewer');

    const confirm = await app.request(`/api/intake/batches/${invertedBatchId}/sign-convention/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${reviewer}` },
      body: JSON.stringify({ reason: 'Source system exports inverted signs — confirmed against prior year.' }),
    });
    expect(confirm.status).toBe(200);
    const confirmBody = await confirm.json();
    expect(confirmBody.item.status).toBe('resolved');

    const commit = await app.request(`/api/intake/batches/${invertedBatchId}/commit`, { method: 'POST', headers: { Authorization: `Bearer ${admin}` } });
    expect(commit.status).toBe(200);
    const body = await commit.json();
    expect(body.signConvention).toMatchObject({ classification: 'inverted', applied: true });

    await withTenantContext(TENANT, async (tx) => {
      // Corrected trial balance matches the standard-convention numbers.
      const accs = await tx.select().from(accounts).where(eq(accounts.tenantId, TENANT));
      const sales = accs.find((a) => a.name === 'Sales revenue');
      expect(sales).toBeTruthy();
      const tb = await tx.select().from(trialBalance)
        .where(and(eq(trialBalance.tenantId, TENANT), eq(trialBalance.accountId, sales!.id)));
      expect(tb.length).toBeGreaterThanOrEqual(1);
      expect(tb[0].balance).toBe('-48000');

      // Raw upload preserved; normalized carries the correction.
      const rows = await tx.select().from(importBatchRows).where(eq(importBatchRows.batchId, invertedBatchId));
      const salesRow = rows.find((r) => (r.raw as Record<string, string>).accountName === 'Sales revenue');
      expect((salesRow!.raw as Record<string, string>).debit).toBe('48000');
      expect((salesRow!.normalized as { balance: number }).balance).toBe(-48000);

      // Append-only audit shows before/after per-type totals.
      const events = await tx.select().from(importBatchEvents)
        .where(and(eq(importBatchEvents.tenantId, TENANT), eq(importBatchEvents.batchId, invertedBatchId)));
      const applied = events.find((e) => e.eventType === 'batch.sign_convention_applied');
      expect(applied).toBeTruthy();
      expect((applied!.beforeState as { totals: Record<string, string> }).totals.Income).toBe('48000');
      expect((applied!.afterState as { totals: Record<string, string> }).totals.Income).toBe('-48000');
    });
  });

  it('reject keeps the batch blocked so the source file gets fixed', async () => {
    const admin = tokenFor(ADMIN, 'admin');
    const reviewer = tokenFor(REVIEWER, 'reviewer');
    const res = await uploadCsv(admin, ROWS_INVERTED, 'sign-inverted-reject');
    const batchId = (await res.json()).batch.id as string;

    const reject = await app.request(`/api/intake/batches/${batchId}/sign-convention/reject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${reviewer}` },
      body: JSON.stringify({ reason: 'File is wrong — re-export from the ledger.' }),
    });
    expect(reject.status).toBe(200);

    const commit = await app.request(`/api/intake/batches/${batchId}/commit`, { method: 'POST', headers: { Authorization: `Bearer ${admin}` } });
    expect(commit.status).toBe(409);
    expect(await commit.text()).toContain('SIGN_CONVENTION_INVERTED');
  });

  it('commits a mixed TB with a warning item and no transformation', async () => {
    const admin = tokenFor(ADMIN, 'admin');
    const res = await uploadCsv(admin, ROWS_MIXED, 'sign-mixed');
    const batchId = (await res.json()).batch.id as string;

    const commit = await app.request(`/api/intake/batches/${batchId}/commit`, { method: 'POST', headers: { Authorization: `Bearer ${admin}` } });
    expect(commit.status).toBe(200);
    const body = await commit.json();
    expect(body.signConvention).toMatchObject({ classification: 'mixed', code: 'SIGN_CONVENTION_MIXED', applied: false });

    const items = await signItems(batchId);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ itemType: 'SIGN_CONVENTION_MIXED', severity: 'warning', status: 'open' });
  });

  it('returns 403 when the flag is off', async () => {
    process.env.INTAKE_SIGN_CONVENTION = 'false';
    try {
      const res = await app.request(`/api/intake/batches/${standardBatchId}/sign-convention`, {
        headers: { Authorization: `Bearer ${tokenFor(ADMIN, 'admin')}` },
      });
      expect(res.status).toBe(403);
    } finally {
      process.env.INTAKE_SIGN_CONVENTION = 'true';
    }
  });
});
