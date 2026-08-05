// ─────────────────────────────────────────────────────────────────────────────
// Phase 1G — Automated Journal Entry Workpapers Export.
//
//   • pure: UK FRS 102 S29 posting construction from engine journal entries
//     and from result columns (legacy fallback), balance invariants,
//     ERP CSV formats (Xero / QBO / NetSuite / generic),
//   • live-DB: /api/export/journals/:resultId JSON + CSV round trip and
//     cross-tenant fail-closed.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Hono } from 'hono';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { and, eq } from 'drizzle-orm';
import { withTenantContext } from '../config/db.js';
import { env } from '../config/env.js';
import { errorHandler } from '../lib/middleware/error-handler.js';
import { exportRoutes } from '../modules/export/export.routes.js';
import {
  buildJournalExport, journalsToCsv,
  type JournalExportDocument, type JournalResultInput,
} from '../modules/export/journals.js';
import { tenants } from '../db/schema/tenants.js';
import { users } from '../db/schema/users.js';
import { entities } from '../db/schema/entities.js';
import { accountingPeriods } from '../db/schema/accounting-periods.js';
import { taxPeriods } from '../db/schema/tax-periods.js';
import { ukRules } from '../db/schema/uk-rules.js';
import { provisionRuns } from '../db/schema/provision-runs.js';
import { provisionResults } from '../db/schema/provision-results.js';

const app = new Hono();
app.onError(errorHandler);
app.route('/api/export', exportRoutes);

const TENANT_A = crypto.randomUUID();
const TENANT_B = crypto.randomUUID();
const USER_A = crypto.randomUUID();
const USER_B = crypto.randomUUID();
const ENTITY_A = crypto.randomUUID();
const PERIOD_AP = crypto.randomUUID();
const PERIOD_TP = crypto.randomUUID();

function tokenFor(userId: string, tenantId: string, role = 'admin'): string {
  return jwt.sign({ userId, tenantId, email: `journals-${tenantId.slice(0, 8)}@test.local`, role }, env.JWT_SECRET, { expiresIn: '1h' });
}
const TOKEN_A = tokenFor(USER_A, TENANT_A);
const TOKEN_B = tokenFor(USER_B, TENANT_B);

// ── Pure helpers ─────────────────────────────────────────────────────────────

function resultInput(overrides: Partial<JournalResultInput> = {}): JournalResultInput {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    provisionRunId: '22222222-2222-2222-2222-222222222222',
    period: '2026-03-31',
    status: 'calculated',
    currentTaxExpense: '25000',
    deferredTaxExpense: '5000',
    totalTaxExpense: '30000',
    bookIncome: '100000',
    taxPayable: '25000',
    detail: {},
    createdAt: '2026-04-01T00:00:00.000Z',
    ...overrides,
  };
}

// ── Pure: engine journal entries path ───────────────────────────────────────

describe('buildJournalExport — engine journal entries', () => {
  it('normalises engine entries with friendly account names and balanced totals', () => {
    const doc = buildJournalExport(resultInput({
      detail: {
        journalEntries: [
          {
            type: 'current_tax', entityId: ENTITY_A, period: '2026-03-31',
            lines: [
              { accountId: 'tax-expense-current', debit: '25000', credit: '0', memo: 'Current tax expense for 2026-03-31' },
              { accountId: 'tax-payable', debit: '0', credit: '25000', memo: 'Current tax payable for 2026-03-31' },
            ],
            totalDebit: '25000', totalCredit: '25000',
          },
          {
            type: 'deferred_tax', entityId: ENTITY_A, period: '2026-03-31',
            lines: [
              { accountId: 'tax-expense-deferred', debit: '5000', credit: '0', memo: 'Deferred tax expense for 2026-03-31' },
              { accountId: 'deferred-tax-liability', debit: '0', credit: '5000', memo: 'Increase in DTL for 2026-03-31' },
            ],
            totalDebit: '5000', totalCredit: '5000',
          },
        ],
      },
    }), { id: '22222222-2222-2222-2222-222222222222', period: '2026-03-31', endPeriod: null, entityId: ENTITY_A, status: 'calculated', engineVersion: 'tax-engine-0.1.0' });

    expect(doc.source).toBe('engine_journal_entries');
    expect(doc.entries).toHaveLength(2);
    expect(doc.entries[0]).toMatchObject({
      type: 'current_tax',
      totalDebit: 25000,
      totalCredit: 25000,
    });
    expect(doc.entries[0].lines[0]).toMatchObject({ accountId: 'tax-expense-current', accountName: 'Current tax expense', debit: 25000, credit: 0 });
    expect(doc.entries[1].lines[1]).toMatchObject({ accountId: 'deferred-tax-liability', accountName: 'Deferred tax liability', credit: 5000 });
    expect(doc.controls).toMatchObject({ totalDebit: 30000, totalCredit: 30000, balanced: true });
  });

  it('includes valuation allowance entries when persisted', () => {
    const doc = buildJournalExport(resultInput({
      detail: {
        journalEntries: [
          {
            type: 'deferred_tax', entityId: ENTITY_A, period: '2026-03-31',
            lines: [
              { accountId: 'tax-expense-deferred', debit: '1000', credit: '0', memo: 'Valuation allowance increase for 2026-03-31' },
              { accountId: 'valuation-allowance', debit: '0', credit: '1000', memo: 'Valuation allowance for 2026-03-31' },
            ],
            totalDebit: '1000', totalCredit: '1000',
          },
        ],
      },
    }), null);

    expect(doc.entries).toHaveLength(1);
    expect(doc.entries[0].type).toBe('deferred_tax');
    expect(doc.entries[0].lines[1].accountId).toBe('valuation-allowance');
    expect(doc.controls.balanced).toBe(true);
  });
});

