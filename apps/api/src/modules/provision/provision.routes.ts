import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, desc, eq, gte, inArray, lte, not, getTableColumns } from 'drizzle-orm';
import { withTenantContext } from '../../config/db.js';
import { trialBalance } from '../../db/schema/trial-balance.js';
import { taxMappings } from '../../db/schema/tax-mappings.js';
import { provisionResults } from '../../db/schema/provision-results.js';
import { provisionRuns } from '../../db/schema/provision-runs.js';
import { provisionEvents } from '../../db/schema/provision-events.js';
import { aiRuns } from '../../db/schema/ai-runs.js';
import { reviewItems } from '../../db/schema/review-items.js';
import { entities } from '../../db/schema/entities.js';
import { accounts } from '../../db/schema/accounts.js';
import { tenants } from '../../db/schema/tenants.js';
import { users } from '../../db/schema/users.js';
import { authMiddleware } from '../../lib/middleware/auth.js';
import { strictRateLimiter } from '../../lib/middleware/rate-limiter.js';
import { getUser, requireRole, requireRunAccess, assertRunIsMutable, canMutate, assertPartnerCanApprove } from '../../lib/middleware/rbac.js';
import { BadRequestError, ForbiddenError } from '../../lib/errors.js';
import { generateProvisionWorkbook } from '../export/excel-generator.js';
import { generateWorkpaperPackage } from '../export/package-export.js';
import { createAuditLog } from '../export/audit-log.js';
import { analyzeProvision } from '../../agent/agent.js';
import { logger } from '../../lib/logger.js';
import { stableHash } from '../../eve/hash.js';
import { recordClassificationPattern } from '../../eve/pattern-store.js';
import { runMappingAgent } from '../../agent/subagents/mapping-agent.js';
import { draftAuditMemo } from '../../agent/subagents/audit-defense.js';
import { mineCredits } from '../../agent/subagents/credit-miner.js';
import { completeAiRun, failAiRun, startAiRun } from '../../eve/trace-store.js';
import { runTracedSubagent } from '../../eve/subagent-runner.js';
import { withSpan } from '@superlog/otel-helpers';
import { tracer, agentRunCounter, provisionRunCounter, reviewResolutionCounter, packageExportCounter } from '../../lib/observability.js';
import { runProvisionMath, resolveJurisdiction } from './provision-calculator.js';
import { resolveRulesUsed } from '../rules/rules.routes.js';
import { recordUsageEvent, pricePerProvision } from '../billing/usage.js';
import { computeBookTaxDifferences, Decimal } from '@taxpro/tax-engine';
import { recordProvisionEvent, getEventsForRun, EVENT_TYPES } from './provision-events.js';
import { auditSensitiveOp } from './audit.js';
import { assertWorkbenchApprovalGates } from '../workbench/guard.js';
import { assertMakerChecker } from '../handoff/guard.js';

const INCOME_TYPES = new Set(['Income', 'Revenue', 'OtherIncome', 'Sales', 'ServiceRevenue']);
const EXPENSE_TYPES = new Set(['Expense', 'COGS', 'OtherExpense', 'OperatingExpense', 'SG&A', 'CostOfSales']);
const LOW_CONFIDENCE_THRESHOLD = 0.75;

export const provisionRoutes = new Hono();
provisionRoutes.use('*', authMiddleware);

provisionRoutes.get('/entities', async (c) => {
  const user = c.get('user');
  return withTenantContext(user.tenantId, async (tx) => {
    const entityList = await tx.select({ id: entities.id, name: entities.name, type: entities.type, currency: entities.currency, taxJurisdiction: entities.taxJurisdiction })
      .from(entities).where(eq(entities.tenantId, user.tenantId));
    return c.json(entityList);
  });
});

const runProvisionSchema = z.object({
  period: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endPeriod: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  entityId: z.string().optional(),
});

