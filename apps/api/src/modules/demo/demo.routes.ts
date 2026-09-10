import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { db, withTenantContext } from '../../config/db.js';
import { tenants } from '../../db/schema/tenants.js';
import { users } from '../../db/schema/users.js';
import { entities } from '../../db/schema/entities.js';
import { accounts } from '../../db/schema/accounts.js';
import { taxMappings } from '../../db/schema/tax-mappings.js';
import { trialBalance } from '../../db/schema/trial-balance.js';
import bcrypt from 'bcryptjs';
import { and, eq, isNull } from 'drizzle-orm';
import { authMiddleware } from '../../lib/middleware/auth.js';
import { getUser } from '../../lib/middleware/rbac.js';
import { BadRequestError } from '../../lib/errors.js';
import { SCENARIOS, SCENARIO_IDS, isScenarioId } from './scenarios.js';
import { accountingPeriods } from '../../db/schema/accounting-periods.js';
import { taxPeriods } from '../../db/schema/tax-periods.js';
import { mappingProposals } from '../../db/schema/mapping-proposals.js';
import { reviewItems } from '../../db/schema/review-items.js';
import { provisionRuns } from '../../db/schema/provision-runs.js';
import { sourceDocuments } from '../../db/schema/source-documents.js';

export const demoRoutes = new Hono();

const DEMO_PERIOD = '2025-01-01';
const DEMO_PERIOD_END = '2025-12-31';
const DEMO_FISCAL_YEAR = 2025;
const DEMO_FISCAL_PERIOD = 12;

const demoAccounts = [
  { externalId: '3000', number: '3000', name: 'Revenue', type: 'Income', detailType: 'Income', balance: '-1000000.00', mapping: { taxAccountType: 'NODIFF_REVENUE', bookTreatment: 'no_diff' } },
  { externalId: '4000', number: '4000', name: 'Cost of Goods Sold', type: 'Expense', detailType: 'COGS', balance: '300000.00', mapping: { taxAccountType: 'NODIFF_COGS', bookTreatment: 'no_diff' } },
  { externalId: '5000', number: '5000', name: 'Salaries and Wages', type: 'Expense', detailType: 'Expense', balance: '180000.00', mapping: { taxAccountType: 'NODIFF_SALARIES', bookTreatment: 'no_diff' } },
  { externalId: '5100', number: '5100', name: 'Office Rent', type: 'Expense', detailType: 'Expense', balance: '30000.00', mapping: { taxAccountType: 'NODIFF_RENT', bookTreatment: 'no_diff' } },
  { externalId: '5200', number: '5200', name: 'Utilities', type: 'Expense', detailType: 'Expense', balance: '10000.00', mapping: { taxAccountType: 'NODIFF_UTILITIES', bookTreatment: 'no_diff' } },
  { externalId: '6000', number: '6000', name: 'Depreciation - Buildings', type: 'Expense', detailType: 'Fixed Asset', balance: '80000.00', mapping: { taxAccountType: 'TEMP_FIXED_ASSET_ALLOWANCE', bookTreatment: 'temporary', timingCategory: 'taxable_temporary' } },
  { externalId: '6100', number: '6100', name: 'Depreciation - Equipment', type: 'Expense', detailType: 'Fixed Asset', balance: '60000.00', mapping: { taxAccountType: 'TEMP_FIXED_ASSET_ALLOWANCE', bookTreatment: 'temporary', timingCategory: 'taxable_temporary' } },
  { externalId: '6200', number: '6200', name: 'Amortization - Intangibles', type: 'Expense', detailType: 'Fixed Asset', balance: '40000.00', mapping: { taxAccountType: 'TEMP_TIMING_DIFFERENCE', bookTreatment: 'temporary', timingCategory: 'taxable_temporary' } },
  { externalId: '7000', number: '7000', name: 'Meals and Entertainment', type: 'Expense', detailType: 'Expense', balance: '10000.00', mapping: { taxAccountType: 'PERM_OTHER', bookTreatment: 'permanent' } },
  { externalId: '7100', number: '7100', name: 'Fines and Penalties', type: 'Expense', detailType: 'Expense', balance: '5000.00', mapping: { taxAccountType: 'PERM_OTHER', bookTreatment: 'permanent' } },
  { externalId: '7200', number: '7200', name: 'Political Contributions', type: 'Expense', detailType: 'Expense', balance: '2000.00', mapping: { taxAccountType: 'PERM_OTHER', bookTreatment: 'permanent' } },
  { externalId: '8000', number: '8000', name: 'Bad Debt Reserve', type: 'Expense', detailType: 'Expense', balance: '15000.00', mapping: { taxAccountType: 'TEMP_TIMING_DIFFERENCE', bookTreatment: 'temporary', timingCategory: 'deductible_temporary' } },
  { externalId: '8100', number: '8100', name: 'Warranty Reserve', type: 'Expense', detailType: 'Expense', balance: '8000.00', mapping: { taxAccountType: 'TEMP_TIMING_DIFFERENCE', bookTreatment: 'temporary', timingCategory: 'deductible_temporary' } },
  { externalId: '9000', number: '9000', name: 'Interest Income', type: 'Income', detailType: 'Income', balance: '-20000.00', mapping: { taxAccountType: 'NODIFF_INTEREST_INCOME', bookTreatment: 'no_diff' } },
];