// ── Pure: derived fallback (legacy results without engine entries) ──────────

describe('buildJournalExport — derived from result columns (UK FRS 102 S29)', () => {
  it('posts current tax expense Dr / corporation tax payable Cr', () => {
    const doc = buildJournalExport(resultInput({ currentTaxExpense: '25000', detail: {} }), null);
    expect(doc.source).toBe('derived_from_result_columns');
    const entry = doc.entries.find((e) => e.type === 'current_tax');
    expect(entry).toBeDefined();
    expect(entry!.lines).toEqual(expect.arrayContaining([
      expect.objectContaining({ accountId: 'tax-expense-current', debit: 25000, credit: 0 }),
      expect.objectContaining({ accountId: 'tax-payable', debit: 0, credit: 25000 }),
    ]));
    expect(entry!.totalDebit).toBe(entry!.totalCredit);
  });

  it('posts a deferred tax benefit as Dr deferred tax asset / Cr deferred tax expense', () => {
    const doc = buildJournalExport(resultInput({ deferredTaxExpense: '-5000', detail: {} }), null);
    const entry = doc.entries.find((e) => e.type === 'deferred_tax');
    expect(entry).toBeDefined();
    expect(entry!.lines).toEqual(expect.arrayContaining([
      expect.objectContaining({ accountId: 'deferred-tax-asset', debit: 5000, credit: 0 }),
      expect.objectContaining({ accountId: 'tax-expense-deferred', debit: 0, credit: 5000 }),
    ]));
  });

  it('produces no entries for a zero-position result and still balances', () => {
    const doc = buildJournalExport(resultInput({ currentTaxExpense: '0', deferredTaxExpense: '0', detail: {} }), null);
    expect(doc.entries).toHaveLength(0);
    expect(doc.controls).toMatchObject({ totalDebit: 0, totalCredit: 0, balanced: true });
  });

  it('rounds to 2dp so exported amounts match the stored numeric(18,2)', () => {
    const doc = buildJournalExport(resultInput({ currentTaxExpense: '25000.005', detail: {} }), null);
    const entry = doc.entries[0];
    expect(entry.totalDebit).toBe(25000.01);
    expect(entry.totalCredit).toBe(25000.01);
  });

  it('rejects malformed engine entries and falls back to derived postings', () => {
    const doc = buildJournalExport(resultInput({ detail: { journalEntries: [{ type: 'current_tax', lines: 'nope' }] } }), null);
    expect(doc.source).toBe('derived_from_result_columns');
    expect(doc.entries.some((e) => e.type === 'current_tax')).toBe(true);
  });
});

// ── Pure: ERP CSV formats ───────────────────────────────────────────────────