provisionRoutes.post('/run',
  strictRateLimiter,
  requireRole('preparer', 'reviewer', 'partner', 'admin'),
  zValidator('json', runProvisionSchema), async (c) => {
  const user = c.get('user');
  const { period, endPeriod, entityId } = c.req.valid('json');
  const useDirect = c.req.query('direct') === 'true';
  const mode = useDirect ? 'direct' : 'eve';

  return withTenantContext(user.tenantId, async (tx) => {
    const [tenant] = await tx.select().from(tenants).where(eq(tenants.id, user.tenantId)).limit(1);
    if (!tenant) throw new BadRequestError('Tenant not found');

    const periodEnd = endPeriod ?? period;
    const tenantEntities = entityId
      ? await tx.select().from(entities).where(and(eq(entities.tenantId, user.tenantId), eq(entities.id, entityId))).limit(1)
      : await tx.select().from(entities).where(eq(entities.tenantId, user.tenantId));
    if (tenantEntities.length === 0) throw new BadRequestError('No entities found. Import trial balance data first.');

    const tbData = await tx.select().from(trialBalance)
      .where(and(
        eq(trialBalance.tenantId, user.tenantId),
        gte(trialBalance.period, period),
        lte(trialBalance.period, periodEnd),
        ...(entityId ? [eq(trialBalance.entityId, entityId)] : []),
      ));
    if (tbData.length === 0) throw new BadRequestError('No trial balance data for this period.');

    const mappings = await tx.select().from(taxMappings)
      .where(and(eq(taxMappings.tenantId, user.tenantId), eq(taxMappings.isActive, true)));
    const mappingMap = new Map(mappings.map((m) => [m.accountId, m]));

    const accountIds = [...new Set(tbData.map((t) => t.accountId))];
    const provisionAccounts = accountIds.length > 0
      ? await tx.select().from(accounts)
        .where(and(eq(accounts.tenantId, user.tenantId), inArray(accounts.id, accountIds)))
      : [];
    const accountMap = new Map(provisionAccounts.map((account) => [account.id, account]));

    const inputDataHash = stableHash(tbData.map((row) => ({
      entityId: row.entityId,
      accountId: row.accountId,
      period: row.period,
      periodEnd: row.periodEnd,
      balance: row.balance,
    })));
    const mappingVersionHash = stableHash(mappings.map((mapping) => ({
      accountId: mapping.accountId,
      taxAccountType: mapping.taxAccountType,
      bookTreatment: mapping.bookTreatment,
      timingCategory: mapping.timingCategory,
      version: mapping.version,
    })));

    const rulesUsed = await resolveRulesUsed(tx, user.tenantId, periodEnd);

    const [run] = await tx.insert(provisionRuns).values({
      tenantId: user.tenantId,
      requestedByUserId: user.userId,
      preparedByUserId: user.userId,
      period,
      endPeriod: periodEnd,
      entityId,
      mode,
      status: 'normalized',
      inputDataHash,
      mappingVersionHash,
      rulesUsed,
    }).returning();

    await recordProvisionEvent({
      tenantId: user.tenantId,
      provisionRunId: run.id,
      eventType: EVENT_TYPES.RUN_CREATED,
      actorType: 'user',
      actorUserId: user.userId,
      reason: `Provision run created for period ${period}`,
      metadata: { mode, entityId, period },
    }, tx);

    try {
      const previousRun = await tx.select().from(provisionRuns)
        .where(and(
          eq(provisionRuns.tenantId, user.tenantId),
          eq(provisionRuns.period, period),
          eq(provisionRuns.inputDataHash, inputDataHash),
          eq(provisionRuns.approvalStatus, 'approved'),
        ))
        .orderBy(desc(provisionRuns.createdAt))
        .limit(1);

      const reviewSummary = previousRun.length > 0
        ? { openCount: 0 }
        : await createReviewItemsForRun(tx, run.id, user.tenantId, tbData, mappingMap, accountMap);
      const grouped = groupTrialBalanceByAccount(tbData);

      const calculationInput = !useDirect
        ? await buildAgentCalculationInput(tx, {
          tenant,
          userId: user.userId,
          provisionRunId: run.id,
          tenantId: user.tenantId,
          period,
          endPeriod: periodEnd,
          entityId,
          grouped,
          mappings,
          accountMap,
          tbData,
        }).catch(async (err) => {
          logger.warn({ err }, '[Provision] Eve agent failed, falling back to direct');
          await tx.update(provisionRuns).set({
            status: 'needs_review',
            exceptionSummary: `Eve agent unavailable: ${err instanceof Error ? err.message : 'Unknown error'}. Run processed in direct mode.`,
            updatedAt: new Date(),
          }).where(eq(provisionRuns.id, run.id));
          return buildDeterministicCalculationInput({
            period,
            entityId,
            grouped,
            mappingMap,
            accountMap,
            tbData,
            tenant,
          });
        })
        : buildDeterministicCalculationInput({
          period,
          entityId,
          grouped,
          mappingMap,
          accountMap,
          tbData,
          tenant,
        });

      await tx.update(provisionRuns).set({
        status: reviewSummary.openCount > 0 ? 'needs_review' : 'calculated',
        approvalStatus: reviewSummary.openCount > 0 ? 'pending' : 'not_required',
        exceptionSummary: reviewSummary.openCount > 0 ? `${reviewSummary.openCount} review item(s) require attention` : null,
        updatedAt: new Date(),
      }).where(eq(provisionRuns.id, run.id));

      const calculation = runProvisionMath(calculationInput, resolveJurisdiction(tenantEntities[0]?.taxJurisdiction));
      const missingMetadata = calculationInput.missingDepreciationMetadata ?? [];
      for (const accountId of missingMetadata) {
        const account = accountMap.get(accountId);
        await tx.insert(reviewItems).values({
          tenantId: user.tenantId,
          provisionRunId: run.id,
          itemType: 'missing_depreciation_metadata',
          severity: 'medium',
          title: `Missing depreciation metadata for ${account?.name ?? accountId}`,
          description: 'No placed-in-service date or asset age is recorded for this depreciable asset. First-year MACRS was assumed for the calculation; add the placed-in-service date to remove the assumption.',
          accountId,
          sourceRef: account?.accountNumber,
          confidenceScore: 30,
        });
      }
      if (missingMetadata.length > 0) {
        await tx.update(provisionRuns).set({
          status: 'needs_review',
          approvalStatus: 'pending',
          exceptionSummary: `${reviewSummary.openCount + missingMetadata.length} review item(s) require attention`,
          updatedAt: new Date(),
        }).where(eq(provisionRuns.id, run.id));
      }
      const detailWithLabels = {
        ...calculation,
        lineItems: {
          permanentDifferences: (calculationInput.permanentDifferences ?? []).map(pd => ({ label: pd.label, amount: pd.amount })),
          temporaryDifferences: (calculationInput.temporaryDifferences ?? []).map(d => ({
            accountId: d.accountId,
            label: accountMap.get(d.accountId)?.name ?? d.accountId,
            difference: d.difference,
            timingCategory: d.timingCategory ?? 'TEMP_OTHER',
          })),
        },
      };
      const resultValues = {
        tenantId: user.tenantId,
        provisionRunId: run.id,
        period,
        currentTaxExpense: String(calculation.summary.currentTaxExpense),
        deferredTaxExpense: String(calculation.summary.deferredTaxExpense),
        totalTaxExpense: String(calculation.summary.totalTaxExpense),
        bookIncome: String(calculation.summary.bookIncome),
        effectiveTaxRate: String(calculation.summary.effectiveTaxRate),
        statutoryRate: String(Number(tenant.taxRate)),
        taxPayable: String(calculation.summary.taxPayable),
        status: reviewSummary.openCount > 0 ? 'review_required' : 'draft',
        detail: detailWithLabels,
      };

      const [result] = await tx.insert(provisionResults).values(resultValues).returning();

      await recordUsageEvent(tx, {
        tenantId: user.tenantId,
        provisionRunId: run.id,
        unitPrice: pricePerProvision(),
        metadata: { period, mode },
      });

      await tx.update(provisionRuns).set({
        resultId: result.id,
        status: reviewSummary.openCount > 0 ? 'needs_review' : 'workpapers_generated',
        updatedAt: new Date(),
      }).where(eq(provisionRuns.id, run.id));

      const subagentPromises = Promise.allSettled([
        runTracedSubagent(tx, {
          tenantId: user.tenantId,
          userId: user.userId,
          provisionRunId: run.id,
          workflowName: 'subagent_mapping_agent',
          promptVersion: 'mapping-agent-v1',
          input: {
          tenantId: user.tenantId,
          tenantName: tenant.name,
          accounts: Array.from(grouped.entries()).map(([accountId, netBalance]) => {
            const acct = accountMap.get(accountId);
            return {
              id: accountId,
              accountNumber: acct?.accountNumber ?? '',
              name: acct?.name ?? '',
              type: acct?.type ?? '',
              detailType: acct?.detailType ?? undefined,
              netBalance,
            };
          }),
          },
          execute: runMappingAgent,
        }),

        runTracedSubagent(tx, {
          tenantId: user.tenantId,
          userId: user.userId,
          provisionRunId: run.id,
          workflowName: 'subagent_audit_defense',
          promptVersion: 'audit-defense-v2',
          input: {
          entityName: tenant.name,
          period,
          bookIncome: calculation.summary.bookIncome,
          effectiveTaxRate: calculation.summary.effectiveTaxRate,
          statutoryRate: calculation.etr.statutoryRate,
          totalTaxExpense: calculation.summary.totalTaxExpense,
          currentTaxExpense: calculation.summary.currentTaxExpense,
          deferredTaxExpense: calculation.summary.deferredTaxExpense,
          taxPayable: calculation.summary.taxPayable,
          etrLines: calculation.etr.lines,
          permanentDifferences: (calculationInput.permanentDifferences ?? []).map(d => ({
            label: d.label,
            amount: d.amount,
          })),
          temporaryDifferences: (calculationInput.temporaryDifferences ?? []).map(d => ({
            timingCategory: d.timingCategory ?? 'TEMP_OTHER',
            difference: d.difference,
          })),
          },
          execute: draftAuditMemo,
        }),

        runTracedSubagent(tx, {
          tenantId: user.tenantId,
          userId: user.userId,
          provisionRunId: run.id,
          workflowName: 'subagent_credit_miner',
          promptVersion: 'credit-miner-v1',
          input: {
          tenantId: user.tenantId,
          tenantName: tenant.name,
          period,
          fiscalYear: new Date(period).getFullYear(),
          trialBalance: Array.from(grouped.entries()).map(([accountId, balance]) => {
            const acct = accountMap.get(accountId);
            return {
              accountId,
              accountName: acct?.name ?? '',
              accountNumber: acct?.accountNumber ?? '',
              accountType: acct?.type ?? '',
              balance,
            };
          }),
          },
          execute: mineCredits,
        }),
      ]);

      subagentPromises.then((results) => {
        const failed = results.filter(r => r.status === 'rejected');
        if (failed.length > 0) {
          logger.warn({ failed: failed.length }, '[SubagentSwarm] Some subagents failed');
        }
        agentRunCounter.add(3, { outcome: failed.length === 0 ? 'success' : 'partial' });
      }).catch(() => {
        agentRunCounter.add(3, { outcome: 'error' });
      });

      await recordProvisionEvent({
        tenantId: user.tenantId,
        provisionRunId: run.id,
        eventType: EVENT_TYPES.CALCULATION_COMPLETED,
        actorType: 'system',
        actorUserId: user.userId,
        reason: `Calculation completed with status ${reviewSummary.openCount > 0 ? 'needs_review' : 'calculated'}`,
        metadata: { resultId: result.id, openReviewItems: reviewSummary.openCount },
      }, tx);

      const outcome = reviewSummary.openCount > 0 ? 'needs_review' : 'success';
      provisionRunCounter.add(1, { outcome, mode: mode as string });
      return c.json({
        id: result.id,
        provisionRunId: run.id,
        mode,
        status: reviewSummary.openCount > 0 ? 'needs_review' : 'draft',
        review: reviewSummary,
        ...calculation,
        agent: !useDirect,
        agentReasoning: 'agentReasoning' in calculationInput ? calculationInput.agentReasoning : undefined,
      });
    } catch (err) {
      provisionRunCounter.add(1, { outcome: 'error', mode: mode as string });
      await tx.update(provisionRuns).set({
        status: 'failed',
        exceptionSummary: err instanceof Error ? err.message : String(err),
        updatedAt: new Date(),
      }).where(eq(provisionRuns.id, run.id));
      await recordProvisionEvent({
        tenantId: user.tenantId,
        provisionRunId: run.id,
        eventType: EVENT_TYPES.RUN_FAILED,
        actorType: 'system',
        actorUserId: user.userId,
        reason: err instanceof Error ? err.message : 'Unknown error',
        metadata: { error: err instanceof Error ? err.message : String(err) },
      }, tx);
      throw err;
    }
  });
});

