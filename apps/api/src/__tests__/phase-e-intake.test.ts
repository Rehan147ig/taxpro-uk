// ─────────────────────────────────────────────────────────────────────────────
// Phase E — enterprise data intake.
// Covers: CSV parsing, deterministic validation, batch lifecycle
// (upload → validate → suggestions → decide → commit), tax memory, evidence
// links, lineage, metrics, governed adjustments, RLS isolation and RBAC.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Hono } from 'hono';
import jwt from 'jsonwebtoken';
import { and, eq } from 'drizzle-orm';
import crypto from 'crypto';
import { withTenantContext } from '../config/db.js';
import { env } from '../config/env.js';
import { errorHandler } from '../lib/middleware/error-handler.js';
import { intakeRoutes } from '../modules/intake/intake.routes.js';
import { parseCsv, rowToRecord } from '../modules/intake/csv.js';
import { validateRow, buildBatchSummary } from '../modules/intake/validate.js';
import { tenants } from '../db/schema/tenants.js';
import { users } from '../db/schema/users.js';
import { entities } from '../db/schema/entities.js';
import { accountingPeriods } from '../db/schema/accounting-periods.js';
import { taxPeriods } from '../db/schema/tax-periods.js';
import { sourceDocuments } from '../db/schema/source-documents.js';
import { accounts } from '../db/schema/accounts.js';
import { trialBalance } from '../db/schema/trial-balance.js';
import { provisionRuns } from '../db/schema/provision-runs.js';
import { importBatches, importBatchRows } from '../db/schema/import-batches.js';
import { evidenceLinks } from '../db/schema/evidence-links.js';
import { mappingSuggestions, taxMemoryPrecedents } from '../db/schema/tax-memory.js';
import { reviewerFeedbackEvents } from '../db/schema/feedback.js';
import { dataLineageEdges } from '../db/schema/lineage.js';
import { aiRuns, aiSteps } from '../db/schema/ai-runs.js';

// The test environment may carry real model credentials; keep every AI call
// offline and deterministic. The AI path is exercised separately below with a
// mocked model client.
vi.mock('../eve/model-client.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../eve/model-client.js')>();
  return {
    ...mod,
    callJsonModel: vi.fn().mockResolvedValue({
      parsed: { suggestions: [{ batchRowId: 'unused', taxAccountType: 'NODIFF_EXPENSE', bookTreatment: 'no_diff', confidenceScore: 0.9, explanation: 'mock' }] },
      provider: 'mock-provider', model: 'mock-model',
    }),
  };
});

vi.mock('../modules/intake/agent.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../modules/intake/agent.js')>();
  return { ...mod, enrichSuggestionsWithAi: vi.fn().mockResolvedValue([]) };
});
import { enrichSuggestionsWithAi } from '../modules/intake/agent.js';
const mockEnrichSuggestionsWithAi = vi.mocked(enrichSuggestionsWithAi);

const TENANT_A = crypto.randomUUID();
const TENANT_B = crypto.randomUUID();
const USER_A = crypto.randomUUID();
const USER_B = crypto.randomUUID();
const ENTITY_A = crypto.randomUUID();
const ENTITY_B = crypto.randomUUID();
const PERIOD_AP = crypto.randomUUID();
const PERIOD_AP_B = crypto.randomUUID();
const PERIOD_TP = crypto.randomUUID();
const DOC_A = crypto.randomUUID();

const SHA_A = crypto.createHash('sha256').update('phase-e-source').digest('hex');

const app = new Hono();
app.onError(errorHandler);
app.route('/api/intake', intakeRoutes);

function tokenFor(userId: string, tenantId: string, role = 'admin'): string {
  return jwt.sign({ userId, tenantId, email: `phase-e-${tenantId.slice(0, 8)}@test.local`, role }, env.JWT_SECRET, { expiresIn: '1h' });
}
const TOKEN_A = tokenFor(USER_A, TENANT_A);
const TOKEN_B = tokenFor(USER_B, TENANT_B);
const TOKEN_READONLY_A = tokenFor(USER_A, TENANT_A, 'client_readonly');

