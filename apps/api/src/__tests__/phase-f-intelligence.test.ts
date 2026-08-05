// ─────────────────────────────────────────────────────────────────────────────
// Phase F — Tax Intelligence Layer.
// Covers the foundational infrastructure (no new tax features):
//  • evidence persistence: intake bytes → storage → source_documents,
//  • agent_events outbox (platform / intake_agent / learning_system),
//  • knowledge-graph edges at calculation time (produced / used_balance),
//  • provenance API for results and documents + the agent registry,
//  • the eve read-only guard (agents can never mutate business tables),
//  • the governed adjustment review loop (learning signals).
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Hono } from 'hono';
import jwt from 'jsonwebtoken';
import { and, eq, or } from 'drizzle-orm';
import crypto from 'crypto';
import { withTenantContext, db } from '../config/db.js';
import { env } from '../config/env.js';
import { errorHandler } from '../lib/middleware/error-handler.js';
import { intakeRoutes } from '../modules/intake/intake.routes.js';
import { provenanceRoutes } from '../modules/intelligence/provenance.routes.js';
import { workbenchRoutes } from '../modules/workbench/workbench.routes.js';
import { getStorage } from '../lib/storage/index.js';
import { runReadOnly } from '../eve/agent.js';
import { tenants } from '../db/schema/tenants.js';
import { users } from '../db/schema/users.js';
import { entities } from '../db/schema/entities.js';
import { accountingPeriods } from '../db/schema/accounting-periods.js';
import { taxPeriods } from '../db/schema/tax-periods.js';
import { sourceDocuments } from '../db/schema/source-documents.js';
import { accounts } from '../db/schema/accounts.js';
import { trialBalance } from '../db/schema/trial-balance.js';
import { taxMappings } from '../db/schema/tax-mappings.js';
import { ukRules } from '../db/schema/uk-rules.js';
import { importBatches } from '../db/schema/import-batches.js';
import { evidenceLinks } from '../db/schema/evidence-links.js';
import { mappingSuggestions } from '../db/schema/tax-memory.js';
import { reviewerFeedbackEvents } from '../db/schema/feedback.js';
import { taxAdjustments } from '../db/schema/tax-adjustments.js';
import { dataLineageEdges } from '../db/schema/lineage.js';
import { agentEvents } from '../db/schema/agent-events.js';
import { provisionResults } from '../db/schema/provision-results.js';

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

const TENANT_A = crypto.randomUUID();
const TENANT_B = crypto.randomUUID();
const USER_A = crypto.randomUUID();
const USER_B = crypto.randomUUID();
const ENTITY_A = crypto.randomUUID();
const ENTITY_B = crypto.randomUUID();
const PERIOD_AP = crypto.randomUUID();
const PERIOD_AP_B = crypto.randomUUID();
const PERIOD_TP = crypto.randomUUID();
const PERIOD_TP_B = crypto.randomUUID();

const app = new Hono();
app.onError(errorHandler);
app.route('/api/intake', intakeRoutes);
app.route('/api/provenance', provenanceRoutes);
app.route('/api/workbench', workbenchRoutes);

function tokenFor(userId: string, tenantId: string, role = 'admin'): string {
  return jwt.sign({ userId, tenantId, email: `phase-f-${tenantId.slice(0, 8)}@test.local`, role }, env.JWT_SECRET, { expiresIn: '1h' });
}
const TOKEN_A = tokenFor(USER_A, TENANT_A);
const TOKEN_B = tokenFor(USER_B, TENANT_B);

const HEADERS = 'entityName,entityExternalId,accountName,accountNumber,accountExternalId,accountType,detailType,period,periodEnd,debit,credit,balance,currency';

const CSV = [
  HEADERS,
  'Acme UK Ltd,acme-uk,Software Subscriptions,REV-100,REV-100,Income,OtherIncome,2026-03-31,2026-03-31,10000,,,GBP',
  'Acme UK Ltd,acme-uk,Office Rent,EXP-200,EXP-200,Expense,OperatingExpense,2026-03-31,2026-03-31,,4000,,GBP',
  'Acme UK Ltd,acme-uk,Audit Fees,EXP-300,EXP-300,Expense,OperatingExpense,2026-03-31,2026-03-31,,6000,,GBP',
].join('\n');

