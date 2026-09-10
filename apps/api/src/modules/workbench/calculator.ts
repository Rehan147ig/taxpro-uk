// ─────────────────────────────────────────────────────────────────────────────
// Phase C — Deterministic workbench calculation.
//
// Builds the calculation input exclusively from the approved mapping snapshot
// and the linked trial balance, then runs the deterministic UK engine.
// AI is never consulted here: mapping decisions must be approved before a run
// is created (see gates.ts), and this module only reads active mappings.
// ─────────────────────────────────────────────────────────────────────────────

import Decimal from 'decimal.js';
import { and, eq, gte, lte, inArray } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { computeBookTaxDifferences } from '@taxpro/tax-engine';
import { trialBalance } from '../../db/schema/trial-balance.js';
import { taxMappings } from '../../db/schema/tax-mappings.js';
import { accounts } from '../../db/schema/accounts.js';
import { stableHash } from '../../eve/hash.js';
import { runProvisionMath, resolveJurisdiction } from '../provision/provision-calculator.js';

export const INCOME_TYPES = new Set(['Income', 'Revenue', 'OtherIncome', 'Sales', 'ServiceRevenue']);
export const EXPENSE_TYPES = new Set(['Expense', 'COGS', 'OtherExpense', 'OperatingExpense', 'SG&A', 'CostOfSales']);
const LOW_CONFIDENCE_THRESHOLD = 0.75;

export interface MappingSnapshotEntry {
  accountId: string;
  taxAccountType: string;
  bookTreatment: string;
  timingCategory?: string | null;
  version: number | null;
  confidenceScore?: string | null;
  suggestedByAi?: boolean | null;
}

export interface WorkbenchCalculationInput {
  bookIncome: number;
  permanentDifferences: { amount: number; label: string }[];
  temporaryDifferences: {
    accountId: string;
    entityId: string;
    period: string;
    bookBalance: number;
    taxBalance: number;
    difference: number;
    diffType: 'temporary';
    timingCategory?: string;
  }[];
  federalRate: number;
  stateRate?: number;
  taxCredits: number;
  estimatedPayments: number;
  nolUtilization: number;
  entityId: string;
  period: string;
  missingDepreciationMetadata: string[];
  unmappedAccountIds: string[];
}

export async function loadWorkbenchData(tx: NodePgDatabase, args: {
  tenantId: string;
  entityId: string;
  period: string;
  periodEnd: string;
  sourceDocumentId: string;
}) {
  const tbRows = await tx.select().from(trialBalance).where(and(
    eq(trialBalance.tenantId, args.tenantId),
    eq(trialBalance.entityId, args.entityId),
    eq(trialBalance.sourceDocumentId, args.sourceDocumentId),
  ));

  const accountIds = [...new Set(tbRows.map((t) => t.accountId))];
  const accountRows = accountIds.length > 0
    ? await tx.select().from(accounts)
      .where(and(eq(accounts.tenantId, args.tenantId), inArray(accounts.id, accountIds)))
    : [];

  const mappings = await tx.select().from(taxMappings)
    .where(and(eq(taxMappings.tenantId, args.tenantId), eq(taxMappings.isActive, true)));

  return { tbRows, accountRows, mappings };
}

/**
 * Deterministic calculation input. Account iteration is sorted by id so the
 * result and its provenance are reproducible for identical inputs.
 */