const HEADERS = 'entityName,entityExternalId,accountName,accountNumber,accountExternalId,accountType,detailType,period,periodEnd,debit,credit,balance,currency';

const CSV_GOOD = [
  HEADERS,
  'Acme UK Ltd,acme-uk,Software Subscriptions,REV-100,REV-100,Income,OtherIncome,2026-03-31,2026-03-31,10000,,,GBP',
  'Acme UK Ltd,acme-uk,Office Rent,EXP-200,EXP-200,Expense,OperatingExpense,2026-03-31,2026-03-31,,4000,,GBP',
  'Acme UK Ltd,acme-uk,Audit Fees,EXP-300,EXP-300,Expense,OperatingExpense,2026-03-31,2026-03-31,,6000,,GBP',
].join('\n');

const CSV_RENT = [
  HEADERS,
  'Acme UK Ltd,acme-uk,Rent,EXP-400,EXP-400,Expense,OperatingExpense,2026-03-31,2026-03-31,,2500,,GBP',
].join('\n');

const CSV_MIXED_ERROR = [
  HEADERS,
  'Acme UK Ltd,acme-uk,Sales,REV-101,REV-101,Income,OtherIncome,2026-03-31,2026-03-31,500,,,GBP',
  'Acme UK Ltd,acme-uk,Opening Balance,OB-001,OB-001,Expense,OtherExpense,2025-01-01,2025-01-01,,500,,GBP',
].join('\n');

const CSV_ALL_ERROR = [
  HEADERS,
  'Acme UK Ltd,acme-uk,,ACC-1,ACC-1,Expense,OtherExpense,2026-03-31,2026-03-31,,10,,GBP',
].join('\n');