const CSV_B = [
  HEADERS,
  'Beta Ltd,beta-ltd,Sales,B-REV-1,B-REV-1,Income,OtherIncome,2026-03-31,2026-03-31,2000,,,GBP',
].join('\n');

async function uploadCsv(token: string, csv: string, entityId: string, apId: string, extra: Record<string, string> = {}) {
  const form = new FormData();
  form.append('entityId', entityId);
  form.append('accountingPeriodId', apId);
  for (const [k, v] of Object.entries(extra)) form.append(k, v);
  form.append('file', new File([csv], 'tb-fy2026.csv', { type: 'text/csv' }));
  return app.request('/api/intake/batches', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
}

async function suggestAndAcceptAll(token: string, batchId: string) {
  await app.request(`/api/intake/batches/${batchId}/suggestions/generate`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}` },
  });
  const list = await (await app.request(`/api/intake/batches/${batchId}/suggestions`, { headers: { Authorization: `Bearer ${token}` } })).json();
  for (const s of list.suggestions) {
    await app.request(`/api/intake/suggestions/${s.id}/decide`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ decision: 'accept' }),
    });
  }
}

async function eventTypesFor(tx: Parameters<Parameters<typeof db.transaction>[0]>[0], tenantId: string, correlationId: string): Promise<string[]> {
  const rows = await tx.select({ eventType: agentEvents.eventType, sourceAgent: agentEvents.sourceAgent })
    .from(agentEvents)
    .where(and(eq(agentEvents.tenantId, tenantId), eq(agentEvents.correlationId, correlationId)))
    .orderBy(agentEvents.occurredAt);
  return rows.map((r) => `${r.sourceAgent}:${r.eventType}`);
}

let batchAId: string;
let docAId: string;
let storageKey: string;
let runAId: string;
let resultAId: string;
let tempAccountId: string;
let committedEntityId: string;

beforeAll(async () => {
  for (const [tid, uid, eid, apId, tpId] of [
    [TENANT_A, USER_A, ENTITY_A, PERIOD_AP, PERIOD_TP],
    [TENANT_B, USER_B, ENTITY_B, PERIOD_AP_B, PERIOD_TP_B],
  ] as const) {
    await withTenantContext(tid, async (tx) => {
      await tx.insert(tenants).values({ id: tid, name: `Phase F ${tid.slice(0, 8)}`, slug: tid, taxRate: '0.25' }).onConflictDoNothing();
      await tx.insert(users).values({ id: uid, tenantId: tid, email: `phase-f-${tid.slice(0, 8)}@test.local`, passwordHash: 'x', role: 'admin' }).onConflictDoNothing();
      await tx.insert(entities).values({
        id: eid, tenantId: tid, externalId: eid, name: 'Phase F UK Entity', type: 'Limited Company',
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
      await tx.insert(ukRules).values({
        tenantId: tid, ruleKey: 'uk.rates.v1', jurisdiction: 'UK_FRS102',
        effectiveFrom: '2026-01-01', effectiveTo: null,
        sourceUrl: 'https://www.gov.uk/rates', sourceSnapshotHash: 'abc123',
        author: 'Phase F test', approvalState: 'approved', version: 1,
      }).onConflictDoNothing();
    });
  }
});

afterAll(async () => {
  for (const tid of [TENANT_A, TENANT_B]) {
    await withTenantContext(tid, async (tx) => {
      await tx.delete(tenants).where(eq(tenants.id, tid));
    }).catch(() => {});
  }
});

describe('Phase F — evidence persistence', () => {
  it('persists intake bytes: source_documents row, batch link, storage roundtrip, dedupe', async () => {
    const res = await uploadCsv(TOKEN_A, CSV, ENTITY_A, PERIOD_AP);
    expect(res.status).toBe(201);
    const data = await res.json() as any;
    batchAId = data.batch.id;

    await withTenantContext(TENANT_A, async (tx) => {
      const [batch] = await tx.select().from(importBatches).where(eq(importBatches.id, batchAId)).limit(1);
      expect(batch?.storageKey).toBeTruthy();
      expect(batch?.parserVersion).toBe('intake-csv-v1');
      expect(batch?.sourceDocumentId).toBeTruthy();

      const [doc] = await tx.select().from(sourceDocuments).where(eq(sourceDocuments.id, batch?.sourceDocumentId ?? '')).limit(1);
      expect(doc?.documentType).toBe('intake_batch');
      expect(doc?.sourceSystem).toBe('manual-upload');
      expect(doc?.parserVersion).toBe('intake-csv-v1');
      expect(doc?.sha256).toBe(batch?.checksum);
      expect(doc?.sizeBytes).toBe(Buffer.byteLength(CSV));
      expect(doc?.storageKey).toMatch(new RegExp(`^${TENANT_A}/intake_batch/`));

      const bytes = await getStorage().get(doc!.storageKey);
      expect(bytes.toString('utf8')).toBe(CSV);

      docAId = doc!.id;
      storageKey = doc!.storageKey;

      const events = await eventTypesFor(tx, TENANT_A, batchAId);
      expect(events).toContain('platform:intake.batch_uploaded');
    });

    const dup = await uploadCsv(TOKEN_A, CSV, ENTITY_A, PERIOD_AP);
    expect(dup.status).toBe(200);
    const dupData = await dup.json() as any;
    expect(dupData.duplicate).toBe(true);

    await withTenantContext(TENANT_A, async (tx) => {
      const docs = await tx.select().from(sourceDocuments).where(eq(sourceDocuments.storageKey, storageKey));
      expect(docs.length).toBe(1);
    });
  });

  it('runs the intake lifecycle and emits intake_agent events', async () => {
    await suggestAndAcceptAll(TOKEN_A, batchAId);

    const commit = await app.request(`/api/intake/batches/${batchAId}/commit`, {
      method: 'POST', headers: { Authorization: `Bearer ${TOKEN_A}` },
    });
    expect(commit.status).toBe(200);
    const commitData = await commit.json() as any;
    expect(commitData.committedRows).toBe(3);

    await withTenantContext(TENANT_A, async (tx) => {
      const events = await eventTypesFor(tx, TENANT_A, batchAId);
      expect(events).toContain('intake_agent:intake.suggestions_generated');
      expect(events).toContain('intake_agent:intake.batch_committed');

      const edges = await tx.select().from(dataLineageEdges).where(and(
        eq(dataLineageEdges.tenantId, TENANT_A), eq(dataLineageEdges.sourceKind, 'import_batch'), eq(dataLineageEdges.sourceId, batchAId),
      ));
      expect(edges.length).toBe(3);
      expect(edges.every((e) => e.relation === 'contains' && e.targetKind === 'import_batch_row')).toBe(true);

      const link = await tx.select().from(evidenceLinks).where(and(
        eq(evidenceLinks.tenantId, TENANT_A), eq(evidenceLinks.subjectKind, 'import_batch'), eq(evidenceLinks.subjectId, batchAId),
      ));
      expect(link.length).toBe(1);
      expect(link[0]?.evidenceRole).toBe('source');
      expect(link[0]?.documentId).toBe(docAId);

      const [tempAccount] = await tx.select({ id: accounts.id }).from(accounts)
        .where(and(eq(accounts.tenantId, TENANT_A), eq(accounts.externalId, 'REV-100'))).limit(1);
      tempAccountId = tempAccount?.id ?? crypto.randomUUID();

      // The intake commit materialises its own entity (externalId 'acme-uk');
      // the workbench calculation must run against THAT entity so the
      // trial-balance rows and the run share the same entity id.
      const [committedEntity] = await tx.select({ id: entities.id }).from(entities)
        .where(and(eq(entities.tenantId, TENANT_A), eq(entities.externalId, 'acme-uk'))).limit(1);
      committedEntityId = committedEntity?.id ?? ENTITY_A;

      await tx.insert(taxMappings).values({
        tenantId: TENANT_A, accountId: tempAccountId, taxAccountType: 'UK_TEMP', bookTreatment: 'temporary',
        timingCategory: 'deductible_temporary', isActive: true, status: 'active', version: 1, suggestedByAi: false,
      }).onConflictDoNothing();
    });
  });
});

describe('Phase F — knowledge graph at calculation time + provenance API', () => {
  it('records produced / used_balance edges when a result is calculated', async () => {
    const res = await app.request('/api/workbench/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN_A}` },
      body: JSON.stringify({
        idempotencyKey: `phase-f-run-${crypto.randomUUID()}`,
        entityId: committedEntityId, accountingPeriodId: PERIOD_AP, taxPeriodId: PERIOD_TP, sourceDocumentId: docAId,
      }),
    });
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    runAId = data.result.runId;
    resultAId = data.result.resultId;
    expect(runAId).toBeTruthy();
    expect(resultAId).toBeTruthy();

    await withTenantContext(TENANT_A, async (tx) => {
      const edges = await tx.select().from(dataLineageEdges).where(and(
        eq(dataLineageEdges.tenantId, TENANT_A),
        or(
          and(eq(dataLineageEdges.sourceKind, 'provision_result'), eq(dataLineageEdges.sourceId, resultAId)),
          and(eq(dataLineageEdges.targetKind, 'provision_result'), eq(dataLineageEdges.targetId, resultAId)),
        ),
      ));
      const relations = edges.map((e) => e.relation);
      expect(relations).toContain('produced');
      expect(relations).toContain('used_balance');
      const used = edges.find((e) => e.relation === 'used_balance');
      expect(used?.targetId).toBe(tempAccountId);
      expect(used?.targetKind).toBe('account');

      const [result] = await tx.select({ id: provisionResults.id }).from(provisionResults).where(eq(provisionResults.id, resultAId));
      expect(result?.id).toBe(resultAId);
    });
  });

  it('provenance: result story ties run, balances, batch, documents and events together', async () => {
    const res = await app.request(`/api/provenance/results/${resultAId}`, { headers: { Authorization: `Bearer ${TOKEN_A}` } });
    expect(res.status).toBe(200);
    const { provenance } = await res.json() as any;

    expect(provenance.producedBy).toEqual({ kind: 'provision_run', id: runAId, relation: 'produced' });
    expect(provenance.calculatedFrom.some((a: any) => a.id === tempAccountId)).toBe(true);
    expect(provenance.batches.some((b: any) => b.id === batchAId)).toBe(true);
    expect(provenance.batches.find((b: any) => b.id === batchAId)?.storageKey).toBe(storageKey);
    expect(provenance.documents.some((d: any) => d.id === docAId)).toBe(true);
    expect(provenance.run.inputDataHash).toBeTruthy();
    expect(provenance.run.engineVersion).toBeTruthy();
    expect(Array.isArray(provenance.adjustments)).toBe(true);
    expect(Array.isArray(provenance.agentEvents)).toBe(true);
    expect(provenance.edges.some((e: any) => e.relation === 'produced')).toBe(true);
  });

  it('provenance: document story links batch (source role), runs and lineage', async () => {
    const res = await app.request(`/api/provenance/documents/${docAId}`, { headers: { Authorization: `Bearer ${TOKEN_A}` } });
    expect(res.status).toBe(200);
    const { provenance } = await res.json() as any;

    expect(provenance.document.id).toBe(docAId);
    expect(provenance.document.parserVersion).toBe('intake-csv-v1');
    expect(provenance.linkedAs.some((l: any) => l.subjectKind === 'import_batch' && l.subjectId === batchAId && l.evidenceRole === 'source')).toBe(true);
    expect(provenance.batches.some((b: any) => b.id === batchAId)).toBe(true);
    expect(provenance.runs.some((r: any) => r.id === runAId)).toBe(true);
    expect(provenance.lineage.some((e: any) => e.relation === 'source_of' && e.targetKind === 'import_batch')).toBe(true);
  });

  it('provenance: the agent registry exposes the platform roster', async () => {
    const res = await app.request('/api/provenance/agents', { headers: { Authorization: `Bearer ${TOKEN_A}` } });
    expect(res.status).toBe(200);
    const { agents } = await res.json() as any;
    const names = agents.map((a: any) => a.name);
    for (const expected of ['platform', 'intake_agent', 'mapping_agent', 'audit_defense_agent', 'credit_miner', 'learning_system']) {
      expect(names).toContain(expected);
    }
    const intakeAgent = agents.find((a: any) => a.name === 'intake_agent');
    expect(intakeAgent.emits).toContain('intake.batch_committed');
    const learning = agents.find((a: any) => a.name === 'learning_system');
    expect(learning.emits).toContain('learning.adjustment_approved');
  });

  it('provenance: cross-tenant access fails closed with 404', async () => {
    const res = await app.request(`/api/provenance/results/${resultAId}`, { headers: { Authorization: `Bearer ${TOKEN_B}` } });
    expect(res.status).toBe(404);
  });
});

