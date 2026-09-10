// ─────────────────────────────────────────────────────────────────────────────
// Phase D — External Filing Handoff: live-DB API tests.
//
// Exercises the full honest lifecycle: needs_review → finalize → submit →
// partner-approve → lock → filing-ready handoff → deterministic package /
// manifest → record external filing → append-only + RLS + maker-checker
// enforcement. Runs against the real Postgres container via withTenantContext.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Hono } from 'hono';
import jwt from 'jsonwebtoken';
import { and, eq, sql } from 'drizzle-orm';
import crypto from 'crypto';
import { withTenantContext } from '../config/db.js';
import { env } from '../config/env.js';
import { errorHandler } from '../lib/middleware/error-handler.js';
import { workbenchRoutes } from '../modules/workbench/workbench.routes.js';
import { provisionRoutes } from '../modules/provision/provision.routes.js';
import { handoffRoutes } from '../modules/handoff/handoff.routes.js';
import { tenants } from '../db/schema/tenants.js';
import { users } from '../db/schema/users.js';
import { entities } from '../db/schema/entities.js';
import { accountingPeriods } from '../db/schema/accounting-periods.js';
import { taxPeriods } from '../db/schema/tax-periods.js';
import { sourceDocuments } from '../db/schema/source-documents.js';
import { accounts } from '../db/schema/accounts.js';
import { taxMappings } from '../db/schema/tax-mappings.js';
import { ukRules } from '../db/schema/uk-rules.js';
import { reviewItems } from '../db/schema/review-items.js';
import { provisionRuns } from '../db/schema/provision-runs.js';
import { externalFilings } from '../db/schema/external-filings.js';

const TENANT_A = crypto.randomUUID();
const TENANT_B = crypto.randomUUID();
const USER_A = crypto.randomUUID();   // admin, creates runs
const USER_A2 = crypto.randomUUID();  // partner, approves (self-approval blocked)
const USER_B = crypto.randomUUID();   // tenant B admin
const ENTITY_A = crypto.randomUUID();
const ENTITY_B = crypto.randomUUID();
const PERIOD_AP = crypto.randomUUID();
const PERIOD_AP_B = crypto.randomUUID();
const PERIOD_TP = crypto.randomUUID();
const PERIOD_TP_B = crypto.randomUUID();
const DOC_A = crypto.randomUUID();
const DOC_B = crypto.randomUUID();

const SHA_A = crypto.createHash('sha256').update('phase-d-tb-source').digest('hex');

const app = new Hono();
app.onError(errorHandler);
app.route('/api/workbench', workbenchRoutes);
app.route('/api/provision', provisionRoutes);
app.route('/api/handoff', handoffRoutes);

function tokenFor(userId: string, tenantId: string, role = 'admin'): string {
  return jwt.sign({ userId, tenantId, email: 'phase-d@test.local', role }, env.JWT_SECRET, { expiresIn: '1h' });
}
const TOKEN_A = tokenFor(USER_A, TENANT_A);
const TOKEN_A2 = tokenFor(USER_A2, TENANT_A, 'partner');
const TOKEN_B = tokenFor(USER_B, TENANT_B);

const TB_ROWS = [
  { externalId: 'REV-100', name: 'Sales', type: 'Revenue', balance: 10000 },
  { externalId: 'EXP-200', name: 'Rent', type: 'Expense', balance: -6000 },
  { externalId: 'MISC-300', name: 'Sundry', type: 'OtherIncome', balance: 1000 },
];