async function uploadCsv(token: string, csv: string, extra: Record<string, string> = {}, filename = 'tb-fy2026.csv') {
  const form = new FormData();
  form.append('entityId', extra.entityId ?? ENTITY_A);
  form.append('accountingPeriodId', extra.accountingPeriodId ?? PERIOD_AP);
  for (const [k, v] of Object.entries(extra)) {
    if (k !== 'entityId' && k !== 'accountingPeriodId') form.append(k, v);
  }
  form.append('file', new File([csv], filename, { type: 'text/csv' }));
  return app.request('/api/intake/batches', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
}

async function suggestionForAccount(token: string, batchId: string, accountName: string) {
  const rows = await (await app.request(`/api/intake/batches/${batchId}/rows`, { headers: { Authorization: `Bearer ${token}` } })).json();
  const row = rows.rows.find((r: { normalized?: { accountName?: string } | null }) => r.normalized?.accountName === accountName);
  const list = await (await app.request(`/api/intake/batches/${batchId}/suggestions`, { headers: { Authorization: `Bearer ${token}` } })).json();
  return list.suggestions.find((s: { batchRowId: string }) => s.batchRowId === row.id);
}

let batchAId: string;
let batchA2Id: string;
let batchBId: string;
let batchCId: string;
let batchDId: string;
let committedAccountId: string;

beforeAll(async () => {
  for (const [tid, uid, eid, apId] of [
    [TENANT_A, USER_A, ENTITY_A, PERIOD_AP],
    [TENANT_B, USER_B, ENTITY_B, PERIOD_AP_B],
  ] as const) {
    await withTenantContext(tid, async (tx) => {
      await tx.insert(tenants).values({ id: tid, name: `Phase E ${tid.slice(0, 8)}`, slug: tid, taxRate: '0.25' }).onConflictDoNothing();
      await tx.insert(users).values({ id: uid, tenantId: tid, email: `phase-e-${tid.slice(0, 8)}@test.local`, passwordHash: 'x', role: 'admin' }).onConflictDoNothing();
      await tx.insert(entities).values({
        id: eid, tenantId: tid, externalId: eid, name: 'Phase E UK Entity', type: 'Limited Company',
        currency: 'GBP', taxJurisdiction: 'UK_FRS102', isConsolidated: false,
      }).onConflictDoNothing();
      await tx.insert(accountingPeriods).values({
        id: apId, tenantId: tid, entityId: eid, name: 'FY2026', startDate: '2026-01-01', endDate: '2026-12-31',
        periodType: 'annual', status: 'open',
      }).onConflictDoNothing();
      if (tid === TENANT_A) {
        await tx.insert(taxPeriods).values({
          id: PERIOD_TP, tenantId: tid, entityId: eid, accountingPeriodId: apId,
          startDate: '2026-01-01', endDate: '2026-12-31', durationMonths: 12, isStandardDuration: true, status: 'open',
        }).onConflictDoNothing();
        await tx.insert(sourceDocuments).values({
          id: DOC_A, tenantId: tid, entityId: eid, accountingPeriodId: apId, taxPeriodId: PERIOD_TP,
          documentType: 'trial_balance', filename: 'tb-fy2026.csv', mimeType: 'text/csv', sizeBytes: 1024,
          storageKey: `tb-${DOC_A}`, sha256: SHA_A, provenance: 'manual_upload',
          extractionStatus: 'not_required', version: 1, isCurrent: true, uploadedByUserId: uid,
        }).onConflictDoNothing();
      }
    });
  }
});

afterAll(async () => {
  // Best-effort cleanup. import_batches/import_batch_events are intentionally
  // left in place (the events table is append-only, so cascading deletes are
  // rejected by design); everything else is removed.
  for (const tid of [TENANT_A, TENANT_B]) {
    await withTenantContext(tid, async (tx) => {
      const attempts: Array<Promise<unknown>> = [
        tx.delete(dataLineageEdges).where(eq(dataLineageEdges.tenantId, tid)),
        tx.delete(evidenceLinks).where(eq(evidenceLinks.tenantId, tid)),
        tx.delete(taxMemoryPrecedents).where(eq(taxMemoryPrecedents.tenantId, tid)),
        tx.delete(mappingSuggestions).where(eq(mappingSuggestions.tenantId, tid)),
        tx.delete(aiSteps).where(eq(aiSteps.tenantId, tid)),
        tx.delete(aiRuns).where(eq(aiRuns.tenantId, tid)),
        tx.delete(trialBalance).where(eq(trialBalance.tenantId, tid)),
        tx.delete(accounts).where(eq(accounts.tenantId, tid)),
        tx.delete(sourceDocuments).where(eq(sourceDocuments.tenantId, tid)),
      ];
      await Promise.allSettled(attempts);
      const settled = await Promise.allSettled([
        tx.delete(importBatches).where(eq(importBatches.tenantId, tid)),
        tx.delete(taxPeriods).where(eq(taxPeriods.tenantId, tid)),
        tx.delete(accountingPeriods).where(eq(accountingPeriods.tenantId, tid)),
        tx.delete(entities).where(eq(entities.tenantId, tid)),
        tx.delete(users).where(eq(users.tenantId, tid)),
        tx.delete(tenants).where(eq(tenants.id, tid)),
      ]);
      for (const s of settled) if (s.status === 'rejected') { /* append-only guard; ignore */ }
    });
  }
});

// ── Pure: CSV parser ──

describe('Phase E — CSV parser (pure)', () => {
  it('parses quoted fields with embedded commas, newlines and escaped quotes', () => {
    const text = 'entity,note,amount\r\n"Acme, UK Ltd","line1\nline2","1,000.50"\r\n';
    const parsed = parseCsv(text);
    expect(parsed.headers).toEqual(['entity', 'note', 'amount']);
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0].values).toEqual(['Acme, UK Ltd', 'line1\nline2', '1,000.50']);
    expect(parsed.rows[0].lineNumber).toBe(2);
  });

  it('skips the BOM and tolerates trailing newlines', () => {
    const parsed = parseCsv('\uFEFFa,b\n1,2\n');
    expect(parsed.headers).toEqual(['a', 'b']);
    expect(parsed.rows).toHaveLength(1);
  });

  it('rejects empty files', () => {
    expect(() => parseCsv('')).toThrow();
  });

  it('maps rows to records by header', () => {
    const parsed = parseCsv('a,b\n1,2\n');
    expect(rowToRecord(parsed.headers, parsed.rows[0].values)).toEqual({ a: '1', b: '2' });
  });
});

