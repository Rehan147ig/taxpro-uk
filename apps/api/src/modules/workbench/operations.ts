// ─────────────────────────────────────────────────────────────────────────────
// Phase C — Workbench operations: trial balance import and calculation.
//
// Every operation is deterministic, tenant-scoped and recorded in the
// workbench job ledger. Handlers receive the transactional client so they can
// be executed inline (development/tests) or from a BullMQ worker (async mode).
// ─────────────────────────────────────────────────────────────────────────────

import crypto from 'crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { BadRequestError } from '../../lib/errors.js';
import { tenants } from '../../db/schema/tenants.js';
import { entities } from '../../db/schema/entities.js';
import { accountingPeriods } from '../../db/schema/accounting-periods.js';
import { taxPeriods } from '../../db/schema/tax-periods.js';
import { sourceDocuments } from '../../db/schema/source-documents.js';
import { accounts } from '../../db/schema/accounts.js';
import { trialBalance } from '../../db/schema/trial-balance.js';
import { taxMappings } from '../../db/schema/tax-mappings.js';
import { provisionRuns } from '../../db/schema/provision-runs.js';
import { provisionResults } from '../../db/schema/provision-results.js';
import { reviewItems } from '../../db/schema/review-items.js';
import { mappingProposals } from '../../db/schema/mapping-proposals.js';
import { stableHash } from '../../eve/hash.js';
import { recordProvisionEvent, EVENT_TYPES } from '../provision/provision-events.js';
import { resolveRulesUsed } from '../rules/rules.routes.js';
import {
  buildMappingSnapshot,
  buildWorkbenchCalculationInput,
  hashWorkbenchInput,
  loadWorkbenchData,
  runWorkbenchCalculation,
  LOW_CONFIDENCE_THRESHOLD,
} from './calculator.js';
import { evaluateRunGates, type RunGateContext } from './gates.js';
import { hasOpenNonStandardPeriodItem } from './guard.js';
import { recordLineageEdges } from '../../lib/lineage/edges.js';

export const MAX_IMPORT_ROWS = 5000;

export interface ImportRowInput {
  externalId: string;
  name: string;
  type: string;
  detailType?: string;
  balance: number;
  placedInServiceDate?: string | null;
}

export interface WorkbenchCalculationPayload {
  entityId: string;
  accountingPeriodId: string;
  taxPeriodId: string;
  sourceDocumentId: string;
  parentRunId?: string;
}

// ── Shared context loader ──────────────────────────────────────────────────

export async function loadWorkbenchContext(tx: any, args: {
  tenantId: string;
  entityId: string;
  accountingPeriodId: string;
  taxPeriodId: string;
  sourceDocumentId: string;
}) {
  const [tenant] = await tx.select().from(tenants).where(eq(tenants.id, args.tenantId)).limit(1);
  if (!tenant) throw new BadRequestError('Tenant not found');

  const [entity] = await tx.select().from(entities)
    .where(and(eq(entities.tenantId, args.tenantId), eq(entities.id, args.entityId))).limit(1);
  if (!entity) throw new BadRequestError('Entity not found in this tenant');

  const [accountingPeriod] = await tx.select().from(accountingPeriods)
    .where(and(eq(accountingPeriods.tenantId, args.tenantId), eq(accountingPeriods.id, args.accountingPeriodId))).limit(1);
  if (!accountingPeriod) throw new BadRequestError('Accounting period not found in this tenant');

  const [taxPeriod] = await tx.select().from(taxPeriods)
    .where(and(eq(taxPeriods.tenantId, args.tenantId), eq(taxPeriods.id, args.taxPeriodId))).limit(1);
  if (!taxPeriod) throw new BadRequestError('Tax period not found in this tenant');

  const [document] = await tx.select().from(sourceDocuments)
    .where(and(eq(sourceDocuments.tenantId, args.tenantId), eq(sourceDocuments.id, args.sourceDocumentId))).limit(1);
  if (!document) throw new BadRequestError('Source document not found in this tenant');

  return { tenant, entity, accountingPeriod, taxPeriod, document };
}