async function setupTenant(tid: string, uid: string, eid: string, apId: string, tpId: string, docId: string) {
  await withTenantContext(tid, async (tx) => {
    await tx.insert(tenants).values({ id: tid, name: `Phase D ${tid.slice(0, 8)}`, slug: tid, taxRate: '0.25' }).onConflictDoNothing();
    await tx.insert(users).values({ id: uid, tenantId: tid, email: `phase-d-${tid.slice(0, 8)}@test.local`, passwordHash: 'x', role: 'admin' }).onConflictDoNothing();
    await tx.insert(entities).values({
      id: eid, tenantId: tid, externalId: '8596148860', name: 'Phase D UK Entity', type: 'Limited Company',
      currency: 'GBP', taxJurisdiction: 'UK_FRS102', isConsolidated: false,
    }).onConflictDoNothing();
    await tx.insert(accountingPeriods).values({
      id: apId, tenantId: tid, entityId: eid, name: 'FY2026', startDate: '2026-01-01', endDate: '2026-12-31',
      periodType: 'annual', status: 'open',
    }).onConflictDoNothing();
    await tx.insert(taxPeriods).values({
      id: tpId, tenantId: tid, entityId: eid, accountingPeriodId: apId,
      startDate: '2026-01-01', endDate: '2026-12-31', durationMonths: 12, isStandardDuration: true, status: 'open',
    }).onConflictDoNothing();
    await tx.insert(sourceDocuments).values({
      id: docId, tenantId: tid, entityId: eid, accountingPeriodId: apId, taxPeriodId: tpId,
      documentType: 'trial_balance', filename: 'tb-fy2026.csv', mimeType: 'text/csv', sizeBytes: 1024,
      storageKey: `tb-${docId}`, sha256: SHA_A, provenance: 'manual_upload',
      extractionStatus: 'not_required', version: 1, isCurrent: true, uploadedByUserId: uid,
    }).onConflictDoNothing();
  });
}

async function createRun(): Promise<string> {
  const res = await app.request('/api/workbench/runs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN_A}` },
    body: JSON.stringify({
      idempotencyKey: `phase-d-run-${crypto.randomUUID()}`,
      entityId: ENTITY_A, accountingPeriodId: PERIOD_AP, taxPeriodId: PERIOD_TP, sourceDocumentId: DOC_A,
    }),
  });
  expect(res.status).toBe(200);
  const data = await res.json() as any;
  return data.result.runId;
}

async function resolveOpenItems(runId: string) {
  await withTenantContext(TENANT_A, async (tx) => {
    await tx.update(reviewItems).set({ status: 'resolved' })
      .where(and(eq(reviewItems.provisionRunId, runId), eq(reviewItems.status, 'open')));
  });
}

async function approveAndLock(runId: string) {
  const submit = await app.request(`/api/provision/runs/${runId}/submit-for-approval`, {
    method: 'POST', headers: { Authorization: `Bearer ${TOKEN_A}` },
  });
  expect(submit.status).toBe(200);

  const approve = await app.request(`/api/provision/runs/${runId}/partner-approve`, {
    method: 'POST', headers: { Authorization: `Bearer ${TOKEN_A2}` },
  });
  expect(approve.status).toBe(200);

  const lock = await app.request(`/api/provision/runs/${runId}/lock`, {
    method: 'POST', headers: { Authorization: `Bearer ${TOKEN_A}` },
  });
  expect(lock.status).toBe(200);
}

async function getPackage(runId: string): Promise<{ status: number; bytes: Buffer; sha256: string | null }> {
  const res = await app.request(`/api/handoff/runs/${runId}/package`, {
    headers: { Authorization: `Bearer ${TOKEN_A}` },
  });
  const bytes = Buffer.from(await res.arrayBuffer());
  return { status: res.status, bytes, sha256: res.headers.get('x-manifest-sha256') };
}