// ── Pure: validator ──

describe('Phase E — deterministic validation (pure)', () => {
  const ctx = { periodStart: '2026-01-01', periodEnd: '2026-12-31', defaultCurrency: 'GBP' };
  const parsed = parseCsv(CSV_GOOD);
  const row = parsed.rows[0];

  it('accepts a well-formed row and normalizes it', () => {
    const res = validateRow(row, parsed.headers, ctx);
    expect(res.status).toBe('ok');
    expect(res.normalized).toMatchObject({
      accountName: 'Software Subscriptions',
      period: '2026-03-31',
      debit: 10000,
      credit: 0,
      currency: 'GBP',
    });
  });

  it('flags missing required fields', () => {
    const bad = parseCsv('accountName,accountType,period\n,Expense,2026-03-31\n');
    const res = validateRow(bad.rows[0], bad.headers, ctx);
    expect(res.status).toBe('error');
    expect(res.issues.map((i) => i.code)).toContain('MISSING_REQUIRED');
  });

  it('flags out-of-range and malformed dates', () => {
    const bad = parseCsv('accountName,accountType,period\nOpening,Expense,2025-01-01\n');
    const res = validateRow(bad.rows[0], bad.headers, ctx);
    expect(res.issues.map((i) => i.code)).toContain('PERIOD_OUT_OF_RANGE');
  });

  it('flags unsupported currency', () => {
    const bad = parseCsv('accountName,accountType,period,currency\nOpening,Expense,2026-03-31,USD\n');
    const res = validateRow(bad.rows[0], bad.headers, ctx);
    expect(res.issues.map((i) => i.code)).toContain('INVALID_CURRENCY');
  });

  it('warns when a row has both debit and credit', () => {
    const bad = parseCsv('accountName,accountType,period,debit,credit\nSundry,Expense,2026-03-31,100,100\n');
    const res = validateRow(bad.rows[0], bad.headers, ctx);
    expect(res.status).toBe('warning');
    expect(res.issues.map((i) => i.code)).toContain('AMOUNT_MISMATCH');
  });

  it('builds balanced control totals from the good batch', () => {
    const results = parsed.rows.map((r, i) => ({ lineNumber: r.lineNumber, result: validateRow(r, parsed.headers, ctx) }));
    const summary = buildBatchSummary(results);
    expect(summary.okCount).toBe(3);
    expect(summary.errorCount).toBe(0);
    expect(summary.controlTotals).toMatchObject({ debitTotal: 10000, creditTotal: 10000, difference: 0, balanced: true });
  });
});

// ── Integration: batch lifecycle ──