provisionRoutes.get('/runs', async (c) => {
  const user = getUser(c);
  return withTenantContext(user.tenantId, async (tx) => {
    const runs = await tx.select({
      ...getTableColumns(provisionRuns),
      approvedByUserEmail: users.email,
    })
      .from(provisionRuns)
      .leftJoin(users, eq(provisionRuns.approvedByUserId, users.id))
      .where(eq(provisionRuns.tenantId, user.tenantId))
      .orderBy(desc(provisionRuns.createdAt));
    return c.json(runs);
  });
});

provisionRoutes.get('/runs/:id/review-items', async (c) => {
  const user = c.get('user');
  return withTenantContext(user.tenantId, async (tx) => {
    const items = await tx.select().from(reviewItems)
      .where(and(
        eq(reviewItems.tenantId, user.tenantId),
        eq(reviewItems.provisionRunId, c.req.param('id')),
      ))
      .orderBy(reviewItems.createdAt);
    return c.json(items);
  });
});

provisionRoutes.get('/runs/:id/ai-findings', async (c) => {
  const user = c.get('user');
  const provisionRunId = c.req.param('id');
  return withTenantContext(user.tenantId, async (tx) => {
    const [run] = await tx.select().from(provisionRuns)
      .where(and(
        eq(provisionRuns.id, provisionRunId),
        eq(provisionRuns.tenantId, user.tenantId),
      ))
      .limit(1);

    if (!run) throw new BadRequestError('Provision run not found');

    const agentRuns = await tx.select().from(aiRuns)
      .where(and(
        eq(aiRuns.tenantId, user.tenantId),
        eq(aiRuns.provisionRunId, provisionRunId),
      ))
      .orderBy(aiRuns.startedAt);

    const trackedSubagents = new Set([
      'subagent_mapping_agent',
      'subagent_audit_defense',
      'subagent_credit_miner',
    ]);
    const hasPendingSubagent = agentRuns.some((agentRun) =>
      trackedSubagents.has(agentRun.workflowName) && agentRun.status === 'started',
    );

    return c.json({
      provisionRunId,
      pending: hasPendingSubagent,
      agents: agentRuns.map((agentRun) => ({
        workflowName: agentRun.workflowName,
        status: agentRun.status,
        promptVersion: agentRun.promptVersion,
        provider: agentRun.provider,
        model: agentRun.model,
        errorMessage: agentRun.errorMessage,
        startedAt: agentRun.startedAt,
        completedAt: agentRun.completedAt,
        output: agentRun.outputJson,
      })),
    });
  });
});

provisionRoutes.get('/results', async (c) => {
  const user = c.get('user');
  return withTenantContext(user.tenantId, async (tx) => {
    const results = await tx.select().from(provisionResults)
      .where(eq(provisionResults.tenantId, user.tenantId))
      .orderBy(desc(provisionResults.createdAt));
    return c.json(results);
  });
});

provisionRoutes.get('/results/:id', async (c) => {
  const user = c.get('user');
  return withTenantContext(user.tenantId, async (tx) => {
    const [result] = await tx.select().from(provisionResults)
      .where(and(
        eq(provisionResults.id, c.req.param('id')),
        eq(provisionResults.tenantId, user.tenantId),
      )).limit(1);

    if (!result) throw new BadRequestError('Provision result not found');
    return c.json(result);
  });
});

provisionRoutes.get('/results/:id/export', async (c) => {
  const user = getUser(c);
  return withTenantContext(user.tenantId, async (tx) => {
    const [result] = await tx.select().from(provisionResults)
      .where(and(
        eq(provisionResults.id, c.req.param('id')),
        eq(provisionResults.tenantId, user.tenantId),
      )).limit(1);

    if (!result) throw new BadRequestError('Provision result not found');

    const [run] = await tx.select({ id: provisionRuns.id, status: provisionRuns.status, approvalStatus: provisionRuns.approvalStatus }).from(provisionRuns)
      .where(and(eq(provisionRuns.tenantId, user.tenantId), eq(provisionRuns.resultId, result.id))).limit(1);

    if (!canMutate(user.role) && run) {
      if (run.approvalStatus !== 'approved' && run.status !== 'locked') {
        throw new ForbiddenError('Read-only roles may only export approved or locked provision results');
      }
    }

    if (run) {
      await recordProvisionEvent({
        tenantId: user.tenantId,
        provisionRunId: run.id,
        eventType: EVENT_TYPES.EXPORT_WORKPAPER,
        actorType: 'user',
        actorUserId: user.userId,
        reason: `Workpaper export for period ${result.period}`,
        metadata: { resultId: result.id },
      }, tx);
    }

    const buf = await generateProvisionWorkbook({
      period: result.period,
      bookIncome: Number(result.bookIncome ?? 0),
      currentTaxExpense: Number(result.currentTaxExpense ?? 0),
      deferredTaxExpense: Number(result.deferredTaxExpense ?? 0),
      totalTaxExpense: Number(result.totalTaxExpense ?? 0),
      effectiveTaxRate: Number(result.effectiveTaxRate ?? 0),
      statutoryRate: Number(result.statutoryRate ?? 0),
      taxPayable: Number(result.taxPayable ?? 0),
      valuationAllowance: Number(result.valuationAllowance ?? 0),
      createdAt: result.createdAt?.toISOString?.() ?? String(result.createdAt ?? ''),
      detail: result.detail as import('../export/excel-generator.js').ProvisionExportDetail | null,
    });

    c.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    c.header('Content-Disposition', `attachment; filename="taxpro-provision-${result.period}.xlsx"`);
    return c.body(buf as any);
  });
});

provisionRoutes.get('/results/:id/ct600', async (c) => {
  const user = getUser(c);
  const format = c.req.query('format') === 'csv' ? 'csv' : 'json';
  return withTenantContext(user.tenantId, async (tx) => {
    const [result] = await tx.select().from(provisionResults)
      .where(and(
        eq(provisionResults.id, c.req.param('id')),
        eq(provisionResults.tenantId, user.tenantId),
      )).limit(1);

    if (!result) throw new BadRequestError('Provision result not found');

    const [run] = await tx.select({ id: provisionRuns.id, entityId: provisionRuns.entityId, endPeriod: provisionRuns.endPeriod, status: provisionRuns.status, approvalStatus: provisionRuns.approvalStatus }).from(provisionRuns)
      .where(and(eq(provisionRuns.tenantId, user.tenantId), eq(provisionRuns.resultId, result.id))).limit(1);

    if (!canMutate(user.role) && run) {
      if (run.approvalStatus !== 'approved' && run.status !== 'locked') {
        throw new ForbiddenError('Read-only roles may only export approved or locked provision results');
      }
    }

    let company = { companyName: 'Unknown company', utr: '0000000000' } as { companyName: string; utr: string; companiesHouseNumber?: string };
    if (run?.entityId) {
      const [entity] = await tx.select({ name: entities.name, externalId: entities.externalId })
        .from(entities).where(and(eq(entities.tenantId, user.tenantId), eq(entities.id, run.entityId))).limit(1);
      if (entity) {
        const utrQuery = c.req.query('utr');
        const utr = utrQuery?.match(/^\d{10}$/)?.[0]
          ?? entity.externalId?.match(/^\d{10}$/)?.[0]
          ?? '0000000000';
        company = { companyName: entity.name, utr, companiesHouseNumber: entity.externalId };
      }
    }

    const detail = (result.detail ?? null) as import('../export/excel-generator.js').ProvisionExportDetail | null;
    const ct600 = await (async () => {
      const { ct600FromProvisionDetail } = await import('../export/ct600.js');
      return ct600FromProvisionDetail(company, { start: result.period, end: String(run?.endPeriod ?? result.period) }, {
        currentTax: {
          bookIncome: Number(result.bookIncome ?? 0),
          totalPermanentAdjustments: 0,
          taxableIncome: detail?.currentTax?.taxableIncome ?? Number(result.bookIncome ?? 0),
          federalTax: Number(result.currentTaxExpense ?? 0),
          marginalRelief: detail?.currentTax?.marginalRelief,
          taxCredits: detail?.currentTax?.taxCredits ?? 0,
          taxPayable: Number(result.taxPayable ?? 0),
          estimatedPayments: detail?.currentTax?.estimatedPayments ?? 0,
          totalTaxAfterCredits: Number(result.taxPayable ?? 0),
        },
      });
    })();

    if (run) {
      await recordProvisionEvent({
        tenantId: user.tenantId,
        provisionRunId: run.id,
        eventType: EVENT_TYPES.EXPORT_WORKPAPER,
        actorType: 'user',
        actorUserId: user.userId,
        reason: `CT600 export for period ${result.period}`,
        metadata: { resultId: result.id, format },
      }, tx);
    }

    if (format === 'csv') {
      const { ct600ToCsv } = await import('../export/ct600.js');
      c.header('Content-Type', 'text/csv');
      c.header('Content-Disposition', `attachment; filename="taxpro-ct600-${result.period}.csv"`);
      return c.body(ct600ToCsv(ct600));
    }
    const { validateCt600Return } = await import('../export/ct600-validation.js');
    return c.json({ ...ct600, validation: validateCt600Return(ct600) });
  });
});