demoRoutes.use('*', authMiddleware);

demoRoutes.post('/seed', async (c) => {
  const user = c.get('user');

  return withTenantContext(user.tenantId, async (tx) => {
    const existing = await tx.select().from(trialBalance).where(eq(trialBalance.tenantId, user.tenantId)).limit(1);
    if (existing.length > 0) {
      throw new BadRequestError('Demo data already exists for this tenant. Clear trial balance first.');
    }

    const entity = await tx.insert(entities).values({
      tenantId: user.tenantId,
      externalId: 'demo-entity-greggs',
      name: 'Greggs plc (Demo)',
      type: 'Corporation',
      currency: 'GBP',
      taxJurisdiction: 'UK_FRS102',
    }).returning().then(r => r[0]);

    const createdAccounts: Record<string, string> = {};
    for (const acct of demoAccounts) {
      const [row] = await tx.insert(accounts).values({
        tenantId: user.tenantId,
        externalId: acct.externalId,
        accountNumber: acct.number,
        name: acct.name,
        type: acct.type,
        detailType: acct.detailType,
      }).returning();
      createdAccounts[acct.externalId] = row.id;
    }

    for (const acct of demoAccounts) {
      const accountId = createdAccounts[acct.externalId];
      await tx.insert(taxMappings).values({
        tenantId: user.tenantId,
        accountId,
        taxAccountType: acct.mapping.taxAccountType,
        bookTreatment: acct.mapping.bookTreatment,
        timingCategory: acct.mapping.timingCategory || null,
        confidenceScore: '0.85',
        suggestedByAi: true,
        status: 'active',
        version: 1,
      });

      await tx.insert(trialBalance).values({
        tenantId: user.tenantId,
        entityId: entity.id,
        accountId,
        period: DEMO_PERIOD,
        periodEnd: DEMO_PERIOD_END,
        fiscalYear: DEMO_FISCAL_YEAR,
        fiscalPeriod: DEMO_FISCAL_PERIOD,
        debit: parseFloat(acct.balance) > 0 ? acct.balance : '0',
        credit: parseFloat(acct.balance) < 0 ? Math.abs(parseFloat(acct.balance)).toString() : '0',
        balance: acct.balance,
        source: 'demo',
      });
    }

    const totalIncome = demoAccounts.filter(a => a.type === 'Income').reduce((s, a) => s - parseFloat(a.balance), 0);
    const totalExpenses = demoAccounts.filter(a => a.type === 'Expense').reduce((s, a) => s + parseFloat(a.balance), 0);
    const pbt = totalIncome - totalExpenses;
    const netTemporary = demoAccounts
      .filter(a => a.mapping.bookTreatment === 'temporary')
      .reduce((s, a) => s + (a.mapping.timingCategory === 'taxable_temporary' ? parseFloat(a.balance) : -parseFloat(a.balance)), 0);
    const expectedDtl = Math.round(netTemporary * 0.25 * 100) / 100;

    return c.json({
      message: 'Demo data loaded — Greggs plc synthetic trial balance',
      entity: { id: entity.id, name: entity.name },
      accounts: demoAccounts.length,
      summary: { totalIncome, totalExpenses, pbt },
      nextStep: `Run "Provision" to calculate tax — expect ~£${expectedDtl.toLocaleString('en-GB')} deferred DTL (25% main rate)`,
    });
  });
});