beforeAll(async () => {
  await setupTenant(TENANT_A, USER_A, ENTITY_A, PERIOD_AP, PERIOD_TP, DOC_A);
  await setupTenant(TENANT_B, USER_B, ENTITY_B, PERIOD_AP_B, PERIOD_TP_B, DOC_B);

  await withTenantContext(TENANT_A, async (tx) => {
    await tx.insert(users).values({
      id: USER_A2, tenantId: TENANT_A, email: `phase-d-partner-${TENANT_A.slice(0, 8)}@test.local`,
      passwordHash: 'x', role: 'partner',
    }).onConflictDoNothing();
  });

  for (const tid of [TENANT_A, TENANT_B]) {
    await withTenantContext(tid, async (tx) => {
      await tx.insert(ukRules).values({
        tenantId: tid, ruleKey: 'uk.rates.v1', jurisdiction: 'UK_FRS102',
        effectiveFrom: '2026-01-01', effectiveTo: null,
        sourceUrl: 'https://www.gov.uk/rates', sourceSnapshotHash: 'abc123',
        author: 'Phase D test', approvalState: 'approved', version: 1,
      }).onConflictDoNothing();
    });
  }

  await withTenantContext(TENANT_A, async (tx) => {
    const [rev] = await tx.insert(accounts).values({
      tenantId: TENANT_A, externalId: 'REV-100', accountNumber: 'REV-100', name: 'Sales', type: 'Revenue',
    }).onConflictDoNothing().returning();
    const [exp] = await tx.insert(accounts).values({
      tenantId: TENANT_A, externalId: 'EXP-200', accountNumber: 'EXP-200', name: 'Rent', type: 'Expense',
    }).onConflictDoNothing().returning();
    for (const [account, taxAccountType, bookTreatment] of [
      [rev ?? (await tx.select().from(accounts).where(and(eq(accounts.tenantId, TENANT_A), eq(accounts.externalId, 'REV-100'))).limit(1))[0], 'UK_REVENUE', 'permanent'],
      [exp ?? (await tx.select().from(accounts).where(and(eq(accounts.tenantId, TENANT_A), eq(accounts.externalId, 'EXP-200'))).limit(1))[0], 'UK_EXPENSE', 'permanent'],
    ] as const) {
      await tx.insert(taxMappings).values({
        tenantId: TENANT_A, accountId: account.id, taxAccountType, bookTreatment,
        isActive: true, status: 'active', version: 1, suggestedByAi: false,
      }).onConflictDoNothing();
    }
  });

  // One import so account rows exist; runs are created fresh per test.
  await app.request('/api/workbench/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN_A}` },
    body: JSON.stringify({
      idempotencyKey: `phase-d-import-${crypto.randomUUID()}`,
      entityId: ENTITY_A, accountingPeriodId: PERIOD_AP, taxPeriodId: PERIOD_TP, sourceDocumentId: DOC_A,
      rows: TB_ROWS,
    }),
  });
});

afterAll(async () => {
  for (const tid of [TENANT_A, TENANT_B]) {
    await withTenantContext(tid, async (tx) => {
      await tx.delete(tenants).where(eq(tenants.id, tid));
    }).catch(() => {});
  }
});