describe('journalsToCsv — ERP import formats', () => {
  const doc: JournalExportDocument = {
    runId: '22222222-2222-2222-2222-222222222222',
    resultId: '11111111-1111-1111-1111-111111111111',
    period: '2026-03-31',
    entityId: ENTITY_A,
    generatedAt: '2026-04-01T00:00:00.000Z',
    engineVersion: 'tax-engine-0.1.0',
    status: 'calculated',
    source: 'engine_journal_entries',
    entries: [
      {
        type: 'current_tax', period: '2026-03-31', memo: 'UK FRS 102 S29 current tax posting',
        lines: [
          { accountId: 'tax-expense-current', accountName: 'Current tax expense', memo: 'Current tax expense for 2026-03-31', debit: 25000, credit: 0 },
          { accountId: 'tax-payable', accountName: 'Corporation tax payable', memo: 'Current tax payable for 2026-03-31', debit: 0, credit: 25000 },
        ],
        totalDebit: 25000, totalCredit: 25000,
      },
    ],
    controls: { totalDebit: 25000, totalCredit: 25000, balanced: true },
  };

  it('xero: JournalNumber/Date/AccountCode/Memo/Amount with sign convention (debits +, credits −)', () => {
    const csv = journalsToCsv(doc, 'xero');
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe('JournalNumber,Date,AccountCode,AccountName,Memo,Amount');
    expect(lines[1]).toBe('JE-001,2026-03-31,tax-expense-current,Current tax expense,Current tax expense for 2026-03-31,25000');
    expect(lines[2]).toBe('JE-001,2026-03-31,tax-payable,Corporation tax payable,Current tax payable for 2026-03-31,-25000');
  });

  it('qbo: Date/AccountName/Memo/Debit/Credit', () => {
    const csv = journalsToCsv(doc, 'qbo');
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe('Date,AccountName,Memo,Debit,Credit');
    expect(lines[1]).toBe('2026-03-31,Current tax expense,Current tax expense for 2026-03-31,25000,0');
    expect(lines[2]).toBe('2026-03-31,Corporation tax payable,Current tax payable for 2026-03-31,0,25000');
  });

  it('netsuite: account/debit/credit/memo', () => {
    const csv = journalsToCsv(doc, 'netsuite');
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe('account,debit,credit,memo');
    expect(lines[1]).toBe('tax-expense-current,25000,0,Current tax expense for 2026-03-31');
  });

  it('generic csv: Type/Date/Account/Memo/Debit/Credit', () => {
    const csv = journalsToCsv(doc, 'csv');
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe('Type,Date,Account,Memo,Debit,Credit');
    expect(lines[1]).toBe('current_tax,2026-03-31,Current tax expense,Current tax expense for 2026-03-31,25000,0');
  });

  it('escapes commas, quotes and newlines in memo fields', () => {
    const tricky: JournalExportDocument = {
      ...doc,
      entries: [{
        ...doc.entries[0],
        lines: [
          { ...doc.entries[0].lines[0], memo: 'Draft, "deferred" memo\nline' },
          { ...doc.entries[0].lines[1], memo: 'ok' },
        ],
      }],
    };
    const csv = journalsToCsv(tricky, 'qbo');
    expect(csv).toContain('"Draft, ""deferred"" memo\nline"');
  });
});

// ── Live-DB: route contract ─────────────────────────────────────────────────

let seededResultId: string;