provisionRoutes.get('/results/:id/rd-claim', async (c) => {
  const user = getUser(c);
  return withTenantContext(user.tenantId, async (tx) => {
    const [result] = await tx.select().from(provisionResults)
      .where(and(
        eq(provisionResults.id, c.req.param('id')),
        eq(provisionResults.tenantId, user.tenantId),
      )).limit(1);

    if (!result) throw new BadRequestError('Provision result not found');

    const detail = (result.detail ?? null) as import('../export/excel-generator.js').ProvisionExportDetail | null;
    const creditMined = (detail as any)?.creditMiner?.qualifyingExpenditure ?? 0;
    const spend = Number(c.req.query('spend')) || Number(creditMined) || 0;
    const scheme = c.req.query('scheme') === 'rdec' ? 'rdec' : undefined;
    const bookIncome = Number(result.bookIncome ?? 0);
    const taxableProfit = Math.max(0, bookIncome);
    const headcount = Number(c.req.query('headcount')) || 250;
    const payeAndNic = Number(c.req.query('paye')) || 0;
    const totalCosts = Number(c.req.query('totalCosts')) || Math.max(spend * 3, 1);

    const { buildRdClaimPackage } = await import('../export/rd-claim.js');
    const pkg = buildRdClaimPackage({
      qualifyingExpenditure: spend,
      scheme,
      taxableProfit,
      payeAndNicLiability: payeAndNic,
      headcount,
      totalCosts,
      isLossMaking: bookIncome <= 0,
      periodStart: result.period,
      periodEnd: String((result as any).periodEnd ?? result.period),
    });

    if (spend === 0) {
      return c.json({ ...pkg, notice: 'No qualifying R&D spend found in the provision detail. Pass ?spend=<amount> or run the credit-miner on the trial balance.' });
    }
    return c.json(pkg);
  });
});

provisionRoutes.get('/results/:id/mtd-readiness', async (c) => {
  const user = getUser(c);
  return withTenantContext(user.tenantId, async (tx) => {
    const [result] = await tx.select().from(provisionResults)
      .where(and(
        eq(provisionResults.id, c.req.param('id')),
        eq(provisionResults.tenantId, user.tenantId),
      )).limit(1);
    if (!result) throw new BadRequestError('Provision result not found');

    const [run] = await tx.select({ entityId: provisionRuns.entityId }).from(provisionRuns)
      .where(and(eq(provisionRuns.tenantId, user.tenantId), eq(provisionRuns.resultId, result.id))).limit(1);

    let utr = c.req.query('utr') ?? '0000000000';
    let chNumber: string | undefined;
    if (run?.entityId) {
      const [entity] = await tx.select({ name: entities.name, externalId: entities.externalId })
        .from(entities).where(and(eq(entities.tenantId, user.tenantId), eq(entities.id, run.entityId))).limit(1);
      if (entity) {
        chNumber = entity.externalId;
        const utrMatch = c.req.query('utr') ?? entity.externalId?.match(/^\d{10}$/)?.[0];
        if (utrMatch) utr = utrMatch;
      }
    }

    const { buildMtdReadinessReport } = await import('../mtd/mtd-client.js');
    const report = buildMtdReadinessReport({
      utr,
      companiesHouseNumber: chNumber,
      periodStart: result.period,
      hasAgentAuthority: c.req.query('agentAuthorised') === 'true',
      signedUpToMtd: c.req.query('signedUp') === 'true',
      softwareConnected: c.req.query('softwareConnected') === 'true',
    });
    return c.json(report);
  });
});

provisionRoutes.get('/results/:id/cto-xml', async (c) => {
  const user = getUser(c);
  return withTenantContext(user.tenantId, async (tx) => {
    const [result] = await tx.select().from(provisionResults)
      .where(and(
        eq(provisionResults.id, c.req.param('id')),
        eq(provisionResults.tenantId, user.tenantId),
      )).limit(1);
    if (!result) throw new BadRequestError('Provision result not found');

    const [run] = await tx.select({ id: provisionRuns.id, entityId: provisionRuns.entityId, endPeriod: provisionRuns.endPeriod, status: provisionRuns.status, approvalStatus: provisionRuns.approvalStatus }).from(provisionRuns)
      .where(and(eq(provisionRuns.tenantId, user.tenantId), eq(provisionRuns.resultId, result.id))).limit(1);

    if (!canMutate(user.role) && run) {
      if (run.approvalStatus !== 'approved' && run.status !== 'locked') {
        throw new ForbiddenError('Read-only roles may only export approved or locked provision results');
      }
    }

    let company = { companyName: 'Unknown company', utr: '0000000000', companiesHouseNumber: undefined as string | undefined };
    if (run?.entityId) {
      const [entity] = await tx.select({ name: entities.name, externalId: entities.externalId })
        .from(entities).where(and(eq(entities.tenantId, user.tenantId), eq(entities.id, run.entityId))).limit(1);
      if (entity) {
        company = {
          companyName: entity.name,
          utr: c.req.query('utr')?.match(/^\d{10}$/)?.[0] ?? entity.externalId?.match(/^\d{10}$/)?.[0] ?? '0000000000',
          companiesHouseNumber: entity.externalId,
        };
      }
    }

    const detail = (result.detail ?? null) as import('../export/excel-generator.js').ProvisionExportDetail | null;
    const { ctoFromCt600 } = await import('../export/cto-xml.js');
    const submission = ctoFromCt600({
      company,
      period: { start: result.period, end: String(run?.endPeriod ?? result.period) },
      computed: { totalTaxCharge: Number(result.currentTaxExpense ?? 0), taxPayable: Number(result.taxPayable ?? 0) },
      boxes: [
        { box: 5, name: 'Profits chargeable', value: detail?.currentTax?.taxableIncome ?? Number(result.bookIncome ?? 0) },
        { box: 10, name: 'Taxable total profits', value: detail?.currentTax?.taxableIncome ?? Number(result.bookIncome ?? 0) },
        { box: 12, name: 'Corporation tax at main rate', value: detail?.currentTax?.federalTax ?? Number(result.currentTaxExpense ?? 0) },
        { box: 13, name: 'Corporation tax at small profits rate', value: 0 },
        { box: 14, name: 'Marginal relief', value: detail?.currentTax?.marginalRelief ?? 0 },
      ],
    }, {
      gatewayTest: c.req.query('test') !== 'false',
      vendorId: c.req.query('vendorId'),
      senderId: c.req.query('senderId'),
    });

    if (run) {
      await recordProvisionEvent({
        tenantId: user.tenantId,
        provisionRunId: run.id,
        eventType: EVENT_TYPES.EXPORT_WORKPAPER,
        actorType: 'user',
        actorUserId: user.userId,
        reason: `CTO XML export for period ${result.period}`,
        metadata: { resultId: result.id },
      }, tx);
    }

    c.header('Content-Type', 'text/xml');
    c.header('Content-Disposition', `attachment; filename="${submission.filename}"`);
    return c.body(submission.xml);
  });
});

function groupTrialBalanceByAccount(tbData: Array<typeof trialBalance.$inferSelect>) {
  const grouped = new Map<string, number>();
  for (const tb of tbData) {
    grouped.set(tb.accountId, (grouped.get(tb.accountId) ?? 0) + Number(tb.balance ?? 0));
  }
  return grouped;
}