// ── Trial balance import ───────────────────────────────────────────────────

export async function runTrialBalanceImport(tx: any, payload: {
  tenantId: string;
  userId: string;
  entityId: string;
  accountingPeriodId: string;
  taxPeriodId: string;
  sourceDocumentId: string;
  rows: ImportRowInput[];
  correlationId: string;
}): Promise<Record<string, unknown>> {
  if (!Array.isArray(payload.rows) || payload.rows.length === 0) {
    throw new BadRequestError('Trial balance import requires at least one row');
  }
  if (payload.rows.length > MAX_IMPORT_ROWS) {
    throw new BadRequestError(`Trial balance import exceeds the ${MAX_IMPORT_ROWS} row limit`);
  }

  const { tenant, entity, taxPeriod, document } = await loadWorkbenchContext(tx, payload);
  if (document.extractionStatus === 'failed') {
    throw new BadRequestError('Source document extraction failed; re-upload before importing');
  }
  if (entity.taxJurisdiction && !['UK_FRS102', 'UK_FRS102_S29', 'UK'].includes(entity.taxJurisdiction.trim())) {
    throw new BadRequestError(`Entity jurisdiction '${entity.taxJurisdiction}' is not a UK FRS 102 jurisdiction`);
  }

  const externalIds = payload.rows.map((r) => r.externalId);
  const existingAccounts = await tx.select().from(accounts)
    .where(and(eq(accounts.tenantId, payload.tenantId), inArray(accounts.externalId, externalIds))) as Array<typeof accounts.$inferSelect>;
  const existingByExternalId = new Map(existingAccounts.map((a) => [a.externalId, a]));

  let accountsCreated = 0;
  for (const row of payload.rows) {
    if (existingByExternalId.has(row.externalId)) continue;
    const [created] = await tx.insert(accounts).values({
      tenantId: payload.tenantId,
      externalId: row.externalId,
      accountNumber: row.externalId,
      name: row.name,
      type: row.type,
      detailType: row.detailType ?? null,
      placedInServiceDate: row.placedInServiceDate ?? null,
      isInactive: false,
    }).onConflictDoNothing().returning();
    if (created) {
      accountsCreated++;
      existingByExternalId.set(row.externalId, created);
    }
  }

  const period = taxPeriod.startDate;
  const periodEnd = taxPeriod.endDate;
  const fiscalYear = new Date(periodEnd).getFullYear();

  let rowsInserted = 0;
  for (const row of payload.rows) {
    const account = existingByExternalId.get(row.externalId);
    if (!account) continue;
    const value = Number(row.balance ?? 0);
    const [inserted] = await tx.insert(trialBalance).values({
      tenantId: payload.tenantId,
      entityId: payload.entityId,
      accountId: account.id,
      period,
      periodEnd,
      fiscalYear,
      fiscalPeriod: taxPeriod.durationMonths ?? 12,
      placedInServiceDate: row.placedInServiceDate ?? null,
      debit: value < 0 ? String(-value) : '0',
      credit: value >= 0 ? String(value) : '0',
      balance: String(value),
      source: 'workbench',
      sourceDocumentId: payload.sourceDocumentId,
    }).onConflictDoUpdate({
      target: [trialBalance.tenantId, trialBalance.entityId, trialBalance.accountId, trialBalance.period, trialBalance.source],
      set: {
        periodEnd,
        balance: String(value),
        debit: value < 0 ? String(-value) : '0',
        credit: value >= 0 ? String(value) : '0',
        sourceDocumentId: payload.sourceDocumentId,
      },
    }).returning();
    if (inserted) rowsInserted++;
  }

  if (document.extractionStatus === 'not_required' || document.extractionStatus === 'pending') {
    await tx.update(sourceDocuments).set({ extractionStatus: 'extracted' })
      .where(and(eq(sourceDocuments.id, payload.sourceDocumentId), eq(sourceDocuments.tenantId, payload.tenantId)));
  }

  // The import itself is audited through the workbench job ledger
  // (workbench_jobs row: payload, result, timestamps, tenant-scoped RLS).
  // provision_events requires a provision_run_id, which does not exist yet.

  return {
    entityId: payload.entityId,
    sourceDocumentId: payload.sourceDocumentId,
    period,
    periodEnd,
    rowsReceived: payload.rows.length,
    accountsCreated,
    rowsInserted,
    source: 'workbench',
  };
}