beforeAll(async () => {
  await withTenantContext(TENANT_A, async (tx) => {
    await tx.insert(tenants).values({ id: TENANT_A, name: 'Journals A', slug: TENANT_A, taxRate: '0.25' }).onConflictDoNothing();
    await tx.insert(users).values({ id: USER_A, tenantId: TENANT_A, email: `journals-a@test.local`, passwordHash: 'x', role: 'admin' }).onConflictDoNothing();
    await tx.insert(entities).values({
      id: ENTITY_A, tenantId: TENANT_A, externalId: ENTITY_A, name: 'Journals UK Entity', type: 'Limited Company',
      currency: 'GBP', taxJurisdiction: 'UK_FRS102', isConsolidated: false,
    }).onConflictDoNothing();
    await tx.insert(accountingPeriods).values({
      id: PERIOD_AP, tenantId: TENANT_A, entityId: ENTITY_A, name: 'FY2026', startDate: '2026-01-01', endDate: '2026-12-31',
      periodType: 'annual', status: 'open',
    }).onConflictDoNothing();
    await tx.insert(taxPeriods).values({
      id: PERIOD_TP, tenantId: TENANT_A, entityId: ENTITY_A, accountingPeriodId: PERIOD_AP,
      startDate: '2026-01-01', endDate: '2026-12-31', durationMonths: 12, isStandardDuration: true, status: 'open',
    }).onConflictDoNothing();
    await tx.insert(ukRules).values({
      tenantId: TENANT_A, ruleKey: 'uk.rates.v1', jurisdiction: 'UK_FRS102',
      effectiveFrom: '2026-01-01', effectiveTo: null,
      sourceUrl: 'https://www.gov.uk/rates', sourceSnapshotHash: 'abc123',
      author: 'Journals test', approvalState: 'approved', version: 1,
    }).onConflictDoNothing();
    await tx.insert(tenants).values({ id: TENANT_B, name: 'Journals B', slug: TENANT_B, taxRate: '0.25' }).onConflictDoNothing();
  });

  await withTenantContext(TENANT_B, async (tx) => {
    await tx.insert(users).values({ id: USER_B, tenantId: TENANT_B, email: `journals-b@test.local`, passwordHash: 'x', role: 'admin' }).onConflictDoNothing();
  });

  await withTenantContext(TENANT_A, async (tx) => {
    const [run] = await tx.insert(provisionRuns).values({
      tenantId: TENANT_A, requestedByUserId: USER_A, preparedByUserId: USER_A,
      period: '2026-03-31', endPeriod: '2026-03-31', entityId: ENTITY_A,
      mode: 'direct', status: 'calculated', accountingPeriodId: PERIOD_AP, taxPeriodId: PERIOD_TP,
    }).returning({ id: provisionRuns.id });
    const [result] = await tx.insert(provisionResults).values({
      tenantId: TENANT_A, provisionRunId: run!.id, period: '2026-03-31', status: 'calculated',
      currentTaxExpense: '25000', deferredTaxExpense: '5000', totalTaxExpense: '30000',
      bookIncome: '100000', taxPayable: '25000',
      detail: {
        journalEntries: [
          {
            type: 'current_tax', entityId: ENTITY_A, period: '2026-03-31',
            lines: [
              { accountId: 'tax-expense-current', debit: '25000', credit: '0', memo: 'Current tax expense for 2026-03-31' },
              { accountId: 'tax-payable', debit: '0', credit: '25000', memo: 'Current tax payable for 2026-03-31' },
            ],
            totalDebit: '25000', totalCredit: '25000',
          },
          {
            type: 'deferred_tax', entityId: ENTITY_A, period: '2026-03-31',
            lines: [
              { accountId: 'tax-expense-deferred', debit: '5000', credit: '0', memo: 'Deferred tax expense for 2026-03-31' },
              { accountId: 'deferred-tax-liability', debit: '0', credit: '5000', memo: 'Increase in DTL for 2026-03-31' },
            ],
            totalDebit: '5000', totalCredit: '5000',
          },
        ],
      },
    }).returning({ id: provisionResults.id });
    seededResultId = result!.id;
  });
});

afterAll(async () => {
  for (const tid of [TENANT_A, TENANT_B]) {
    await withTenantContext(tid, async (tx) => {
      await tx.delete(tenants).where(eq(tenants.id, tid));
    }).catch(() => {});
  }
});

describe('GET /api/export/journals/:resultId', () => {
  it('returns the JSON journal workpaper with balanced controls', async () => {
    const res = await app.request(`/api/export/journals/${seededResultId}`, {
      headers: { Authorization: `Bearer ${TOKEN_A}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = await res.json() as any;
    expect(body.resultId).toBe(seededResultId);
    expect(body.source).toBe('engine_journal_entries');
    expect(body.entries.map((e: any) => e.type)).toEqual(['current_tax', 'deferred_tax']);
    expect(body.controls.balanced).toBe(true);
    expect(body.controls.totalDebit).toBe(body.controls.totalCredit);
  });

  it('returns Xero-format CSV with a content-disposition filename', async () => {
    const res = await app.request(`/api/export/journals/${seededResultId}?format=xero`, {
      headers: { Authorization: `Bearer ${TOKEN_A}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/csv');
    expect(res.headers.get('content-disposition')).toContain('taxpro-journals-20260331-xero.csv');
    const csv = await res.text();
    expect(csv.split('\r\n')[0]).toBe('JournalNumber,Date,AccountCode,AccountName,Memo,Amount');
    expect(csv).toContain(',-25000');
  });

  it('returns QBO-format CSV on request', async () => {
    const res = await app.request(`/api/export/journals/${seededResultId}?format=qbo`, {
      headers: { Authorization: `Bearer ${TOKEN_A}` },
    });
    expect(res.status).toBe(200);
    const csv = await res.text();
    expect(csv.split('\r\n')[0]).toBe('Date,AccountName,Memo,Debit,Credit');
  });

  it('fails closed cross-tenant: 404, no leakage', async () => {
    const res = await app.request(`/api/export/journals/${seededResultId}`, {
      headers: { Authorization: `Bearer ${TOKEN_B}` },
    });
    expect(res.status).toBe(404);
    const body = await res.json().catch(() => null);
    expect(body?.error).toBeDefined();
  });

  it('404 for an unknown result id', async () => {
    const res = await app.request(`/api/export/journals/${crypto.randomUUID()}`, {
      headers: { Authorization: `Bearer ${TOKEN_A}` },
    });
    expect(res.status).toBe(404);
  });
});