describe('Phase D — lifecycle: draft → needs_review → locked', () => {
  let runId = '';

  beforeAll(async () => {
    runId = await createRun();
  });

  it('starts needs_review with an open missing-mapping item (MISC-300 unmapped)', async () => {
    const res = await app.request(`/api/handoff/runs/${runId}`, {
      headers: { Authorization: `Bearer ${TOKEN_A}` },
    });
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.lifecycle.stage).toBe('needs_mapping_review');
    expect(data.reviewItems.some((i: any) => i.itemType === 'missing_mapping' && i.status === 'open')).toBe(true);
    // Gate: locked required + open items block handoff; validation still honest.
    const codes = data.blockers.map((b: any) => b.code);
    expect(codes).toContain('run_not_locked');
    expect(codes).toContain('open_review_items');
    expect(data.honesty.notFiledByTaxPro).toBe(true);
  });

  it('handoff-ready is blocked before lock (400 with blockers)', async () => {
    const res = await app.request(`/api/handoff/runs/${runId}/handoff-ready`, {
      method: 'POST', headers: { Authorization: `Bearer ${TOKEN_A}` },
    });
    expect(res.status).toBe(400);
    const data = await res.json() as any;
    expect(data.blocked).toBe(true);
    expect(data.blockers.some((b: any) => b.code === 'run_not_locked')).toBe(true);
  });

  it('resolves items, finalizes, and locks through the real approval ladder', async () => {
    await resolveOpenItems(runId);

    const finalize = await app.request(`/api/provision/runs/${runId}/finalize`, {
      method: 'POST', headers: { Authorization: `Bearer ${TOKEN_A}` },
    });
    expect(finalize.status).toBe(200);

    // A partner cannot approve their own submission or a run they requested.
    const submit = await app.request(`/api/provision/runs/${runId}/submit-for-approval`, {
      method: 'POST', headers: { Authorization: `Bearer ${TOKEN_A}` },
    });
    expect(submit.status).toBe(200);

    const selfApprove = await app.request(`/api/provision/runs/${runId}/partner-approve`, {
      method: 'POST', headers: { Authorization: `Bearer ${TOKEN_A}` },
    });
    expect(selfApprove.status).toBe(403);

    const approve = await app.request(`/api/provision/runs/${runId}/partner-approve`, {
      method: 'POST', headers: { Authorization: `Bearer ${TOKEN_A2}` },
    });
    expect(approve.status).toBe(200);
    const approveJson = await approve.json() as any;
    expect(approveJson.approvedByUserId).toBe(USER_A2);

    const lock = await app.request(`/api/provision/runs/${runId}/lock`, {
      method: 'POST', headers: { Authorization: `Bearer ${TOKEN_A}` },
    });
    expect(lock.status).toBe(200);
  });

  it('shows locked lifecycle with clean gates and validation after lock', async () => {
    const res = await app.request(`/api/handoff/runs/${runId}`, {
      headers: { Authorization: `Bearer ${TOKEN_A}` },
    });
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.lifecycle.stage).toBe('locked');
    expect(data.blockers).toEqual([]);
    expect(data.validation.ct600.valid).toBe(true);
    expect(data.validation.ixbrl).not.toBeNull(); // entity + result → iXBRL derived
    expect(data.run.lockedAt).toBeTruthy();
    expect(data.run.handoffReadyAt).toBeNull();
    expect(data.externalFilings).toEqual([]);
    expect(data.approvalEvents.some((e: any) => e.eventType === 'partner.approved')).toBe(true);
  });

  it('record-filing is refused before the filing-ready handoff', async () => {
    const res = await app.request(`/api/handoff/runs/${runId}/record-filing`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN_A}` },
      body: JSON.stringify({
        filingProvider: 'IRIS', filingReference: 'REF-1', submittedDate: '2026-08-01',
        manifestChecksum: 'a'.repeat(64),
      }),
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/filing-ready|handoff/i);
  });
});

describe('Phase D — deterministic package + manifest', () => {
  let runId = '';
  let manifestSha = '';

  beforeAll(async () => {
    runId = await createRun();
    await resolveOpenItems(runId);
    await approveAndLock(runId);
  });

  it('handoff-ready succeeds for a locked, clean run', async () => {
    const res = await app.request(`/api/handoff/runs/${runId}/handoff-ready`, {
      method: 'POST', headers: { Authorization: `Bearer ${TOKEN_A}` },
    });
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.handoffReadyAt).toBeTruthy();
    expect(data.handoffReadyByUserId).toBe(USER_A);

    const view = await app.request(`/api/handoff/runs/${runId}`, {
      headers: { Authorization: `Bearer ${TOKEN_A}` },
    });
    const viewJson = await view.json() as any;
    expect(viewJson.lifecycle.stage).toBe('filing_ready');
  });

  it('package exports are byte-identical across downloads with a stable manifest hash', async () => {
    const first = await getPackage(runId);
    expect(first.status).toBe(200);
    expect(first.sha256).toMatch(/^[0-9a-f]{64}$/);
    const second = await getPackage(runId);
    expect(second.sha256).toBe(first.sha256);
    expect(second.bytes.equals(first.bytes)).toBe(true);
    manifestSha = first.sha256!;
  });

  it('package contents are the controlled set with a verifiable manifest', async () => {
    const { bytes } = await getPackage(runId);
    const { default: jszip } = await import('jszip');
    const archive = await jszip.loadAsync(bytes);
    const names = Object.keys(archive.files);
    for (const expected of [
      'workpapers/provision-2026-01-01.xlsx',
      'calculations/calc-output-2026-01-01.json',
      'calculations/etr-reconciliation-2026-01-01.json',
      'calculations/deferred-tax-schedule-2026-01-01.json',
      'returns/ct600-2026-01-01.json',
      'returns/ct600-2026-01-01.csv',
      'returns/validation-results-2026-01-01.json',
      'audit/audit-trail-2026-01-01.csv',
      'audit/evidence-index-2026-01-01.json',
      'audit/assumptions-2026-01-01.json',
      'audit/review-decisions-2026-01-01.json',
      'audit/approval-trail-2026-01-01.json',
      'README-2026-01-01.txt',
      'manifest-2026-01-01.json',
      'manifest-2026-01-01.sha256',
    ]) {
      expect(names).toContain(expected);
    }
    expect(names.some((n) => n.includes('ai-traces'))).toBe(false);

    const manifestBytes = await archive.files['manifest-2026-01-01.json'].async('nodebuffer');
    expect(crypto.createHash('sha256').update(manifestBytes).digest('hex')).toBe(manifestSha);
    const manifest = JSON.parse(manifestBytes.toString('utf-8'));
    expect(manifest.kind).toBe('uk-filing-handoff-manifest');
    expect(manifest.schemaVersion).toBe('1.0.0');
    expect(manifest.note).toMatch(/excludes itself/);

    // Band-correct CT600: exactly one of Box 12 / Box 13 populated.
    const ct600 = JSON.parse(await archive.files['returns/ct600-2026-01-01.json'].async('string'));
    const box = (n: number) => Number(ct600.boxes.find((b: any) => b.box === n)?.value ?? 0);
    const populated = [box(12), box(13)].filter((v) => v > 0);
    expect(populated.length).toBe(1);

    // iXBRL presence must match the validation verdict exactly.
    const validation = JSON.parse(await archive.files['returns/validation-results-2026-01-01.json'].async('string'));
    expect(names.some((n) => n.includes('ixbrl-'))).toBe(validation.ixbrl?.included === true);

    const readme = await archive.files['README-2026-01-01.txt'].async('string');
    expect(readme).toMatch(/TaxPro does NOT submit anything to HMRC/i);
  });

  it('manifest endpoint returns the same sha256 as the package header', async () => {
    const res = await app.request(`/api/handoff/runs/${runId}/manifest`, {
      headers: { Authorization: `Bearer ${TOKEN_A}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-manifest-sha256')).toBe(manifestSha);
    const data = await res.json() as any;
    expect(data.sha256).toBe(manifestSha);
  });

  it('package and manifest are unavailable for unlocked runs (honesty: only locked data is exportable)', async () => {
    const unlocked = await createRun();
    const pkg = await app.request(`/api/handoff/runs/${unlocked}/package`, {
      headers: { Authorization: `Bearer ${TOKEN_A}` },
    });
    expect([400, 404]).toContain(pkg.status);
    const man = await app.request(`/api/handoff/runs/${unlocked}/manifest`, {
      headers: { Authorization: `Bearer ${TOKEN_A}` },
    });
    expect([400, 404]).toContain(man.status);
  });
});

