// ─────────────────────────────────────────────────────────────────────────────
// Feature 3 — prior-period bridge on the intake commit gate.
// Scenario (isolated tenant mirroring the demo-tenant FY2026→FY2027 flow):
// commit period 1 (no prior run → zero items), lock a run over it, then
// period 2 with one rename + two additions produces exactly one
// POSSIBLE_RENAME item, two NEW_ACCOUNT proposals and one carry-forward
// proposal; a £5 cash drift blocks with OPENING_BALANCE_MISMATCH until a
// reviewer resolves it. Pure diffing is covered in
// modules/intake/prior-period-bridge.test.ts.
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
import { taxMappings } from '../db/schema/tax-mappings.js';
import { mappingProposals } from '../db/schema/mapping-proposals.js';
import { provisionRuns } from '../db/schema/provision-runs.js';
import { importBatches } from '../db/schema/import-batches.js';
import { reviewItems } from '../db/schema/review-items.js';
import { reviewItemEvents } from '../db/schema/review-item-events.js';
import { dataLineageEdges } from '../db/schema/lineage.js';

const FLAG_ORIGINAL = process.env.INTAKE_PRIOR_BRIDGE;

const TENANT = crypto.randomUUID();
const ADMIN = crypto.randomUUID();
const REVIEWER = crypto.randomUUID();
const PREPARER = crypto.randomUUID();
const ENTITY = crypto.randomUUID();
const PERIOD_26 = crypto.randomUUID();
const PERIOD_27 = crypto.randomUUID();

const app = new Hono();
app.onError(errorHandler);
app.route('/api/intake', intakeRoutes);

function tokenFor(userId: string, role: string): string {
  return jwt.sign({ userId, tenantId: TENANT, email: `bridge-${role}@test.local`, role }, env.JWT_SECRET, { expiresIn: '1h' });
}

const HEADERS = 'entityName,entityExternalId,accountName,accountNumber,accountExternalId,accountType,detailType,period,periodEnd,debit,credit,balance,currency';
// FY2026: balanced 78,000 / 78,000 under the standard convention.
const ROWS_P1 = [
  'BridgeCo,bridgeco,Sales revenue,4000,4000,Income,Income,2026-03-31,2026-03-31,0,48000,,GBP',
  'BridgeCo,bridgeco,Office rent account,5100,5100,Expense,Expense,2026-03-31,2026-03-31,12000,0,,GBP',
  'BridgeCo,bridgeco,Cash,1000,1000,Asset,Asset,2026-03-31,2026-03-31,66000,0,,GBP',
  'BridgeCo,bridgeco,Trade payables,2000,2000,Liability,Liability,2026-03-31,2026-03-31,0,30000,,GBP',
];
// FY2027: "Office rent account" renamed to "Office rent", plus Cloud hosting
// (Expense debit 3000) and Accrued expenses (Liability credit 3000) —
// balanced 81,000 / 81,000, balance-sheet positions unchanged.
const ROWS_P2 = [
  'BridgeCo,bridgeco,Sales revenue,4000,4000,Income,Income,2027-03-31,2027-03-31,0,48000,,GBP',
  'BridgeCo,bridgeco,Office rent,5100,5100,Expense,Expense,2027-03-31,2027-03-31,12000,0,,GBP',
  'BridgeCo,bridgeco,Cash,1000,1000,Asset,Asset,2027-03-31,2027-03-31,66000,0,,GBP',
  'BridgeCo,bridgeco,Trade payables,2000,2000,Liability,Liability,2027-03-31,2027-03-31,0,30000,,GBP',
  'BridgeCo,bridgeco,Cloud hosting,5400,5400,Expense,Expense,2027-03-31,2027-03-31,3000,0,,GBP',
  'BridgeCo,bridgeco,Accrued expenses,2100,2100,Liability,Liability,2027-03-31,2027-03-31,0,3000,,GBP',
];