function detectMissingDepreciationMetadata(args: {
  grouped: Map<string, number>;
  mappingMap: Map<string, typeof taxMappings.$inferSelect>;
  accountMap: Map<string, typeof accounts.$inferSelect>;
  tbData: Array<typeof trialBalance.$inferSelect>;
  entityId?: string;
  period: string;
}) {
  const missing: string[] = [];
  for (const [accountId] of args.grouped) {
    const mapping = args.mappingMap.get(accountId);
    if (!mapping || mapping.bookTreatment !== 'temporary') continue;
    const account = args.accountMap.get(accountId);
    const tbLine = args.tbData.find((t) => t.accountId === accountId);
    const computed = computeBookTaxDifferences(
      [{
        accountId,
        entityId: tbLine?.entityId ?? args.entityId ?? 'consolidated',
        period: args.period,
        balance: new Decimal(args.grouped.get(accountId) ?? 0),
        placedInServiceDate: (tbLine?.placedInServiceDate ?? account?.placedInServiceDate) ?? undefined,
      }],
      [],
      new Map([[accountId, {
        accountId,
        taxAccountType: mapping.taxAccountType,
        bookTreatment: mapping.bookTreatment,
        timingCategory: mapping.timingCategory ?? undefined,
      } as any]]),
      args.period
    )[0];
    if (computed?.depreciationAgeSource === 'no_metadata' && !missing.includes(accountId)) {
      missing.push(accountId);
    }
  }
  return missing;
}

function buildDeterministicCalculationInput(args: {
  period: string;
  entityId?: string;
  grouped: Map<string, number>;
  mappingMap: Map<string, typeof taxMappings.$inferSelect>;
  accountMap: Map<string, typeof accounts.$inferSelect>;
  tbData: Array<typeof trialBalance.$inferSelect>;
  tenant: typeof tenants.$inferSelect;
}) {
  let totalRevenue = 0;
  let totalExpenses = 0;
  const permanentDifferences: { amount: number; label: string }[] = [];
  const temporaryDifferences: {
    accountId: string;
    entityId: string;
    period: string;
    bookBalance: number;
    taxBalance: number;
    difference: number;
    diffType: 'temporary';
    timingCategory?: string;
  }[] = [];
  const missingDepreciationMetadata = detectMissingDepreciationMetadata({
    grouped: args.grouped,
    mappingMap: args.mappingMap,
    accountMap: args.accountMap,
    tbData: args.tbData,
    entityId: args.entityId,
    period: args.period,
  });

  for (const [accountId, balance] of args.grouped) {
    const mapping = args.mappingMap.get(accountId);
    const account = args.accountMap.get(accountId);
    if (account?.type && INCOME_TYPES.has(account.type)) totalRevenue += Math.abs(balance);
    if (account?.type && EXPENSE_TYPES.has(account.type)) totalExpenses += Math.abs(balance);
    if (!mapping) continue;

    if (mapping.bookTreatment === 'permanent') {
      permanentDifferences.push({ amount: balance, label: mapping.taxAccountType });
    } else if (mapping.bookTreatment === 'temporary') {
      const tbLine = args.tbData.find((t) => t.accountId === accountId);
      const entityId = tbLine?.entityId ?? args.entityId ?? 'consolidated';
      const computedList = computeBookTaxDifferences(
        [{
          accountId,
          entityId,
          period: args.period,
          balance: new Decimal(balance),
          placedInServiceDate: (tbLine?.placedInServiceDate ?? account?.placedInServiceDate) ?? undefined,
        }],
        [],
        new Map([[accountId, { accountId, taxAccountType: mapping.taxAccountType, bookTreatment: mapping.bookTreatment, timingCategory: mapping.timingCategory ?? undefined } as any]]),
        args.period
      );
      const computed = computedList[0];

      temporaryDifferences.push({
        accountId,
        entityId,
        period: args.period,
        bookBalance: balance,
        taxBalance: computed ? computed.taxBalance.toNumber() : 0,
        difference: computed ? computed.difference.toNumber() : balance,
        diffType: 'temporary',
        timingCategory: mapping.timingCategory ?? undefined,
      });
    }
  }

  return {
    bookIncome: totalRevenue - totalExpenses,
    permanentDifferences,
    temporaryDifferences,
    missingDepreciationMetadata,
    federalRate: Number(args.tenant.taxRate),
    stateRate: Number(args.tenant.stateTaxRate ?? 0),
    taxCredits: 0,
    estimatedPayments: 0,
    nolUtilization: 0,
    entityId: args.entityId ?? 'consolidated',
    period: args.period,
  };
}

async function buildAgentCalculationInput(tx: any, args: {
  tenant: typeof tenants.$inferSelect;
  tenantId: string;
  userId: string;
  provisionRunId: string;
  period: string;
  endPeriod?: string;
  entityId?: string;
  grouped: Map<string, number>;
  mappings: Array<typeof taxMappings.$inferSelect>;
  accountMap: Map<string, typeof accounts.$inferSelect>;
  tbData: Array<typeof trialBalance.$inferSelect>;
}) {
  const trialBalanceForAgent = Array.from(args.grouped.entries()).map(([accountId, balance]) => {
    const account = args.accountMap.get(accountId);
    return {
      accountId,
      accountName: account?.name ?? '',
      accountNumber: account?.accountNumber ?? '',
      accountType: account?.type ?? '',
      netBalance: balance,
    };
  });

  const agentInput = {
    tenantId: args.tenantId,
    tenantName: args.tenant.name,
    period: args.period,
    endPeriod: args.endPeriod,
    entityId: args.entityId,
    federalRate: Number(args.tenant.taxRate),
    stateRate: Number(args.tenant.stateTaxRate ?? 0),
    trialBalance: trialBalanceForAgent,
    mappings: args.mappings.map((m) => ({
      accountId: m.accountId,
      taxAccountType: m.taxAccountType,
      bookTreatment: m.bookTreatment,
      timingCategory: m.timingCategory,
      confidenceScore: Number(m.confidenceScore ?? 0),
      explanation: m.aiExplanation,
    })),
  };

  const aiRun = await startAiRun(tx, {
    tenantId: args.tenantId,
    userId: args.userId,
    provisionRunId: args.provisionRunId,
    workflowName: 'eve_provision_analysis',
    promptVersion: 'eve-provision-analysis-v1',
  }, agentInput);

  try {
    const agentResult = await analyzeProvision(agentInput);
    if (!agentResult.success) throw new BadRequestError(`Agent analysis failed: ${agentResult.error ?? 'Unknown error'}`);
    await completeAiRun(aiRun.id, agentResult, tx);

    return {
      bookIncome: agentResult.bookIncome,
      permanentDifferences: agentResult.permanentDifferences.map((pd) => ({ amount: pd.amount, label: pd.label })),
      temporaryDifferences: agentResult.temporaryDifferences.map((d) => ({
        accountId: d.accountId,
        entityId: d.entityId,
        period: d.period,
        bookBalance: d.bookBalance,
        taxBalance: d.taxBalance,
        difference: d.difference,
        diffType: 'temporary' as const,
        timingCategory: d.timingCategory ?? 'TEMP_OTHER',
      })),
      federalRate: Number(args.tenant.taxRate),
      stateRate: Number(args.tenant.stateTaxRate ?? 0),
      taxCredits: 0,
      estimatedPayments: 0,
      nolUtilization: 0,
      missingDepreciationMetadata: detectMissingDepreciationMetadata({
        grouped: args.grouped,
        mappingMap: new Map(args.mappings.map((m) => [m.accountId, m])),
        accountMap: args.accountMap,
        tbData: args.tbData,
        entityId: args.entityId,
        period: args.period,
      }),
      entityId: args.entityId ?? 'consolidated',
      period: args.period,
      agentReasoning: agentResult.reasoning,
    };
  } catch (err) {
    await failAiRun(aiRun.id, err, tx);
    logger.error({ err, provisionRunId: args.provisionRunId }, '[Provision] Eve workflow failed');
    throw err;
  }
}