// ── Phase E: multi-scenario UK synthetic demo tenant ──
// Same tenant-scoped, RLS-safe pattern as /seed (everything runs inside
// withTenantContext). Account externalIds are namespaced per scenario
// (`APEX-MFG:4000`) so all three scenarios coexist in one tenant without
// overwriting each other's chart of accounts.

demoRoutes.get('/scenarios', async (c) => {
  const user = getUser(c);
  return withTenantContext(user.tenantId, async (tx) => {
    const out = [];
    for (const id of SCENARIO_IDS) {
      const scenario = SCENARIOS[id];
      const [entity] = await tx.select({ id: entities.id }).from(entities)
        .where(and(eq(entities.tenantId, user.tenantId), eq(entities.externalId, scenario.entityExternalId)))
        .limit(1);
      let trialBalanceRows = 0;
      if (entity) {
        const rows = await tx.select({ id: trialBalance.id }).from(trialBalance)
          .where(and(eq(trialBalance.tenantId, user.tenantId), eq(trialBalance.entityId, entity.id)))
          .limit(1);
        trialBalanceRows = rows.length;
      }
      out.push({
        id: scenario.id,
        entityExternalId: scenario.entityExternalId,
        entityName: scenario.entityName,
        narrative: scenario.narrative,
        highlights: scenario.highlights,
        expectedOutcome: scenario.expectedOutcome,
        period: scenario.period,
        periodEnd: scenario.periodEnd,
        loaded: !!entity && trialBalanceRows > 0,
      });
    }
    return c.json({ scenarios: out });
  });
});

const switchScenarioSchema = z.object({
  scenario: z.enum(['apex-marginal-relief', 'biotech-rd-loss', 'cotswold-capex']),
  reset: z.boolean().optional().default(false),
});