async function uploadCsv(token: string, rows: string[], periodId: string, ref: string) {
  const form = new FormData();
  form.append('entityId', ENTITY);
  form.append('accountingPeriodId', periodId);
  form.append('sourceReference', ref);
  form.append('file', new File([[HEADERS, ...rows].join('\n')], 'tb-bridge.csv', { type: 'text/csv' }));
  return app.request('/api/intake/batches', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
}

async function bridgeItems(batchId: string) {
  return withTenantContext(TENANT, async (tx) =>
    tx.select().from(reviewItems).where(and(eq(reviewItems.tenantId, TENANT), eq(reviewItems.sourceRef, `import_batch:${batchId}`))));
}

async function pendingProposals() {
  return withTenantContext(TENANT, async (tx) =>
    tx.select().from(mappingProposals).where(and(eq(mappingProposals.tenantId, TENANT), eq(mappingProposals.status, 'pending'))));
}

let batchP1Id = '';

beforeAll(async () => {
  process.env.INTAKE_PRIOR_BRIDGE = 'true';
  await withTenantContext(TENANT, async (tx) => {
    await tx.insert(tenants).values({ id: TENANT, name: 'Bridge Co', slug: TENANT, taxRate: '0.25' }).onConflictDoNothing();
    for (const [id, role] of [[ADMIN, 'admin'], [REVIEWER, 'reviewer'], [PREPARER, 'preparer']] as const) {
      await tx.insert(users).values({ id, tenantId: TENANT, email: `bridge-${role}@test.local`, passwordHash: 'x', role }).onConflictDoNothing();
    }
    await tx.insert(entities).values({
      id: ENTITY, tenantId: TENANT, externalId: ENTITY, name: 'Bridge Co', type: 'Limited Company',
      currency: 'GBP', taxJurisdiction: 'UK_FRS102', isConsolidated: false,
    }).onConflictDoNothing();
    await tx.insert(accountingPeriods).values({
      id: PERIOD_26, tenantId: TENANT, entityId: ENTITY, name: 'FY2026',
      startDate: '2026-01-01', endDate: '2026-12-31', periodType: 'annual', status: 'open',
    }).onConflictDoNothing();
    await tx.insert(accountingPeriods).values({
      id: PERIOD_27, tenantId: TENANT, entityId: ENTITY, name: 'FY2027',
      startDate: '2027-01-01', endDate: '2027-12-31', periodType: 'annual', status: 'open',
    }).onConflictDoNothing();
  });
});

afterAll(async () => {
  if (FLAG_ORIGINAL === undefined) delete process.env.INTAKE_PRIOR_BRIDGE;
  else process.env.INTAKE_PRIOR_BRIDGE = FLAG_ORIGINAL;
  await withTenantContext(TENANT, async (tx) => {
    await Promise.allSettled([
      tx.delete(dataLineageEdges).where(eq(dataLineageEdges.tenantId, TENANT)),
      tx.delete(reviewItemEvents).where(eq(reviewItemEvents.tenantId, TENANT)),
      tx.delete(reviewItems).where(eq(reviewItems.tenantId, TENANT)),
      tx.delete(mappingProposals).where(eq(mappingProposals.tenantId, TENANT)),
      tx.delete(taxMappings).where(eq(taxMappings.tenantId, TENANT)),
      tx.delete(trialBalance).where(eq(trialBalance.tenantId, TENANT)),
      tx.delete(accounts).where(eq(accounts.tenantId, TENANT)),
    ]);
    await Promise.allSettled([
      tx.delete(importBatches).where(eq(importBatches.tenantId, TENANT)),
      tx.delete(provisionRuns).where(eq(provisionRuns.tenantId, TENANT)),
      tx.delete(accountingPeriods).where(eq(accountingPeriods.tenantId, TENANT)),
      tx.delete(entities).where(eq(entities.tenantId, TENANT)),
      tx.delete(users).where(eq(users.tenantId, TENANT)),
      tx.delete(tenants).where(eq(tenants.id, TENANT)),
    ]);
  });
});

describe('Feature 3 — prior-period bridge', () => {
  it('commits the first period with no prior run and zero bridge items', async () => {
    const admin = tokenFor(ADMIN, 'admin');
    const res = await uploadCsv(admin, ROWS_P1, PERIOD_26, 'bridge-p1');
    expect(res.status).toBe(201);
    batchP1Id = (await res.json()).batch.id as string;

    const commit = await app.request(`/api/intake/batches/${batchP1Id}/commit`, { method: 'POST', headers: { Authorization: `Bearer ${admin}` } });
    expect(commit.status).toBe(200);
    const body = await commit.json();
    expect(body.batch.status).toBe('committed');
    expect(body.priorBridge).toMatchObject({ hasPriorRun: false, priorRunId: null });
    expect(await bridgeItems(batchP1Id)).toHaveLength(0);
  });

  it('second period with a rename + additions yields exactly the bridge items (no rollforward silently)', async () => {
    const admin = tokenFor(ADMIN, 'admin');

    // Lock a run over period 1 and approve the mapping the rename will carry.
    const rent = await withTenantContext(TENANT, async (tx) => {
      const accs = await tx.select().from(accounts).where(eq(accounts.tenantId, TENANT));
      const rent = accs.find((a) => a.name === 'Office rent account');
      expect(rent).toBeTruthy();
      await tx.insert(taxMappings).values({
        tenantId: TENANT, accountId: rent!.id, taxAccountType: 'NODIFF_EXPENSE',
        bookTreatment: 'no_diff', isActive: true, status: 'active', version: 1,
      });
      await tx.insert(provisionRuns).values({
        tenantId: TENANT, entityId: ENTITY, period: '2026-01-01', accountingPeriodId: PERIOD_26, status: 'locked',
      });
      const maps = await tx.select().from(taxMappings).where(eq(taxMappings.tenantId, TENANT));
      return { rentAccountId: rent!.id, mappingId: maps.find((m) => m.accountId === rent!.id)!.id };
    });

    const res = await uploadCsv(admin, ROWS_P2, PERIOD_27, 'bridge-p2');
    expect(res.status).toBe(201);
    const batchId = (await res.json()).batch.id as string;

    // Read-only report: no side effects before commit.
    const preview = await app.request(`/api/intake/batches/${batchId}/prior-bridge`, { headers: { Authorization: `Bearer ${admin}` } });
    expect(preview.status).toBe(200);
    const previewBody = await preview.json();
    expect(previewBody.priorRunId).toBeTruthy();
    expect(previewBody.result.renames).toHaveLength(1);
    expect(previewBody.result.newAccounts).toHaveLength(2);
    expect(previewBody.result.missingAccounts).toHaveLength(0);
    expect(previewBody.result.mismatches).toHaveLength(0);
    expect(await bridgeItems(batchId)).toHaveLength(0);

    // Warnings never block: commit succeeds and surfaces everything.
    const commit = await app.request(`/api/intake/batches/${batchId}/commit`, { method: 'POST', headers: { Authorization: `Bearer ${admin}` } });
    expect(commit.status).toBe(200);
    const body = await commit.json();
    expect(body.priorBridge).toMatchObject({ hasPriorRun: true, newAccounts: 2, missingAccounts: 0, renames: 1, mismatches: 0 });

    const items = await bridgeItems(batchId);
    expect(items.filter((i) => i.itemType === 'POSSIBLE_RENAME')).toHaveLength(1);
    const rename = items.find((i) => i.itemType === 'POSSIBLE_RENAME')!;
    expect(rename).toMatchObject({ severity: 'warning', status: 'open' });

    const proposals = await pendingProposals();
    const carry = proposals.filter((p) => p.proposalSource === 'carry_forward');
    expect(carry).toHaveLength(1);
    expect(carry[0]).toMatchObject({
      carriesForward: true,
      priorMappingId: rent.mappingId,
      targetTaxClassification: 'NODIFF_EXPENSE',
    });
    expect(String(carry[0].sourceAccountName)).toContain('Office rent');
    const fresh = proposals.filter((p) => p.proposalSource === 'import');
    expect(fresh.map((p) => p.sourceAccountExternalId).sort()).toEqual(['2100', '5400']);
  });

  it('a £5 cash drift blocks commit until a reviewer resolves it', async () => {
    const admin = tokenFor(ADMIN, 'admin');
    const reviewer = tokenFor(REVIEWER, 'reviewer');
    const drifted = ROWS_P2.map((r) => (r.includes(',Cash,') ? r.replace(',66000,0,', ',66005,0,') : r));
    const res = await uploadCsv(admin, drifted, PERIOD_27, 'bridge-p3-drift');
    expect(res.status).toBe(201);
    const batchId = (await res.json()).batch.id as string;

    const commit = await app.request(`/api/intake/batches/${batchId}/commit`, { method: 'POST', headers: { Authorization: `Bearer ${admin}` } });
    expect(commit.status).toBe(409);
    expect(await commit.text()).toContain('OPENING_BALANCE_MISMATCH');

    const items = await bridgeItems(batchId);
    const mismatch = items.find((i) => i.itemType === 'OPENING_BALANCE_MISMATCH');
    expect(mismatch).toMatchObject({ severity: 'error', status: 'open' });

    // A preparer cannot clear an error; a reviewer can.
    const denied = await app.request(`/api/intake/batches/${batchId}/bridge/items/${mismatch!.id}/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenFor(PREPARER, 'preparer')}` },
      body: JSON.stringify({ reason: 'preparer tried to clear' }),
    });
    expect(denied.status).toBe(403);

    const resolved = await app.request(`/api/intake/batches/${batchId}/bridge/items/${mismatch!.id}/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${reviewer}` },
      body: JSON.stringify({ reason: 'Prior-year adjustment journals explain the £5 cash movement.' }),
    });
    expect(resolved.status).toBe(200);

    const retry = await app.request(`/api/intake/batches/${batchId}/commit`, { method: 'POST', headers: { Authorization: `Bearer ${admin}` } });
    expect(retry.status).toBe(200);
    expect((await retry.json()).batch.status).toBe('committed');
  });

  it('returns 403 when the flag is off', async () => {
    process.env.INTAKE_PRIOR_BRIDGE = 'false';
    try {
      const res = await app.request(`/api/intake/batches/${batchP1Id}/prior-bridge`, {
        headers: { Authorization: `Bearer ${tokenFor(ADMIN, 'admin')}` },
      });
      expect(res.status).toBe(403);
    } finally {
      process.env.INTAKE_PRIOR_BRIDGE = 'true';
    }
  });
});