describe('Phase D — record external filing (bookkeeping, never a claim)', () => {
  let runId = '';
  let manifestSha = '';

  beforeAll(async () => {
    runId = await createRun();
    await resolveOpenItems(runId);
    await approveAndLock(runId);
    await app.request(`/api/handoff/runs/${runId}/handoff-ready`, {
      method: 'POST', headers: { Authorization: `Bearer ${TOKEN_A}` },
    });
    manifestSha = (await getPackage(runId)).sha256!;
  });

  it('rejects a manifest checksum that does not match the deterministic manifest', async () => {
    const res = await app.request(`/api/handoff/runs/${runId}/record-filing`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN_A}` },
      body: JSON.stringify({
        filingProvider: 'IRIS', filingReference: 'REF-X', submittedDate: '2026-08-01',
        manifestChecksum: 'b'.repeat(64),
      }),
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/does not match/);
  });

  it('records the external filing and flips the run to filed_externally with an honest note', async () => {
    const res = await app.request(`/api/handoff/runs/${runId}/record-filing`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN_A}` },
      body: JSON.stringify({
        filingProvider: 'IRIS', filingReference: 'REF-2026-001', submittedDate: '2026-08-01',
        manifestChecksum: manifestSha,
      }),
    });
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.note).toMatch(/TaxPro did not submit/);
    expect(data.filing.filingProvider).toBe('IRIS');
    expect(data.filing.manifestChecksum).toBe(manifestSha);

    const view = await app.request(`/api/handoff/runs/${runId}`, {
      headers: { Authorization: `Bearer ${TOKEN_A}` },
    });
    const viewJson = await view.json() as any;
    expect(viewJson.lifecycle.stage).toBe('filed_externally');
    expect(viewJson.externalFilings).toHaveLength(1);
    expect(viewJson.run.filedExternallyAt).toBeTruthy();
    expect(viewJson.run.filedExternallyByUserId).toBe(USER_A);
    expect(viewJson.honesty.notFiledByTaxPro).toBe(false);
  });

  it('allows repeated records (append-only history) with the same verified manifest', async () => {
    const res = await app.request(`/api/handoff/runs/${runId}/record-filing`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN_A}` },
      body: JSON.stringify({
        filingProvider: 'TaxCalc', filingReference: 'REF-2026-002', submittedDate: '2026-08-03',
        manifestChecksum: manifestSha,
      }),
    });
    expect(res.status).toBe(200);

    const view = await app.request(`/api/handoff/runs/${runId}`, {
      headers: { Authorization: `Bearer ${TOKEN_A}` },
    });
    const viewJson = await view.json() as any;
    expect(viewJson.externalFilings).toHaveLength(2);
    expect(viewJson.externalFilings[1].filingProvider).toBe('TaxCalc');
  });

  it('unlock is refused once an external filing is recorded (integrity: package must stay immutable)', async () => {
    const res = await app.request(`/api/provision/runs/${runId}/unlock`, {
      method: 'POST', headers: { Authorization: `Bearer ${TOKEN_A}` },
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/external filing/);
  });

  it('external_filings is append-only at the database level', async () => {
    await expect(withTenantContext(TENANT_A, async (tx) => {
      await tx.update(externalFilings).set({ filingReference: 'HACKED' })
        .where(eq(externalFilings.runId, runId));
    })).rejects.toThrow();
  });

  it('tenant B sees zero filings via RLS and cannot read A’s handoff surface', async () => {
    await withTenantContext(TENANT_B, async (tx) => {
      // Assert database-level isolation as the NOBYPASSRLS runtime role.
      // Test harnesses (including CI) connect as a superuser, which bypasses
      // RLS policies entirely — so assume the runtime role for this one
      // assertion. SET LOCAL is scoped to this transaction and reverts
      // automatically; app.tenant_id was already set by withTenantContext.
      await tx.execute(sql`SET LOCAL ROLE taxpro_app`);
      const rows = await tx.select().from(externalFilings).where(eq(externalFilings.runId, runId));
      expect(rows).toHaveLength(0);
    });

    for (const path of [`/api/handoff/runs/${runId}`, `/api/handoff/runs/${runId}/package`, `/api/handoff/runs/${runId}/manifest`]) {
      const res = await app.request(path, { headers: { Authorization: `Bearer ${TOKEN_B}` } });
      expect([400, 404]).toContain(res.status);
    }

    const filing = await app.request(`/api/handoff/runs/${runId}/record-filing`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN_B}` },
      body: JSON.stringify({
        filingProvider: 'IRIS', filingReference: 'X', submittedDate: '2026-08-01',
        manifestChecksum: manifestSha,
      }),
    });
    // Any denial counts: 404 (run hidden), 403 (app-level cross-tenant
    // guard), or 400 (validation). What must never happen is 2xx.
    expect([400, 403, 404]).toContain(filing.status);
  });

  it('read-only roles are refused for handoff actions', async () => {
    const readToken = tokenFor(crypto.randomUUID(), TENANT_A, 'client_readonly');
    const res = await app.request(`/api/handoff/runs/${runId}/handoff-ready`, {
      method: 'POST', headers: { Authorization: `Bearer ${readToken}` },
    });
    expect(res.status).toBe(403);
  });
});