demoRoutes.post('/switch-scenario',
  zValidator('json', switchScenarioSchema), async (c) => {
    const user = getUser(c);
    const { scenario: scenarioId, reset } = c.req.valid('json');
    if (!isScenarioId(scenarioId)) throw new BadRequestError('Unknown scenario');
    const scenario = SCENARIOS[scenarioId];

    return withTenantContext(user.tenantId, async (tx) => {
      const [existing] = await tx.select().from(entities)
        .where(and(eq(entities.tenantId, user.tenantId), eq(entities.externalId, scenario.entityExternalId)))
        .limit(1);

      if (existing && !reset) {
        return c.json({ scenario: scenarioId, alreadyLoaded: true, entity: { id: existing.id, name: existing.name } });
      }

      if (existing && reset) {
        const runs = await tx.select({ id: provisionRuns.id }).from(provisionRuns)
          .where(and(eq(provisionRuns.tenantId, user.tenantId), eq(provisionRuns.entityId, existing.id)))
          .limit(1);
        if (runs.length > 0) {
          throw new BadRequestError('Scenario has provision runs. Delete the runs (or use a fresh tenant) before resetting — run history is never destroyed by a reseed.');
        }
        // FK-safe teardown, scenario-scoped rows only.
        await tx.delete(trialBalance).where(and(eq(trialBalance.tenantId, user.tenantId), eq(trialBalance.entityId, existing.id)));
        await tx.delete(mappingProposals).where(and(eq(mappingProposals.tenantId, user.tenantId), eq(mappingProposals.entityId, existing.id)));
        await tx.delete(reviewItems).where(and(eq(reviewItems.tenantId, user.tenantId), eq(reviewItems.entityId, existing.id), isNull(reviewItems.provisionRunId)));
        await tx.delete(sourceDocuments).where(and(eq(sourceDocuments.tenantId, user.tenantId), eq(sourceDocuments.entityId, existing.id)));
        await tx.delete(taxPeriods).where(and(eq(taxPeriods.tenantId, user.tenantId), eq(taxPeriods.entityId, existing.id)));
        await tx.delete(accountingPeriods).where(and(eq(accountingPeriods.tenantId, user.tenantId), eq(accountingPeriods.entityId, existing.id)));
        // Accounts are namespaced per scenario — delete only this scenario's.
        for (const acct of scenario.accounts) {
          const namespaced = `${scenario.entityExternalId}:${acct.externalId}`;
          // Mappings/proposals/TB rows referencing these accounts are gone above
          // (proposals/TB by entity; mappings cascade via account delete or explicit).
          const [row] = await tx.select({ id: accounts.id }).from(accounts)
            .where(and(eq(accounts.tenantId, user.tenantId), eq(accounts.externalId, namespaced)))
            .limit(1);
          if (!row) continue;
          await tx.delete(taxMappings).where(and(eq(taxMappings.tenantId, user.tenantId), eq(taxMappings.accountId, row.id)));
          await tx.delete(accounts).where(eq(accounts.id, row.id));
        }
        await tx.delete(entities).where(eq(entities.id, existing.id));
      }

      const [entity] = await tx.insert(entities).values({
        tenantId: user.tenantId,
        externalId: scenario.entityExternalId,
        name: scenario.entityName,
        type: 'Limited Company',
        currency: 'GBP',
        isConsolidated: true,
        taxJurisdiction: 'UK_FRS102',
      }).onConflictDoUpdate({
        target: [entities.tenantId, entities.externalId],
        set: { name: scenario.entityName, taxJurisdiction: 'UK_FRS102', currency: 'GBP', updatedAt: new Date() },
      }).returning();

      const [accountingPeriod] = await tx.insert(accountingPeriods).values({
        tenantId: user.tenantId,
        entityId: entity.id,
        name: `FY${scenario.fiscalYear} (12 months)`,
        startDate: scenario.period,
        endDate: scenario.periodEnd,
        periodType: 'annual',
        status: 'open',
      }).onConflictDoNothing().returning();

      const [taxPeriod] = await tx.insert(taxPeriods).values({
        tenantId: user.tenantId,
        entityId: entity.id,
        accountingPeriodId: accountingPeriod?.id ?? null,
        startDate: scenario.period,
        endDate: scenario.periodEnd,
        durationMonths: 12,
        isStandardDuration: true,
        status: 'open',
      }).onConflictDoNothing().returning();

      await tx.insert(sourceDocuments).values({
        tenantId: user.tenantId,
        entityId: entity.id,
        accountingPeriodId: accountingPeriod?.id ?? null,
        taxPeriodId: taxPeriod?.id ?? null,
        documentType: 'trial_balance',
        filename: `${scenario.entityExternalId.toLowerCase()}-fy${scenario.fiscalYear}-trial-balance.csv`,
        mimeType: 'text/csv',
        sizeBytes: 4096,
        storageKey: `demo://${user.tenantId}/trial_balance/${scenario.entityExternalId.toLowerCase()}-fy${scenario.fiscalYear}.csv`,
        sha256: '0000000000000000000000000000000000000000000000000000000000000000',
        provenance: 'demo_scenario',
        extractionStatus: 'not_required',
        version: 1,
        isCurrent: true,
      }).onConflictDoNothing();

      let mapped = 0;
      let pending = 0;
      for (const acct of scenario.accounts) {
        const namespaced = `${scenario.entityExternalId}:${acct.externalId}`;
        const [account] = await tx.insert(accounts).values({
          tenantId: user.tenantId,
          externalId: namespaced,
          accountNumber: acct.accountNumber,
          name: acct.name,
          type: acct.type,
          detailType: acct.detailType,
          ...(acct.placedInServiceDate ? { placedInServiceDate: acct.placedInServiceDate } : {}),
        }).onConflictDoUpdate({
          target: [accounts.tenantId, accounts.externalId],
          set: {
            accountNumber: acct.accountNumber,
            name: acct.name,
            type: acct.type,
            detailType: acct.detailType,
            ...(acct.placedInServiceDate ? { placedInServiceDate: acct.placedInServiceDate } : {}),
            updatedAt: new Date(),
          },
        }).returning();

        if (acct.mapping) {
          await tx.insert(taxMappings).values({
            tenantId: user.tenantId,
            accountId: account.id,
            taxAccountType: acct.mapping.taxAccountType,
            bookTreatment: acct.mapping.bookTreatment,
            timingCategory: acct.mapping.timingCategory ?? null,
            confidenceScore: acct.mapping.confidenceScore,
            suggestedByAi: true,
            aiExplanation: acct.mapping.aiExplanation,
            status: 'active',
            version: 1,
          }).onConflictDoUpdate({
            target: [taxMappings.tenantId, taxMappings.accountId, taxMappings.version],
            set: {
              taxAccountType: acct.mapping.taxAccountType,
              bookTreatment: acct.mapping.bookTreatment,
              timingCategory: acct.mapping.timingCategory ?? null,
              confidenceScore: acct.mapping.confidenceScore,
              suggestedByAi: true,
              aiExplanation: acct.mapping.aiExplanation,
              isActive: true,
              updatedAt: new Date(),
            },
          });
          mapped++;
        }

        if (acct.proposal) {
          const [existingProposal] = await tx.select({ id: mappingProposals.id }).from(mappingProposals)
            .where(and(
              eq(mappingProposals.tenantId, user.tenantId),
              eq(mappingProposals.accountId, account.id),
              eq(mappingProposals.version, 1),
            ))
            .limit(1);
          if (!existingProposal) {
            await tx.insert(mappingProposals).values({
              tenantId: user.tenantId,
              entityId: entity.id,
              accountId: account.id,
              sourceAccountExternalId: namespaced,
              sourceAccountName: acct.name,
              targetTaxClassification: acct.proposal.targetTaxClassification,
              bookTreatment: acct.proposal.bookTreatment,
              timingCategory: acct.proposal.timingCategory ?? null,
              confidenceScore: acct.proposal.confidenceScore,
              proposalSource: 'ai',
              status: 'pending',
              version: 1,
              decisionReason: acct.proposal.reason,
            }).onConflictDoNothing();
          }
          pending++;
        }

        const debit = Number(acct.balance) > 0 ? acct.balance : '0';
        const credit = Number(acct.balance) < 0 ? String(Math.abs(Number(acct.balance))) : '0';
        await tx.insert(trialBalance).values({
          tenantId: user.tenantId,
          entityId: entity.id,
          accountId: account.id,
          period: scenario.period,
          periodEnd: scenario.periodEnd,
          fiscalYear: scenario.fiscalYear,
          fiscalPeriod: 12,
          ...(acct.placedInServiceDate ? { placedInServiceDate: acct.placedInServiceDate } : {}),
          debit,
          credit,
          balance: acct.balance,
          source: 'scenario',
        }).onConflictDoUpdate({
          target: [trialBalance.tenantId, trialBalance.entityId, trialBalance.accountId, trialBalance.period, trialBalance.source],
          set: {
            periodEnd: scenario.periodEnd,
            ...(acct.placedInServiceDate ? { placedInServiceDate: acct.placedInServiceDate } : {}),
            debit,
            credit,
            balance: acct.balance,
          },
        });
      }

      return c.json({
        scenario: scenarioId,
        alreadyLoaded: false,
        reset: !!reset,
        entity: { id: entity.id, name: entity.name },
        accounts: scenario.accounts.length,
        mapped,
        pendingProposals: pending,
        expectedOutcome: scenario.expectedOutcome,
        nextStep: 'Open Workbench, select this entity and FY2026, then run the provision.',
      });
    });
  });