async function createReviewItemsForRun(
  tx: any,
  provisionRunId: string,
  tenantId: string,
  tbData: Array<typeof trialBalance.$inferSelect>,
  mappingMap: Map<string, typeof taxMappings.$inferSelect>,
  accountMap: Map<string, typeof accounts.$inferSelect>,
) {
  let openCount = 0;
  const accountIds = [...new Set(tbData.map((tb) => tb.accountId))];

  for (const accountId of accountIds) {
    const mapping = mappingMap.get(accountId);
    const account = accountMap.get(accountId);
    if (!mapping) {
      openCount++;
      await tx.insert(reviewItems).values({
        tenantId,
        provisionRunId,
        itemType: 'missing_mapping',
        severity: 'high',
        title: `Missing tax mapping for ${account?.name ?? accountId}`,
        description: 'This account is included in the trial balance but has no active tax mapping. A reviewer should classify it before final delivery.',
        accountId,
        sourceRef: account?.accountNumber,
      });
      continue;
    }

    const confidence = Number(mapping.confidenceScore ?? 1);
    if (mapping.suggestedByAi && confidence < LOW_CONFIDENCE_THRESHOLD) {
      openCount++;
      await tx.insert(reviewItems).values({
        tenantId,
        provisionRunId,
        itemType: 'low_confidence_mapping',
        severity: 'medium',
        title: `Review AI mapping for ${account?.name ?? accountId}`,
        description: mapping.aiExplanation ?? 'AI mapping confidence is below the review threshold.',
        accountId,
        sourceRef: account?.accountNumber,
        confidenceScore: Math.round(confidence * 100),
        metadata: {
          taxAccountType: mapping.taxAccountType,
          bookTreatment: mapping.bookTreatment,
          timingCategory: mapping.timingCategory,
        },
      });
    }
  }

  return { openCount };
}

// ── Package export: zip with .xlsx + audit trail ──
// Exports remain allowed for all authenticated roles.
// client_readonly and auditor may only export approved or locked results.
provisionRoutes.get('/results/:id/package', async (c) => {
  const user = getUser(c);
  return withTenantContext(user.tenantId, async (tx) => {
    const [result] = await tx.select().from(provisionResults)
      .where(and(
        eq(provisionResults.id, c.req.param('id')),
        eq(provisionResults.tenantId, user.tenantId),
      )).limit(1);
    if (!result) throw new BadRequestError('Provision result not found');

    const [run] = await tx.select().from(provisionRuns)
      .where(and(
        eq(provisionRuns.tenantId, user.tenantId),
        eq(provisionRuns.resultId, result.id),
      )).limit(1);

    if (!canMutate(user.role) && run) {
      if (run.approvalStatus !== 'approved' && run.status !== 'locked') {
        throw new ForbiddenError('Read-only roles may only export approved or locked provision results');
      }
    }

    const auditLog = createAuditLog();
    auditLog.add('provision_run', `Provision run for ${result.period}`, { mode: run?.mode ?? 'unknown' });

    let reviewItemsData: Array<typeof reviewItems.$inferSelect> = [];
    if (run) {
      reviewItemsData = await tx.select().from(reviewItems)
        .where(eq(reviewItems.provisionRunId, run.id));
      for (const item of reviewItemsData) {
        auditLog.add(`review_item:${item.itemType}`, item.title, item.metadata as Record<string, unknown> ?? {}, 'system');
      }
    }

    if (run) {
      await recordProvisionEvent({
        tenantId: user.tenantId,
        provisionRunId: run.id,
        eventType: EVENT_TYPES.EXPORT_PACKAGE,
        actorType: 'user',
        actorUserId: user.userId,
        reason: `Package export for period ${result.period}`,
        metadata: { resultId: result.id },
      }, tx);
    }

    const aiTraceData = run
      ? await tx.select({
        workflowName: aiRuns.workflowName,
        status: aiRuns.status,
        provider: aiRuns.provider,
        model: aiRuns.model,
        promptVersion: aiRuns.promptVersion,
        errorMessage: aiRuns.errorMessage,
        completedAt: aiRuns.completedAt,
      }).from(aiRuns).where(eq(aiRuns.provisionRunId, run.id))
      : [];

    const buf = await generateWorkpaperPackage({
      period: result.period,
      bookIncome: Number(result.bookIncome ?? 0),
      currentTaxExpense: Number(result.currentTaxExpense ?? 0),
      deferredTaxExpense: Number(result.deferredTaxExpense ?? 0),
      totalTaxExpense: Number(result.totalTaxExpense ?? 0),
      effectiveTaxRate: Number(result.effectiveTaxRate ?? 0),
      statutoryRate: Number(result.statutoryRate ?? 0),
      taxPayable: Number(result.taxPayable ?? 0),
      valuationAllowance: Number(result.valuationAllowance ?? 0),
      createdAt: result.createdAt?.toISOString?.() ?? String(result.createdAt ?? ''),
      auditEntries: auditLog.entries,
      reviewItems: reviewItemsData?.map((i) => ({
        itemType: i.itemType,
        title: i.title,
        severity: i.severity,
        status: i.status,
        confidenceScore: i.confidenceScore,
      })) ?? [],
      aiTraces: aiTraceData.map((t) => ({
        workflowName: t.workflowName,
        status: t.status,
        provider: t.provider,
        model: t.model,
        promptVersion: t.promptVersion,
        errorMessage: t.errorMessage,
        completedAt: t.completedAt ? t.completedAt.toISOString() : null,
      })),
      approvalTrail: {
        approvalStatus: run?.approvalStatus ?? 'unknown',
        submittedAt: run?.submittedAt ? run.submittedAt.toISOString() : null,
        finalizedAt: run?.finalizedAt ? run.finalizedAt.toISOString() : null,
      },
      sourceHash: run?.inputDataHash ?? null,
      mappingVersionHash: run?.mappingVersionHash ?? null,
      engineVersion: run?.engineVersion ?? null,
      mode: run?.mode ?? null,
    });

    packageExportCounter.add(1, { outcome: 'success' });
    c.header('Content-Type', 'application/zip');
    c.header('Content-Disposition', `attachment; filename="taxpro-package-${result.period}.zip"`);
    return c.body(buf as any);
  });
});

// ── Eve assistant: conversational workflow operator ──
provisionRoutes.post('/eve/ask', strictRateLimiter, async (c) => {
  const user = c.get('user');
  const { prompt } = await c.req.json() as { prompt: string };
  if (!prompt) throw new BadRequestError('Missing "prompt" in request body');

  const { tenant, recentRuns } = await withTenantContext(user.tenantId, async (tx) => {
    const [tenant] = await tx.select().from(tenants).where(eq(tenants.id, user.tenantId)).limit(1);
    if (!tenant) throw new BadRequestError('Tenant not found');

    const recentRuns = await tx.select().from(provisionRuns)
      .where(eq(provisionRuns.tenantId, user.tenantId))
      .orderBy(desc(provisionRuns.createdAt))
      .limit(5);
    return { tenant, recentRuns };
  });

  const systemContext = `You are Eve, TaxPro's AI provision assistant. You help corporate tax professionals run and review ASC 740 tax provisions.

Current tenant: ${tenant.name}
Recent provision runs: ${recentRuns.length > 0 ? recentRuns.map(r => `- ${r.period} (status: ${r.status}, mode: ${r.mode})`).join('\n') : 'None yet'}

You can answer questions about provision results, suggest next steps, and flag items needing review.`;

  const { callJsonModel } = await import('../../eve/model-client.js');
  const response = await callJsonModel({
    schema: z.object({
      answer: z.string(),
      suggestedAction: z.string().optional(),
    }),
    system: systemContext,
    user: prompt,
    promptVersion: 'eve-assistant-v1',
    temperature: 0.3,
  });

  return c.json({ answer: response.parsed.answer, suggestedAction: response.parsed.suggestedAction });
});

// ── Review endpoints ──

const resolveReviewItemSchema = z.object({
  resolution: z.enum(['approved', 'rejected', 'override']),
  resolutionNote: z.string().optional(),
});