describe('Phase F — eve read-only guard', () => {
  it('allows reads but rejects any write inside the agent sandbox', async () => {
    const read = await runReadOnly(db, async (roTx) => {
      return roTx.select({ id: tenants.id }).from(tenants);
    });
    expect(Array.isArray(read)).toBe(true);

    await expect(runReadOnly(db, async (roTx) => {
      await roTx.insert(importBatches).values({
        tenantId: TENANT_A, entityId: ENTITY_A, accountingPeriodId: PERIOD_AP,
        sourceType: 'csv', sourceSystem: 'sandbox', originalFilename: 'x.csv', checksum: 'x',
        rowCount: 0, status: 'validating', createdByUserId: USER_A,
      });
    })).rejects.toThrow();
  });
});

describe('Phase F — learning system (governed adjustment review)', () => {
  let approvedId: string;
  let rejectedId: string;

  it('approve: status transition, feedback signal and agent event', async () => {
    const create = await app.request('/api/intake/adjustments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN_A}` },
      body: JSON.stringify({
        provisionRunId: runAId, accountId: tempAccountId, adjustmentType: 'temporary',
        amount: '500.00', reason: 'Timing difference on deferred accrual', description: 'Phase F test adjustment',
      }),
    });
    expect(create.status).toBe(201);
    approvedId = (await create.json() as any).adjustment.id;

    const approve = await app.request(`/api/intake/adjustments/${approvedId}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN_A}` },
      body: JSON.stringify({ reason: 'Reviewer agrees with the accrual treatment' }),
    });
    expect(approve.status).toBe(200);
    const { adjustment } = await approve.json() as any;
    expect(adjustment.status).toBe('approved');
    expect(adjustment.decidedByUserId).toBe(USER_A);
    expect(adjustment.decisionReason).toBe('Reviewer agrees with the accrual treatment');

    await withTenantContext(TENANT_A, async (tx) => {
      const feedback = await tx.select().from(reviewerFeedbackEvents).where(and(
        eq(reviewerFeedbackEvents.tenantId, TENANT_A),
        eq(reviewerFeedbackEvents.subjectKind, 'tax_adjustment'),
        eq(reviewerFeedbackEvents.subjectId, approvedId),
      ));
      expect(feedback.length).toBe(1);
      expect(feedback[0]?.feedbackType).toBe('accepted');

      const events = await tx.select().from(agentEvents).where(and(
        eq(agentEvents.tenantId, TENANT_A),
        eq(agentEvents.eventType, 'learning.adjustment_approved'),
        eq(agentEvents.sourceAgent, 'learning_system'),
        eq(agentEvents.correlationId, runAId),
      ));
      expect(events.length).toBe(1);
    });

    const twice = await app.request(`/api/intake/adjustments/${approvedId}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN_A}` },
      body: JSON.stringify({}),
    });
    expect(twice.status).toBe(409);
  });

  it('reject: emits the rejection learning signal', async () => {
    const create = await app.request('/api/intake/adjustments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN_A}` },
      body: JSON.stringify({
        provisionRunId: runAId, accountId: tempAccountId, adjustmentType: 'permanent',
        amount: '-100.00', reason: 'Non-deductible expense adjustment',
      }),
    });
    expect(create.status).toBe(201);
    rejectedId = (await create.json() as any).adjustment.id;

    const reject = await app.request(`/api/intake/adjustments/${rejectedId}/reject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN_A}` },
      body: JSON.stringify({ reason: 'Expense is deductible in full' }),
    });
    expect(reject.status).toBe(200);
    expect(((await reject.json()) as any).adjustment.status).toBe('rejected');

    await withTenantContext(TENANT_A, async (tx) => {
      const events = await tx.select().from(agentEvents).where(and(
        eq(agentEvents.tenantId, TENANT_A),
        eq(agentEvents.eventType, 'learning.adjustment_rejected'),
        eq(agentEvents.correlationId, runAId),
      ));
      expect(events.length).toBe(1);
    });
  });

  it('provenance for the run surfaces the reviewed adjustments', async () => {
    const res = await app.request(`/api/provenance/results/${resultAId}`, { headers: { Authorization: `Bearer ${TOKEN_A}` } });
    const { provenance } = await res.json() as any;
    expect(provenance.adjustments.some((a: any) => a.id === approvedId && a.status === 'approved')).toBe(true);
    expect(provenance.adjustments.some((a: any) => a.id === rejectedId && a.status === 'rejected')).toBe(true);
  });
});