describe('Phase D — unlock clears handoff state; re-lock requires re-handoff', () => {
  let runId = '';

  beforeAll(async () => {
    runId = await createRun();
    await resolveOpenItems(runId);
    await approveAndLock(runId);
    await app.request(`/api/handoff/runs/${runId}/handoff-ready`, {
      method: 'POST', headers: { Authorization: `Bearer ${TOKEN_A}` },
    });
  });

  it('unlock clears handoffReadyAt and returns the run to mutable draft', async () => {
    const res = await app.request(`/api/provision/runs/${runId}/unlock`, {
      method: 'POST', headers: { Authorization: `Bearer ${TOKEN_A}` },
    });
    expect(res.status).toBe(200);

    await withTenantContext(TENANT_A, async (tx) => {
      const [run] = await tx.select().from(provisionRuns).where(eq(provisionRuns.id, runId)).limit(1);
      expect(run.status).toBe('draft');
      expect(run.handoffReadyAt).toBeNull();
      expect(run.handoffReadyByUserId).toBeNull();
      expect(run.lockedAt).toBeNull();
      expect(run.approvalStatus).toBe('approved'); // approval survives unlock
    });

    const view = await app.request(`/api/handoff/runs/${runId}`, {
      headers: { Authorization: `Bearer ${TOKEN_A}` },
    });
    const viewJson = await view.json() as any;
    expect(viewJson.lifecycle.stage).toBe('approved');
  });

  it('re-lock works after unlock, and handoff must be re-asserted (state was cleared)', async () => {
    const lock = await app.request(`/api/provision/runs/${runId}/lock`, {
      method: 'POST', headers: { Authorization: `Bearer ${TOKEN_A}` },
    });
    expect(lock.status).toBe(200);

    const view = await app.request(`/api/handoff/runs/${runId}`, {
      headers: { Authorization: `Bearer ${TOKEN_A}` },
    });
    const viewJson = await view.json() as any;
    expect(viewJson.lifecycle.stage).toBe('locked');
    expect(viewJson.run.handoffReadyAt).toBeNull();

    const filing = await app.request(`/api/handoff/runs/${runId}/record-filing`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN_A}` },
      body: JSON.stringify({
        filingProvider: 'IRIS', filingReference: 'REF-Y', submittedDate: '2026-08-01',
        manifestChecksum: 'a'.repeat(64),
      }),
    });
    expect(filing.status).toBe(400); // handoff-not-ready gate re-applies
  });
});

describe('Phase D — maker-checker (tenant flag enforced across approve/lock/handoff/filing)', () => {
  let runId = '';

  beforeAll(async () => {
    await withTenantContext(TENANT_A, async (tx) => {
      await tx.update(tenants).set({ makerCheckerEnabled: true }).where(eq(tenants.id, TENANT_A));
    });
    runId = await createRun();
    await resolveOpenItems(runId);
  });

  afterAll(async () => {
    await withTenantContext(TENANT_A, async (tx) => {
      await tx.update(tenants).set({ makerCheckerEnabled: false }).where(eq(tenants.id, TENANT_A));
    });
  });

  it('the run creator is recorded as maker; the same user cannot approve it', async () => {
    await withTenantContext(TENANT_A, async (tx) => {
      const [run] = await tx.select().from(provisionRuns).where(eq(provisionRuns.id, runId)).limit(1);
      expect(run.requestedByUserId).toBe(USER_A);
    });

    await app.request(`/api/provision/runs/${runId}/finalize`, {
      method: 'POST', headers: { Authorization: `Bearer ${TOKEN_A}` },
    });
    await app.request(`/api/provision/runs/${runId}/submit-for-approval`, {
      method: 'POST', headers: { Authorization: `Bearer ${TOKEN_A}` },
    });

    // The creator is doubly blocked: the self-approval rule fires first, and
    // maker-checker independently forbids it. Either 403 satisfies the intent.
    const selfApprove = await app.request(`/api/provision/runs/${runId}/partner-approve`, {
      method: 'POST', headers: { Authorization: `Bearer ${TOKEN_A}` },
    });
    expect(selfApprove.status).toBe(403);

    const otherApprove = await app.request(`/api/provision/runs/${runId}/partner-approve`, {
      method: 'POST', headers: { Authorization: `Bearer ${TOKEN_A2}` },
    });
    expect(otherApprove.status).toBe(200);
  });

  it('lock, handoff and record-filing are each refused for the maker and allowed for the checker', async () => {
    const selfLock = await app.request(`/api/provision/runs/${runId}/lock`, {
      method: 'POST', headers: { Authorization: `Bearer ${TOKEN_A}` },
    });
    expect(selfLock.status).toBe(403);

    const otherLock = await app.request(`/api/provision/runs/${runId}/lock`, {
      method: 'POST', headers: { Authorization: `Bearer ${TOKEN_A2}` },
    });
    expect(otherLock.status).toBe(200);

    const selfHandoff = await app.request(`/api/handoff/runs/${runId}/handoff-ready`, {
      method: 'POST', headers: { Authorization: `Bearer ${TOKEN_A}` },
    });
    expect(selfHandoff.status).toBe(403);

    const otherHandoff = await app.request(`/api/handoff/runs/${runId}/handoff-ready`, {
      method: 'POST', headers: { Authorization: `Bearer ${TOKEN_A2}` },
    });
    expect(otherHandoff.status).toBe(200);

    const pkg = await getPackage(runId);
    expect(pkg.sha256).toMatch(/^[0-9a-f]{64}$/);

    const selfFiling = await app.request(`/api/handoff/runs/${runId}/record-filing`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN_A}` },
      body: JSON.stringify({
        filingProvider: 'IRIS', filingReference: 'REF-MC', submittedDate: '2026-08-01',
        manifestChecksum: pkg.sha256!,
      }),
    });
    expect(selfFiling.status).toBe(403);

    const otherFiling = await app.request(`/api/handoff/runs/${runId}/record-filing`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN_A2}` },
      body: JSON.stringify({
        filingProvider: 'IRIS', filingReference: 'REF-MC', submittedDate: '2026-08-01',
        manifestChecksum: pkg.sha256!,
      }),
    });
    expect(otherFiling.status).toBe(200);
  });
});