provisionRoutes.post('/runs/:runId/review-items/:itemId/resolve',
  requireRole('preparer', 'reviewer', 'partner', 'admin'),
  zValidator('json', resolveReviewItemSchema), async (c) => {
    const user = getUser(c);
    const { runId, itemId } = c.req.param();
    const { resolution, resolutionNote } = c.req.valid('json');

    return withTenantContext(user.tenantId, async (tx) => {
      await assertRunIsMutable(runId, user.tenantId, tx);
      const [item] = await tx.select().from(reviewItems)
        .where(and(
          eq(reviewItems.id, itemId),
          eq(reviewItems.provisionRunId, runId),
          eq(reviewItems.tenantId, user.tenantId),
        )).limit(1);
      if (!item) throw new BadRequestError('Review item not found');

      const resolvedStatus = resolution === 'rejected' ? 'rejected' : 'resolved';
      reviewResolutionCounter.add(1, { resolution: resolution as string });

      await tx.update(reviewItems).set({
        status: resolvedStatus,
        resolvedByUserId: user.userId,
        resolutionNote: resolutionNote ?? null,
        resolvedAt: new Date(),
        updatedAt: new Date(),
      }).where(eq(reviewItems.id, itemId));

      const eventType = resolution === 'rejected' ? EVENT_TYPES.REVIEW_ITEM_REJECTED : EVENT_TYPES.REVIEW_ITEM_RESOLVED;
      await recordProvisionEvent({
        tenantId: user.tenantId,
        provisionRunId: runId,
        eventType,
        actorType: 'user',
        actorUserId: user.userId,
        reason: resolutionNote || `Review item ${resolvedStatus}`,
        metadata: { itemId, itemType: item.itemType, resolution, accountId: item.accountId },
      }, tx);

      if (item.accountId && resolution !== 'rejected') {
        recordClassificationPattern({
          tenantId: user.tenantId,
          accountId: item.accountId,
          resolution: resolution as any,
          resolvedByUserId: user.userId,
          resolutionNote: resolutionNote ?? undefined,
        }).catch((err) => logger.error({ err }, '[Pattern] Failed to record'));
      }

      const openItems = await tx.select().from(reviewItems)
        .where(and(
          eq(reviewItems.provisionRunId, runId),
          eq(reviewItems.status, 'open'),
        ));

      return c.json({ itemId, status: resolvedStatus, openRemaining: openItems.length });
    });
});

provisionRoutes.post('/runs/:runId/review-items/bulk-resolve',
  requireRole('preparer', 'reviewer', 'partner', 'admin'),
  async (c) => {
    const user = getUser(c);
    const { runId } = c.req.param();
    const { resolution, resolutionNote } = await c.req.json() as { resolution: string; resolutionNote?: string };

    return withTenantContext(user.tenantId, async (tx) => {
      await assertRunIsMutable(runId, user.tenantId, tx);
      const openItems = await tx.select().from(reviewItems)
        .where(and(
          eq(reviewItems.provisionRunId, runId),
          eq(reviewItems.tenantId, user.tenantId),
          eq(reviewItems.status, 'open'),
        ));

      const newStatus = resolution === 'approved' ? 'resolved' : 'rejected';
      for (const item of openItems) {
        await tx.update(reviewItems).set({
          status: newStatus,
          resolvedByUserId: user.userId,
          resolutionNote: resolutionNote ?? null,
          resolvedAt: new Date(),
          updatedAt: new Date(),
        }).where(eq(reviewItems.id, item.id));
      }

      await recordProvisionEvent({
        tenantId: user.tenantId,
        provisionRunId: runId,
        eventType: resolution === 'approved' ? EVENT_TYPES.REVIEW_ITEM_RESOLVED : EVENT_TYPES.REVIEW_ITEM_REJECTED,
        actorType: 'user',
        actorUserId: user.userId,
        reason: `Bulk ${resolution} of ${openItems.length} items` + (resolutionNote ? `: ${resolutionNote}` : ''),
        metadata: { bulk: true, count: openItems.length, resolution },
      }, tx);

      return c.json({ resolved: openItems.length, status: newStatus });
    });
});

provisionRoutes.post('/runs/:runId/finalize',
  requireRole('preparer', 'reviewer', 'partner', 'admin'),
  async (c) => {
    const user = getUser(c);
    const { runId } = c.req.param();

    return withSpan(
      'provision.finalize',
      async () => {
        return withTenantContext(user.tenantId, async (tx) => {
          await assertRunIsMutable(runId, user.tenantId, tx);

          const [run] = await tx.select().from(provisionRuns)
            .where(and(eq(provisionRuns.id, runId), eq(provisionRuns.tenantId, user.tenantId))).limit(1);
          if (!run) throw new BadRequestError('Provision run not found');

          await assertWorkbenchApprovalGates(tx, user.tenantId, run);

          const openItems = await tx.select().from(reviewItems)
            .where(and(eq(reviewItems.provisionRunId, runId), eq(reviewItems.status, 'open')));
          if (openItems.length > 0) throw new BadRequestError(`Cannot finalize: ${openItems.length} review item(s) still open`);

          const now = new Date();
          await tx.update(provisionRuns).set({
            status: 'finalized',
            finalizedAt: now,
            updatedAt: now,
          }).where(eq(provisionRuns.id, runId));

          await auditSensitiveOp(tx, {
            tenantId: user.tenantId,
            runId,
            action: 'run.finalized',
            actorUserId: user.userId,
            actorRole: user.role,
            details: { period: run.period, etrVariance: null, finalizedAt: now.toISOString() },
            requestId: c.get('requestId'),
          });

          return c.json({ runId, status: 'finalized' });
        });
      },
      {
        tracer,
        attributes: {
          'taxpro.tenant_id': user.tenantId,
          'taxpro.provision_run_id': runId,
        },
      },
    );
});

// Phase 2 Governance Endpoints

provisionRoutes.post('/runs/:runId/submit-for-approval',
  requireRole('reviewer', 'partner', 'admin'),
  async (c) => {
    const user = getUser(c);
    const { runId } = c.req.param();

    return withTenantContext(user.tenantId, async (tx) => {
      await assertRunIsMutable(runId, user.tenantId, tx);
      const [run] = await tx.select().from(provisionRuns)
        .where(and(eq(provisionRuns.id, runId), eq(provisionRuns.tenantId, user.tenantId))).limit(1);
      if (!run) throw new BadRequestError('Provision run not found');

      const now = new Date();
      await tx.update(provisionRuns).set({
        approvalStatus: 'pending_partner_review',
        submittedAt: now,
        submittedByUserId: user.userId,
        updatedAt: now,
      }).where(eq(provisionRuns.id, runId));

      await recordProvisionEvent({
        tenantId: user.tenantId,
        provisionRunId: runId,
        eventType: EVENT_TYPES.SUBMITTED_FOR_APPROVAL,
        actorType: 'user',
        actorUserId: user.userId,
        reason: 'Submitted for partner approval',
        beforeState: { approvalStatus: run.approvalStatus },
        afterState: { approvalStatus: 'pending_partner_review' },
      }, tx);

      return c.json({ runId, approvalStatus: 'pending_partner_review' });
    });
});

provisionRoutes.post('/runs/:runId/partner-approve',
  requireRole('partner', 'admin'),
  async (c) => {
    const user = getUser(c);
    const { runId } = c.req.param();

    return withTenantContext(user.tenantId, async (tx) => {
      await assertRunIsMutable(runId, user.tenantId, tx);
      const [run] = await tx.select().from(provisionRuns)
        .where(and(eq(provisionRuns.id, runId), eq(provisionRuns.tenantId, user.tenantId))).limit(1);
      if (!run) throw new BadRequestError('Provision run not found');

      assertPartnerCanApprove(run, user.userId);

      await assertMakerChecker(tx, user.tenantId, run, user.userId);

      const now = new Date();
      await tx.update(provisionRuns).set({
        approvalStatus: 'approved',
        approvedByUserId: user.userId,
        approvedAt: now,
        updatedAt: now,
      }).where(eq(provisionRuns.id, runId));

      await recordProvisionEvent({
        tenantId: user.tenantId,
        provisionRunId: runId,
        eventType: EVENT_TYPES.PARTNER_APPROVED,
        actorType: 'user',
        actorUserId: user.userId,
        reason: 'Partner approved the provision run',
        beforeState: { approvalStatus: run.approvalStatus },
        afterState: { approvalStatus: 'approved' },
      }, tx);

      return c.json({ runId, approvalStatus: 'approved', approvedByUserId: user.userId });
    });
});