export function buildWorkbenchCalculationInput(args: {
  period: string;
  entityId: string;
  tbRows: Array<typeof trialBalance.$inferSelect>;
  mappingMap: Map<string, typeof taxMappings.$inferSelect>;
  accountMap: Map<string, typeof accounts.$inferSelect>;
  taxRate: number;
  stateTaxRate?: number;
  /** Entity tax jurisdiction (e.g. UK_FRS102_S29). UK fixed assets use CAA 2001 pool rates. */
  taxJurisdiction?: string;
}): WorkbenchCalculationInput {
  let totalRevenue = 0;
  let totalExpenses = 0;
  const permanentDifferences: { amount: number; label: string }[] = [];
  const temporaryDifferences: WorkbenchCalculationInput['temporaryDifferences'] = [];
  const missingDepreciationMetadata: string[] = [];
  const unmappedAccountIds: string[] = [];

  const orderedAccountIds = [...args.tbRows.reduce((set, row) => set.add(row.accountId), new Set<string>())].sort();

  for (const accountId of orderedAccountIds) {
    const balance = args.tbRows.reduce((sum, row) => (row.accountId === accountId ? sum + Number(row.balance ?? 0) : sum), 0);
    const account = args.accountMap.get(accountId);
    const mapping = args.mappingMap.get(accountId);

    if (account?.type && INCOME_TYPES.has(account.type)) totalRevenue += Math.abs(balance);
    if (account?.type && EXPENSE_TYPES.has(account.type)) totalExpenses += Math.abs(balance);

    if (!mapping) {
      unmappedAccountIds.push(accountId);
      continue;
    }

    if (mapping.bookTreatment === 'permanent') {
      permanentDifferences.push({ amount: balance, label: mapping.taxAccountType });
      continue;
    }

    if (mapping.bookTreatment === 'temporary') {
      const tbLine = args.tbRows.find((t) => t.accountId === accountId);
      const computedList = computeBookTaxDifferences(
        [{
          accountId,
          entityId: tbLine?.entityId ?? args.entityId,
          period: args.period,
          balance: new Decimal(balance),
          placedInServiceDate: (tbLine?.placedInServiceDate ?? account?.placedInServiceDate) ?? undefined,
        }],
        [],
        new Map([[accountId, {
          accountId,
          taxAccountType: mapping.taxAccountType,
          bookTreatment: mapping.bookTreatment,
          timingCategory: mapping.timingCategory ?? undefined,
        } as any]]),
        args.period,
        1,
        args.taxJurisdiction ? { jurisdiction: args.taxJurisdiction } : undefined,
      );
      const computed = computedList[0];

      if (computed?.depreciationAgeSource === 'no_metadata') {
        missingDepreciationMetadata.push(accountId);
      }

      temporaryDifferences.push({
        accountId,
        entityId: tbLine?.entityId ?? args.entityId,
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
    federalRate: args.taxRate,
    stateRate: args.stateTaxRate && args.stateTaxRate > 0 ? args.stateTaxRate : undefined,
    taxCredits: 0,
    estimatedPayments: 0,
    nolUtilization: 0,
    entityId: args.entityId,
    period: args.period,
    missingDepreciationMetadata,
    unmappedAccountIds,
  };
}

export function buildMappingSnapshot(mappings: Array<typeof taxMappings.$inferSelect>): MappingSnapshotEntry[] {
  return mappings
    .map((m) => ({
      accountId: m.accountId,
      taxAccountType: m.taxAccountType,
      bookTreatment: m.bookTreatment,
      timingCategory: m.timingCategory ?? null,
      version: m.version,
      confidenceScore: m.confidenceScore ?? null,
      suggestedByAi: m.suggestedByAi ?? null,
    }))
    .sort((a, b) => a.accountId.localeCompare(b.accountId));
}

export function hashWorkbenchInput(args: {
  tbRows: Array<typeof trialBalance.$inferSelect>;
  sourceSha256: string;
  mappingSnapshot: MappingSnapshotEntry[];
}): { inputDataHash: string; mappingVersionHash: string } {
  const inputDataHash = stableHash({
    sourceSha256: args.sourceSha256,
    rows: args.tbRows.map((row) => ({
      entityId: row.entityId,
      accountId: row.accountId,
      period: row.period,
      periodEnd: row.periodEnd,
      balance: row.balance,
      source: row.source,
    })),
  });
  const mappingVersionHash = stableHash(args.mappingSnapshot);
  return { inputDataHash, mappingVersionHash };
}

/**
 * Deterministic, provenance-annotated UK calculation. Returns the same shape
 * the existing provision routes persist, plus the warnings generated while
 * building the input.
 */
export function runWorkbenchCalculation(args: {
  input: WorkbenchCalculationInput;
  taxJurisdiction?: string | null;
}) {
  const warnings: { code: string; message: string }[] = [];

  for (const accountId of args.input.unmappedAccountIds) {
    warnings.push({
      code: 'unmapped_account',
      message: `Account ${accountId} is in the trial balance but has no active mapping; it was excluded from the calculation and a review item was created.`,
    });
  }
  for (const accountId of args.input.missingDepreciationMetadata) {
    warnings.push({
      code: 'missing_depreciation_metadata',
      message: `Depreciable account ${accountId} has no placed-in-service date; first-year rate was assumed and a review item was created.`,
    });
  }

  const calculation = runProvisionMath(args.input, resolveJurisdiction(args.taxJurisdiction));
  return { calculation, warnings };
}

export { LOW_CONFIDENCE_THRESHOLD };