// ── Calculation ─────────────────────────────────────────────────────────────

export async function runWorkbenchCalculationJob(tx: any, payload: WorkbenchCalculationPayload & {
  tenantId: string;
  userId: string;
  correlationId: string;
}): Promise<Record<string, unknown>> {
  const { tenant, entity, accountingPeriod, taxPeriod, document } = await loadWorkbenchContext(tx, payload);
  if (document.extractionStatus === 'failed') {
    throw new BadRequestError('Source document extraction failed; re-upload before calculating');
  }

  const pendingProposals = await tx.select({ id: mappingProposals.id }).from(mappingProposals)
    .where(and(
      eq(mappingProposals.tenantId, payload.tenantId),
      eq(mappingProposals.entityId, payload.entityId),
      eq(mappingProposals.status, 'pending'),
    ));

  const nonStandardPeriodUnresolved = !taxPeriod.isStandardDuration
    && await hasOpenNonStandardPeriodItem(tx, payload.tenantId, payload.entityId);
  const gates: RunGateContext = {
    entityPresent: true,
    entityJurisdictionKnown: true,
    evidencePresent: true,
    evidenceExtractionFailed: false,
    pendingMappingProposalCount: pendingProposals.length,
    nonStandardPeriodUnresolved,
    approvedRuleCount: 1, // resolveRulesUsed fails closed below if no approved rules exist
  };
  const gateResult = evaluateRunGates(gates);
  if (gateResult.blocked) {
    throw new BadRequestError(gateResult.blockers.map((b) => b.message).join(' '));
  }

  const rulesUsed = await resolveRulesUsed(tx, payload.tenantId, taxPeriod.endDate);
  if (!rulesUsed || Object.keys(rulesUsed).length === 0) {
    throw new BadRequestError('No approved UK rules are registered for this tenant. Approve rule versions before calculating.');
  }

  const period = taxPeriod.startDate;
  const periodEnd = taxPeriod.endDate;
  const { tbRows, accountRows, mappings } = await loadWorkbenchData(tx, {
    tenantId: payload.tenantId,
    entityId: payload.entityId,
    period,
    periodEnd,
    sourceDocumentId: payload.sourceDocumentId,
  });

  if (tbRows.length === 0) {
    throw new BadRequestError('No trial balance rows are linked to this source document. Import the trial balance first.');
  }

  const mappingMap = new Map(mappings.map((m) => [m.accountId, m]));
  const accountMap = new Map(accountRows.map((a) => [a.id, a]));
  const mappingSnapshot = buildMappingSnapshot(mappings);

  const { inputDataHash, mappingVersionHash } = hashWorkbenchInput({
    tbRows,
    sourceSha256: document.sha256,
    mappingSnapshot,
  });

  const input = buildWorkbenchCalculationInput({
    period,
    entityId: payload.entityId,
    tbRows,
    mappingMap,
    accountMap,
    taxRate: Number(tenant.taxRate),
    stateTaxRate: Number(tenant.stateTaxRate ?? 0),
  });

  const { calculation, warnings } = runWorkbenchCalculation({
    input,
    taxJurisdiction: entity.taxJurisdiction,
  });

  const periodStraddlesFiscalYears = new Date(taxPeriod.startDate).getFullYear() !== new Date(taxPeriod.endDate).getFullYear();
  const assumptions = [
    'UK corporation tax main rate 25% applied per fiscal year (FY2023 onwards); small profits rate 19% below the small profits limit and marginal relief between the limits (CTA 2010 s.18D).',
    'Deferred tax computed under FRS 102 Section 29 with a full recovery assessment; no discounting is applied.',
    'Capital allowances are reflected through temporary differences between book and tax balances; no separate capital allowances computation is performed.',
    'R&D figures are taken from the trial balance as supported amounts; entitlement to enhanced relief requires manual review.',
    periodStraddlesFiscalYears
      ? 'This tax period straddles fiscal years; the run flags the period for review and does not automatically split the rate calculation across years.'
      : 'The tax period falls within a single fiscal year.',
  ];

  if (periodStraddlesFiscalYears) {
    warnings.push({
      code: 'fiscal_year_straddling',
      message: `Tax period ${taxPeriod.startDate} to ${taxPeriod.endDate} straddles fiscal years; the run does not auto-split rates across the boundary.`,
    });
  }

  const runId = crypto.randomUUID();
  const [run] = await tx.insert(provisionRuns).values({
    id: runId,
    tenantId: payload.tenantId,
    requestedByUserId: payload.userId,
    preparedByUserId: payload.userId,
    period,
    endPeriod: periodEnd,
    entityId: payload.entityId,
    mode: 'direct',
    status: 'calculated',
    inputDataHash,
    mappingVersionHash,
    rulesUsed,
    engineVersion: 'tax-engine-0.1.0',
    sourceDocumentId: payload.sourceDocumentId,
    accountingPeriodId: payload.accountingPeriodId,
    taxPeriodId: payload.taxPeriodId,
    parentRunId: payload.parentRunId ?? null,
    mappingSnapshot,
    assumptions,
    warnings,
    correlationId: payload.correlationId,
    idempotencyKey: null,
  }).returning();

  await recordProvisionEvent({
    tenantId: payload.tenantId,
    provisionRunId: runId,
    eventType: EVENT_TYPES.RUN_CREATED,
    actorType: 'user',
    actorUserId: payload.userId,
    reason: `Workbench calculation run created for ${entity.name} (${period} to ${periodEnd})`,
    metadata: { entityId: payload.entityId, sourceDocumentId: payload.sourceDocumentId, correlationId: payload.correlationId },
  }, tx);

  let openCount = 0;
  for (const accountId of input.unmappedAccountIds) {
    openCount++;
    const account = accountMap.get(accountId);
    await tx.insert(reviewItems).values({
      tenantId: payload.tenantId,
      provisionRunId: runId,
      itemType: 'missing_mapping',
      severity: 'high',
      title: `Missing tax mapping for ${account?.name ?? accountId}`,
      description: 'This account is included in the trial balance but has no active tax mapping. A reviewer should classify it before final delivery.',
      accountId,
      sourceRef: account?.accountNumber,
    });
  }
  for (const accountId of input.missingDepreciationMetadata) {
    openCount++;
    const account = accountMap.get(accountId);
    await tx.insert(reviewItems).values({
      tenantId: payload.tenantId,
      provisionRunId: runId,
      itemType: 'missing_depreciation_metadata',
      severity: 'medium',
      title: `Missing depreciation metadata for ${account?.name ?? accountId}`,
      description: 'No placed-in-service date or asset age is recorded for this depreciable asset. A first-year rate was assumed for the calculation; add the placed-in-service date to remove the assumption.',
      accountId,
      sourceRef: account?.accountNumber,
      confidenceScore: 30,
    });
  }
  for (const accountId of orderedAccountIdsWithLowConfidence(mappingMap, accountMap, input)) {
    openCount++;
    const mapping = mappingMap.get(accountId)!;
    const account = accountMap.get(accountId);
    await tx.insert(reviewItems).values({
      tenantId: payload.tenantId,
      provisionRunId: runId,
      itemType: 'low_confidence_mapping',
      severity: 'medium',
      title: `Review AI mapping for ${account?.name ?? accountId}`,
      description: mapping.aiExplanation ?? 'AI mapping confidence is below the review threshold.',
      accountId,
      sourceRef: account?.accountNumber,
      confidenceScore: Math.round(Number(mapping.confidenceScore ?? 0) * 100),
    });
  }
  if (periodStraddlesFiscalYears) {
    openCount++;
    await tx.insert(reviewItems).values({
      tenantId: payload.tenantId,
      provisionRunId: runId,
      itemType: 'fiscal_year_straddling',
      severity: 'medium',
      title: `Tax period straddles fiscal years (${new Date(taxPeriod.startDate).getFullYear()}-${new Date(taxPeriod.endDate).getFullYear()})`,
      description: 'The run does not auto-split the rate calculation across the fiscal-year boundary. Review the rate allocation before approval.',
    });
  }

  const detail = {
    ...calculation,
    lineItems: {
      permanentDifferences: input.permanentDifferences.map((pd) => ({ label: pd.label, amount: pd.amount })),
      temporaryDifferences: input.temporaryDifferences.map((d) => ({
        accountId: d.accountId,
        label: accountMap.get(d.accountId)?.name ?? d.accountId,
        difference: d.difference,
        timingCategory: d.timingCategory ?? 'TEMP_OTHER',
      })),
    },
    mappingSnapshot,
    engineVersion: 'tax-engine-0.1.0',
  };

  const [result] = await tx.insert(provisionResults).values({
    tenantId: payload.tenantId,
    provisionRunId: runId,
    period,
    currentTaxExpense: String(calculation.summary.currentTaxExpense),
    deferredTaxExpense: String(calculation.summary.deferredTaxExpense),
    totalTaxExpense: String(calculation.summary.totalTaxExpense),
    bookIncome: String(calculation.summary.bookIncome),
    effectiveTaxRate: String(calculation.summary.effectiveTaxRate),
    statutoryRate: String(Number(tenant.taxRate)),
    taxPayable: String(calculation.summary.taxPayable),
    status: openCount > 0 ? 'review_required' : 'draft',
    detail,
  }).returning();

  await recordLineageEdges(tx, [
    {
      tenantId: payload.tenantId,
      sourceKind: 'provision_run', sourceId: runId,
      targetKind: 'provision_result', targetId: result.id,
      relation: 'produced',
    },
    ...input.temporaryDifferences.map((d) => ({
      tenantId: payload.tenantId,
      sourceKind: 'provision_result', sourceId: result.id,
      targetKind: 'account', targetId: d.accountId,
      relation: 'used_balance',
      metadata: { timingCategory: d.timingCategory ?? 'TEMP_OTHER', difference: String(d.difference) },
    })),
  ]);

  await tx.update(provisionRuns).set({
    resultId: result.id,
    status: openCount > 0 ? 'needs_review' : 'calculated',
    approvalStatus: openCount > 0 ? 'pending' : 'not_required',
    exceptionSummary: openCount > 0 ? `${openCount} review item(s) require attention` : null,
    updatedAt: new Date(),
  }).where(eq(provisionRuns.id, runId));

  await recordProvisionEvent({
    tenantId: payload.tenantId,
    provisionRunId: runId,
    eventType: EVENT_TYPES.CALCULATION_COMPLETED,
    actorType: 'system',
    actorUserId: payload.userId,
    reason: `Calculation completed with status ${openCount > 0 ? 'needs_review' : 'calculated'}`,
    metadata: { resultId: result.id, openReviewItems: openCount, correlationId: payload.correlationId },
  }, tx);

  return {
    runId,
    resultId: result.id,
    period,
    periodEnd,
    status: openCount > 0 ? 'needs_review' : 'calculated',
    approvalStatus: openCount > 0 ? 'pending' : 'not_required',
    openReviewItems: openCount,
    correlationId: payload.correlationId,
    inputDataHash,
    mappingVersionHash,
    parentRunId: payload.parentRunId ?? null,
    summary: calculation.summary,
    warnings,
  };
}

function orderedAccountIdsWithLowConfidence(
  mappingMap: Map<string, typeof taxMappings.$inferSelect>,
  accountMap: Map<string, typeof accounts.$inferSelect>,
  input: { unmappedAccountIds: string[]; temporaryDifferences: { accountId: string }[]; permanentDifferences: { label: string }[] },
): string[] {
  const accountIds = new Set<string>();
  for (const [accountId, mapping] of mappingMap) {
    const account = accountMap.get(accountId);
    if (!account) continue;
    const confidence = Number(mapping.confidenceScore ?? 1);
    if (mapping.suggestedByAi && confidence < LOW_CONFIDENCE_THRESHOLD) accountIds.add(accountId);
  }
  return [...accountIds].sort();
}