describe('Phase E — batch intake lifecycle', () => {
  it('uploads a valid CSV and marks the batch ready for review', async () => {
    const res = await uploadCsv(TOKEN_A, CSV_GOOD, { sourceReference: 'phase-e-good', sourceDocumentId: DOC_A });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.duplicate).toBe(false);
    expect(body.batch.status).toBe('ready_for_review');
    expect(body.batch.rowCount).toBe(3);
    expect(body.batch.controlTotals.balanced).toBe(true);
    expect(body.summary).toMatchObject({ rows: 3, ok: 3, errors: 0, warnings: 0 });
    batchAId = body.batch.id;
  });

  it('lists batches and exposes events and row stats', async () => {
    const res = await app.request(`/api/intake/batches/${batchAId}`, { headers: { Authorization: `Bearer ${TOKEN_A}` } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rowStats).toMatchObject({ total: 3, ok: 3, errors: 0 });
    const types = body.events.map((e: { eventType: string }) => e.eventType);
    expect(types).toEqual(expect.arrayContaining(['batch.created', 'batch.validated']));

    const list = await (await app.request('/api/intake/batches', { headers: { Authorization: `Bearer ${TOKEN_A}` } })).json();
    expect(list.batches.map((b: { id: string }) => b.id)).toContain(batchAId);
  });

  it('rejects duplicate uploads idempotently', async () => {
    const res = await uploadCsv(TOKEN_A, CSV_GOOD, { sourceReference: 'phase-e-good', sourceDocumentId: DOC_A });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.duplicate).toBe(true);
    expect(body.batch.id).toBe(batchAId);
  });

  it('rejects non-CSV files', async () => {
    const res = await uploadCsv(TOKEN_A, CSV_GOOD, {}, 'tb.xlsx');
    expect(res.status).toBe(400);
  });

  it('fails a batch when every row fails validation', async () => {
    const res = await uploadCsv(TOKEN_A, CSV_ALL_ERROR, { sourceReference: 'phase-e-all-error' });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.batch.status).toBe('failed');
    expect(body.batch.failureReason).toContain('validation');
    batchDId = body.batch.id;
  });

  it('keeps a mixed batch in ready_for_review with error rows surfaced', async () => {
    const res = await uploadCsv(TOKEN_A, CSV_MIXED_ERROR, { sourceReference: 'phase-e-mixed' });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.batch.status).toBe('ready_for_review');
    expect(body.summary).toMatchObject({ rows: 2, ok: 1, errors: 1 });
    batchCId = body.batch.id;

    const rows = await (await app.request(`/api/intake/batches/${batchCId}/rows?status=error`, { headers: { Authorization: `Bearer ${TOKEN_A}` } })).json();
    expect(rows.rows[0].validation.codes).toContain('PERIOD_OUT_OF_RANGE');
  });

  it('enforces RBAC: client_readonly cannot create batches', async () => {
    const res = await uploadCsv(TOKEN_READONLY_A, CSV_GOOD);
    expect(res.status).toBe(403);
  });

  it('enforces RLS: tenant B cannot read tenant A batches', async () => {
    const res = await app.request(`/api/intake/batches/${batchAId}`, { headers: { Authorization: `Bearer ${TOKEN_B}` } });
    expect(res.status).toBe(404);
  });

  it('generates deterministic suggestions (rules-based fallback)', async () => {
    const res = await app.request(`/api/intake/batches/${batchAId}/suggestions/generate`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN_A}` } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.generated).toBe(3);

    const list = await (await app.request(`/api/intake/batches/${batchAId}/suggestions`, { headers: { Authorization: `Bearer ${TOKEN_A}` } })).json();
    expect(list.suggestions).toHaveLength(3);
    expect(list.suggestions.every((s: { status: string }) => s.status === 'pending')).toBe(true);
    expect(list.suggestions.map((s: { source: string }) => s.source)).toEqual(['rules', 'rules', 'rules']);
  });

  it('accepts a suggestion, creating a durable precedent and feedback event', async () => {
    const revenue = await suggestionForAccount(TOKEN_A, batchAId, 'Software Subscriptions');

    const res = await app.request(`/api/intake/suggestions/${revenue.id}/decide`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN_A}` },
      body: JSON.stringify({ decision: 'accept', reason: 'standard revenue' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.suggestion.status).toBe('accepted');

    const precedent = await withTenantContext(TENANT_A, async (tx) =>
      tx.select().from(taxMemoryPrecedents).where(and(eq(taxMemoryPrecedents.tenantId, TENANT_A), eq(taxMemoryPrecedents.taxAccountType, 'NODIFF_REVENUE'))));
    expect(precedent).toHaveLength(1);
    expect(precedent[0].source).toBe('approved_mapping');

    const feedback = await withTenantContext(TENANT_A, async (tx) =>
      tx.select().from(reviewerFeedbackEvents).where(eq(reviewerFeedbackEvents.tenantId, TENANT_A)));
    expect(feedback.length).toBeGreaterThanOrEqual(1);
  });

  it('overrides a suggestion with reviewer corrections, recording overriddenFrom', async () => {
    const audit = await suggestionForAccount(TOKEN_A, batchAId, 'Audit Fees');

    const res = await app.request(`/api/intake/suggestions/${audit.id}/decide`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN_A}` },
      body: JSON.stringify({
        decision: 'override', reason: 'capitalised software QA costs',
        override: { taxAccountType: 'PERM_QA_CAPITALISED', bookTreatment: 'permanent' },
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.suggestion.status).toBe('overridden');
    expect(body.suggestion.overriddenFrom).toMatchObject({ suggestedTaxAccountType: 'NODIFF_EXPENSE' });

    const corrected = await withTenantContext(TENANT_A, async (tx) =>
      tx.select().from(taxMemoryPrecedents).where(and(eq(taxMemoryPrecedents.tenantId, TENANT_A), eq(taxMemoryPrecedents.source, 'reviewer_corrected'))));
    expect(corrected).toHaveLength(1);
    expect(corrected[0].taxAccountType).toBe('PERM_QA_CAPITALISED');
  });

  it('rejects double-deciding a suggestion', async () => {
    const officeRent = await suggestionForAccount(TOKEN_A, batchAId, 'Office Rent');

    const first = await app.request(`/api/intake/suggestions/${officeRent.id}/decide`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN_A}` },
      body: JSON.stringify({ decision: 'accept' }),
    });
    expect(first.status).toBe(200);

    const second = await app.request(`/api/intake/suggestions/${officeRent.id}/decide`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN_A}` },
      body: JSON.stringify({ decision: 'accept' }),
    });
    expect(second.status).toBe(409);
  });

  it('blocks commit while any row failed validation', async () => {
    const res = await app.request(`/api/intake/batches/${batchCId}/commit`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN_A}` } });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain('failed validation');
  });

  it('commits a clean batch, upserting entities, accounts and trial balance', async () => {
    const res = await app.request(`/api/intake/batches/${batchAId}/commit`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN_A}` } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.batch.status).toBe('committed');
    expect(body.committedRows).toBe(3);
    expect(body.accounts).toBe(3);

    const tb = await withTenantContext(TENANT_A, async (tx) =>
      tx.select().from(trialBalance).where(and(eq(trialBalance.tenantId, TENANT_A), eq(trialBalance.period, '2026-03-31'))));
    expect(tb).toHaveLength(3);
    committedAccountId = tb[0].accountId;

    const events = await (await app.request(`/api/intake/batches/${batchAId}`, { headers: { Authorization: `Bearer ${TOKEN_A}` } })).json();
    expect(events.events.map((e: { eventType: string }) => e.eventType)).toContain('batch.committed');

    const graph = await (await app.request(`/api/intake/lineage/account/${committedAccountId}`, { headers: { Authorization: `Bearer ${TOKEN_A}` } })).json();
    const kinds = graph.nodes.map((n: { kind: string }) => n.kind);
    expect(kinds).toEqual(expect.arrayContaining(['account', 'import_batch_row', 'trial_balance']));
  });

  it('rejects re-committing an already committed batch', async () => {
    const res = await app.request(`/api/intake/batches/${batchAId}/commit`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN_A}` } });
    expect(res.status).toBe(409);
  });

  it('supersedes the previous committed batch for the same entity, period and source', async () => {
    const res = await uploadCsv(TOKEN_A, CSV_GOOD, { sourceSystem: 'netsuite', sourceReference: 'phase-e-good-v2' });
    expect(res.status).toBe(201);
    const body = await res.json();
    batchA2Id = body.batch.id;

    const commit = await app.request(`/api/intake/batches/${batchA2Id}/commit`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN_A}` } });
    expect(commit.status).toBe(200);
    const commitBody = await commit.json();
    expect(commitBody.supersededBatches).toContain(batchAId);

    const superseded = await (await app.request(`/api/intake/batches/${batchAId}`, { headers: { Authorization: `Bearer ${TOKEN_A}` } })).json();
    expect(superseded.batch.status).toBe('superseded');
    expect(superseded.batch.supersededByBatchId).toBe(batchA2Id);
  });

  it('recalls a tax memory precedent for a similar future account', async () => {
    const res = await uploadCsv(TOKEN_A, CSV_RENT, { sourceReference: 'phase-e-rent' });
    expect(res.status).toBe(201);
    const body = await res.json();
    batchBId = body.batch.id;

    await app.request(`/api/intake/batches/${batchBId}/suggestions/generate`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN_A}` } });
    const list = await (await app.request(`/api/intake/batches/${batchBId}/suggestions`, { headers: { Authorization: `Bearer ${TOKEN_A}` } })).json();
    expect(list.suggestions).toHaveLength(1);
    expect(list.suggestions[0].source).toBe('tax_memory');
    expect(list.suggestions[0].citedAccountName).toBe('Office Rent');
  });

  it('fails a batch on demand with a reason', async () => {
    const res = await app.request(`/api/intake/batches/${batchCId}/fail`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN_A}` },
      body: JSON.stringify({ reason: 'source ledger restated' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.batch.status).toBe('failed');
    expect(body.batch.failureReason).toBe('source ledger restated');
  });

  it('traces AI runs and steps with the tenant id (RLS-safe)', async () => {
    const realAgent = await vi.importActual<typeof import('../modules/intake/agent.js')>('../modules/intake/agent.js');
    mockEnrichSuggestionsWithAi.mockImplementation(realAgent.enrichSuggestionsWithAi);
    try {
      await withTenantContext(TENANT_A, async (tx) => {
        const [row] = await tx.select().from(importBatchRows)
          .where(and(eq(importBatchRows.tenantId, TENANT_A), eq(importBatchRows.status, 'ok')))
          .limit(1);
        await mockEnrichSuggestionsWithAi(tx, {
          tenantId: TENANT_A, userId: USER_A, workflowName: 'intake-suggestions', promptVersion: 'intake-suggestion-v1',
        }, [{ batchRowId: row.id, accountName: 'Probe Account', accountNumber: 'P-1', accountType: 'Expense' }]);
      });

      const runs = await withTenantContext(TENANT_A, async (tx) =>
        tx.select().from(aiRuns).where(and(eq(aiRuns.tenantId, TENANT_A), eq(aiRuns.workflowName, 'intake-suggestions'))));
      expect(runs.length).toBeGreaterThanOrEqual(1);
      expect(runs.every((r) => r.status === 'completed')).toBe(true);

      const steps = await withTenantContext(TENANT_A, async (tx) =>
        tx.select().from(aiSteps).where(eq(aiSteps.tenantId, TENANT_A)));
      expect(steps.length).toBeGreaterThanOrEqual(2);
    } finally {
      mockEnrichSuggestionsWithAi.mockImplementation(async () => []);
    }
  });
});

// ── Integration: evidence, lineage, metrics, adjustments ──

describe('Phase E — evidence, lineage, metrics and adjustments', () => {
  it('links a source document as evidence to a batch', async () => {
    const res = await app.request(`/api/intake/batches/${batchA2Id}/evidence`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN_A}` },
      body: JSON.stringify({ documentId: DOC_A, note: 'source TB' }),
    });
    expect(res.status).toBe(201);

    const list = await (await app.request('/api/intake/evidence-links?subjectKind=import_batch', { headers: { Authorization: `Bearer ${TOKEN_A}` } })).json();
    expect(list.links.length).toBeGreaterThanOrEqual(1);
    expect(list.links.some((l: { evidenceRole: string; documentId: string }) =>
      l.evidenceRole === 'supporting' && l.documentId === DOC_A)).toBe(true);
  });

  it('rejects evidence for a document that is not in the tenant', async () => {
    const res = await app.request('/api/intake/evidence-links', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN_B}` },
      body: JSON.stringify({ subjectKind: 'import_batch', subjectId: batchA2Id, documentId: DOC_A }),
    });
    expect(res.status).toBe(404);
  });

  it('records lineage edges from the source document to the batch', async () => {
    const edges = await withTenantContext(TENANT_A, async (tx) =>
      tx.select().from(dataLineageEdges).where(and(eq(dataLineageEdges.tenantId, TENANT_A), eq(dataLineageEdges.relation, 'source_of'))));
    expect(edges.length).toBeGreaterThanOrEqual(1);
    expect(edges[0].sourceKind).toBe('source_document');
    expect(edges[0].targetKind).toBe('import_batch');
  });

  it('deletes an evidence link', async () => {
    const list = await (await app.request('/api/intake/evidence-links', { headers: { Authorization: `Bearer ${TOKEN_A}` } })).json();
    const res = await app.request(`/api/intake/evidence-links/${list.links[0].id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${TOKEN_A}` } });
    expect(res.status).toBe(200);
    const after = await (await app.request('/api/intake/evidence-links', { headers: { Authorization: `Bearer ${TOKEN_A}` } })).json();
    expect(after.links.some((l: { id: string }) => l.id === list.links[0].id)).toBe(false);
  });

  it('exposes tenant-scoped metrics', async () => {
    const res = await app.request('/api/intake/metrics', { headers: { Authorization: `Bearer ${TOKEN_A}` } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.batches.committed).toBeGreaterThanOrEqual(1);
    expect(body.batches.failed).toBeGreaterThanOrEqual(2);
    expect(body.batches.pendingReview).toBeGreaterThanOrEqual(0);
    expect(body.suggestions.accepted).toBeGreaterThanOrEqual(2);
    expect(body.suggestions.overridden).toBe(1);
    expect(body.suggestions.acceptanceRate).toBeGreaterThan(0);
  });

  it('governed adjustments: requires a real provision run when referenced', async () => {
    const missing = await app.request('/api/intake/adjustments', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN_A}` },
      body: JSON.stringify({ provisionRunId: crypto.randomUUID(), adjustmentType: 'permanent', amount: '123.45', reason: 'test' }),
    });
    expect(missing.status).toBe(404);
  });

  it('creates and lists adjustments', async () => {
    const res = await app.request('/api/intake/adjustments', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN_A}` },
      body: JSON.stringify({ adjustmentType: 'temporary', amount: '999.99', reason: 'test adjustment', description: 'manual', effectivePeriod: '2026-03-31' }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.adjustment.amount).toBe('999.99');

    const list = await (await app.request('/api/intake/adjustments', { headers: { Authorization: `Bearer ${TOKEN_A}` } })).json();
    expect(list.adjustments.some((a: { amount: string }) => a.amount === '999.99')).toBe(true);

    const bList = await (await app.request('/api/intake/adjustments', { headers: { Authorization: `Bearer ${TOKEN_B}` } })).json();
    expect(bList.adjustments).toHaveLength(0);
  });

  it('keeps tenant A lineage invisible to tenant B', async () => {
    const res = await app.request(`/api/intake/lineage/account/${committedAccountId}`, { headers: { Authorization: `Bearer ${TOKEN_B}` } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.nodes).toHaveLength(0);
  });
});