provisionRoutes.post('/runs/:runId/lock',
  requireRole('partner', 'admin'),
  async (c) => {
    const user = getUser(c);
    const { runId } = c.req.param();

    return withTenantContext(user.tenantId, async (tx) => {
      const [run] = await tx.select().from(provisionRuns)
        .where(and(eq(provisionRuns.id, runId), eq(provisionRuns.tenantId, user.tenantId))).limit(1).for('update');
      if (!run) throw new BadRequestError('Provision run not found');

      if (run.approvalStatus !== 'approved') {
        throw new BadRequestError('Run must be approved by a partner before locking');
      }

      await assertWorkbenchApprovalGates(tx, user.tenantId, run);

      await assertMakerChecker(tx, user.tenantId, run, user.userId);

      const now = new Date();
      await tx.update(provisionRuns).set({
        status: 'locked',
        lockedAt: now,
        lockedByUserId: user.userId,
        finalizedAt: now,
        updatedAt: now,
      }).where(eq(provisionRuns.id, runId));

      await auditSensitiveOp(tx, {
        tenantId: user.tenantId,
        runId,
        action: 'run.locked',
        actorUserId: user.userId,
        actorRole: user.role,
        details: { previousStatus: run.status, previousApprovalStatus: run.approvalStatus },
        requestId: c.get('requestId'),
      });

      return c.json({ runId, status: 'locked' });
    });
});

provisionRoutes.post('/runs/:runId/unlock',
  requireRole('partner', 'admin'),
  async (c) => {
    const user = getUser(c);
    const { runId } = c.req.param();

    return withTenantContext(user.tenantId, async (tx) => {
      const [run] = await tx.select().from(provisionRuns)
        .where(and(eq(provisionRuns.id, runId), eq(provisionRuns.tenantId, user.tenantId))).limit(1).for('update');
      if (!run) throw new BadRequestError('Provision run not found');

      if (run.status !== 'locked') {
        throw new BadRequestError('Run is not locked');
      }

      if (run.filedExternallyAt) {
        throw new BadRequestError('An external filing is recorded for this run. Unlocking is not permitted — corrections must be a new run version (recalculate).');
      }

      const now = new Date();
      await tx.update(provisionRuns).set({
        status: 'draft',
        lockedAt: null,
        lockedByUserId: null,
        handoffReadyAt: null,
        handoffReadyByUserId: null,
        updatedAt: now,
      }).where(eq(provisionRuns.id, runId));

      await auditSensitiveOp(tx, {
        tenantId: user.tenantId,
        runId,
        action: 'run.unlocked',
        actorUserId: user.userId,
        actorRole: user.role,
        details: { previousStatus: 'locked' },
        requestId: c.get('requestId'),
      });

      return c.json({ runId, status: 'unlocked' });
    });
});

provisionRoutes.get('/runs/:runId/trial-balance-detail', async (c) => {
  const user = c.get('user');
  const { runId } = c.req.param();
  
  return withTenantContext(user.tenantId, async (tx) => {
    const [run] = await tx.select().from(provisionRuns)
      .where(and(eq(provisionRuns.id, runId), eq(provisionRuns.tenantId, user.tenantId))).limit(1);
    if (!run) throw new BadRequestError('Provision run not found');

    const tbData = await tx.select({
      accountId: trialBalance.accountId,
      accountName: accounts.name,
      accountNumber: accounts.accountNumber,
      type: accounts.type,
      balance: trialBalance.balance,
      taxAccountType: taxMappings.taxAccountType,
      bookTreatment: taxMappings.bookTreatment,
      confidenceScore: taxMappings.confidenceScore,
      suggestedByAi: taxMappings.suggestedByAi,
      mappingVersion: taxMappings.version,
    }).from(trialBalance)
      .innerJoin(accounts, eq(trialBalance.accountId, accounts.id))
      .leftJoin(taxMappings, and(
        eq(taxMappings.accountId, accounts.id),
        eq(taxMappings.isActive, true)
      ))
      .where(and(
        eq(trialBalance.tenantId, user.tenantId),
        gte(trialBalance.period, run.period),
        lte(trialBalance.period, run.endPeriod ?? run.period),
        run.entityId ? eq(trialBalance.entityId, run.entityId) : undefined
      ));

    const grouped = new Map<string, any>();
    for (const row of tbData) {
      if (!grouped.has(row.accountId)) {
        grouped.set(row.accountId, {
          accountId: row.accountId,
          accountName: row.accountName,
          accountNumber: row.accountNumber,
          type: row.type,
          balance: 0,
          taxAccountType: row.taxAccountType,
          bookTreatment: row.bookTreatment,
          confidenceScore: row.confidenceScore ? Number(row.confidenceScore) : null,
          suggestedByAi: row.suggestedByAi,
        });
      }
      grouped.get(row.accountId)!.balance += Number(row.balance);
    }

    const items = await tx.select().from(reviewItems)
      .where(eq(reviewItems.provisionRunId, runId));
    
    const results = Array.from(grouped.values()).map(row => {
      const reviewItem = items.find(i => i.accountId === row.accountId);
      return {
        ...row,
        reviewItemId: reviewItem?.id,
        reviewItemStatus: reviewItem?.status,
        reviewItemSeverity: reviewItem?.severity,
      };
    });

    return c.json(results);
  });
});

provisionRoutes.get('/runs/:runId/compare', async (c) => {
  const user = c.get('user');
  const { runId } = c.req.param();

  return withTenantContext(user.tenantId, async (tx) => {
    const [run] = await tx.select().from(provisionRuns)
      .where(and(eq(provisionRuns.id, runId), eq(provisionRuns.tenantId, user.tenantId))).limit(1);
    if (!run) throw new BadRequestError('Provision run not found');

    const currentResult = run.resultId
      ? (await tx.select().from(provisionResults).where(eq(provisionResults.id, run.resultId)).limit(1))[0]
      : null;

    const [previousRun] = await tx.select().from(provisionRuns)
      .where(and(
        eq(provisionRuns.tenantId, user.tenantId),
        eq(provisionRuns.period, run.period),
        run.entityId ? eq(provisionRuns.entityId, run.entityId) : undefined,
        not(eq(provisionRuns.id, run.id)),
      ))
      .orderBy(desc(provisionRuns.createdAt))
      .limit(1);

    const previousResult = previousRun?.resultId
      ? (await tx.select().from(provisionResults).where(eq(provisionResults.id, previousRun.resultId)).limit(1))[0]
      : null;

    return c.json({
      currentPeriod: run.period,
      previousPeriod: previousRun?.period ?? null,
      current: currentResult ?? null,
      previous: previousResult ?? null,
      delta: currentResult && previousResult ? {
        bookIncome: Number(currentResult.bookIncome) - Number(previousResult.bookIncome),
        totalTaxExpense: Number(currentResult.totalTaxExpense) - Number(previousResult.totalTaxExpense),
        effectiveTaxRate: Number(currentResult.effectiveTaxRate) - Number(previousResult.effectiveTaxRate),
        taxPayable: Number(currentResult.taxPayable) - Number(previousResult.taxPayable),
      } : null,
    });
  });
});

provisionRoutes.get('/runs/:runId/events', async (c) => {
  const user = getUser(c);
  const { runId } = c.req.param();

  return withTenantContext(user.tenantId, async (tx) => {
    await requireRunAccess(runId, user.tenantId, tx);
    const events = await getEventsForRun(runId, user.tenantId, tx);
    return c.json(events);
  });
});

provisionRoutes.get('/review/queue', async (c) => {
  const user = c.get('user');
  return withTenantContext(user.tenantId, async (tx) => {
    const severityRank = { high: 0, medium: 1, low: 2 };

    const needsReviewRuns = await tx.select().from(provisionRuns)
      .where(and(
        eq(provisionRuns.tenantId, user.tenantId),
        eq(provisionRuns.status, 'needs_review'),
      ))
      .orderBy(desc(provisionRuns.createdAt));

    const summary = await Promise.all(needsReviewRuns.map(async (run) => {
      const openItems = await tx.select().from(reviewItems)
        .where(and(
          eq(reviewItems.provisionRunId, run.id),
          eq(reviewItems.status, 'open'),
        ))
        .orderBy(reviewItems.createdAt);
      const maxSeverity = openItems.reduce((max, item) => {
        const rank = severityRank[item.severity as keyof typeof severityRank] ?? 2;
        return Math.min(max, rank);
      }, 2);
      return { run, openItems, maxSeverity };
    }));

    summary.sort((a, b) => {
      if (a.maxSeverity !== b.maxSeverity) return a.maxSeverity - b.maxSeverity;
      if (b.openItems.length !== a.openItems.length) return b.openItems.length - a.openItems.length;
      return new Date(b.run.createdAt ?? 0).getTime() - new Date(a.run.createdAt ?? 0).getTime();
    });

    return c.json(summary);
  });
});
