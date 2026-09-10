import Decimal from 'decimal.js';
import { createEngine, Jurisdiction, etrAdjustmentsForMarginalRelief } from '@taxpro/tax-engine';

export interface ProvisionMathInput {
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
  taxCredits?: number;
  estimatedPayments?: number;
  nolUtilization?: number;
  entityId: string;
  period: string;
}

/**
 * Exact set of persisted entity.taxJurisdiction values mapped to the engine
 * Jurisdiction enum. Values the app itself writes ('US-Federal', 'UK_FRS102')
 * are known; anything else fails closed instead of being silently guessed.
 */
const KNOWN_JURISDICTIONS: Record<string, Jurisdiction> = {
  UK_FRS102: Jurisdiction.UK_FRS102_S29,
  UK_FRS102_S29: Jurisdiction.UK_FRS102_S29,
  // 'UK' is a legacy value written by the Xero connector's sync; it means UK
  // FRS 102 in this product and is preserved as an explicit alias.
  UK: Jurisdiction.UK_FRS102_S29,
  US: Jurisdiction.US_ASC740,
  'US-Federal': Jurisdiction.US_ASC740,
  US_ASC740: Jurisdiction.US_ASC740,
};

/**
 * Map a persisted entity.taxJurisdiction string to the engine Jurisdiction enum.
 *
 * Fails closed: a missing or unrecognized jurisdiction is an error, never a
 * silent guess. The pre-UK-first behavior silently defaulted to US_ASC740,
 * which could compute a provision under the wrong regime.
 */
export function resolveJurisdiction(taxJurisdiction?: string | null): Jurisdiction {
  if (!taxJurisdiction) {
    throw new Error('Entity has no taxJurisdiction set — refusing to guess. Set taxJurisdiction (e.g. UK_FRS102, UK_FRS102_S29, US_ASC740) before running a provision.');
  }
  const resolved = KNOWN_JURISDICTIONS[taxJurisdiction.trim()];
  if (resolved) return resolved;
  throw new Error(`Unrecognized taxJurisdiction '${taxJurisdiction}' — refusing to guess. Supported values: ${Object.keys(KNOWN_JURISDICTIONS).join(', ')}`);
}

export function runProvisionMath(input: ProvisionMathInput, jurisdiction: Jurisdiction = Jurisdiction.US_ASC740) {
  const engine = createEngine(jurisdiction);
  const bookIncome = money(input.bookIncome);
  const federalRate = rate(input.federalRate);
  const stateRate = input.stateRate && input.stateRate > 0 ? rate(input.stateRate) : undefined;

  const permanentDifferences = input.permanentDifferences.map((pd) => ({
    amount: money(pd.amount),
    label: pd.label,
  }));

  const temporaryDifferences = input.temporaryDifferences.map((d) => ({
    accountId: d.accountId,
    entityId: d.entityId,
    period: d.period,
    bookBalance: money(d.bookBalance),
    taxBalance: money(d.taxBalance),
    difference: money(d.difference),
    diffType: 'temporary' as const,
    timingCategory: d.timingCategory ?? 'TEMP_OTHER',
  }));

  const currentTax = engine.calculateCurrentTax({
    bookIncome,
    permanentDifferences,
    taxRate: federalRate,
    stateTaxRate: stateRate,
    taxCredits: money(input.taxCredits ?? 0),
    estimatedPayments: money(input.estimatedPayments ?? 0),
    nolUtilization: money(input.nolUtilization ?? 0),
    asOfDate: input.period,
  });

  const deferredTax = engine.calculateDeferredTax(
    temporaryDifferences,
    {},
    {},
    {
      deductible_temporary: federalRate,
      taxable_temporary: federalRate,
      TEMP_OTHER: federalRate,
    },
  );

  const rollforward = engine.generateRollforward({
    priorYear: {
      deferredTaxLines: [],
      valuationAllowance: money(0),
      nolCarryforward: money(0),
      taxCreditCarryforward: money(0),
    },
    currentYear: {
      temporaryDifferences,
      nolUtilized: money(input.nolUtilization ?? 0),
      nolGenerated: money(0),
      creditsUtilized: money(0),
      creditsGenerated: money(input.taxCredits ?? 0),
      valuationAllowanceChange: money(0),
      taxRateChanges: [],
    },
  });

  const etr = engine.calculateETR({
    bookIncome: currentTax.bookIncome,
    federalTaxRate: federalRate,
    federalTax: currentTax.federalTax,
    stateTax: currentTax.stateTax,
    permanentDifferences,
    taxCredits: currentTax.taxCredits,
    otherAdjustments: etrAdjustmentsForMarginalRelief(currentTax),
    jurisdiction,
  });

  const journalEntries = engine.generateJournalEntries(
    currentTax,
    deferredTax,
    money(0),
    input.entityId,
    input.period,
  );

  const totalTaxExpense = currentTax.totalTaxAfterCredits.plus(deferredTax.netDeferredTaxExpense);
  const effectiveTaxRate = bookIncome.greaterThan(0) ? totalTaxExpense.div(bookIncome) : money(0);

  return {
    jurisdiction,
    summary: {
      bookIncome: bookIncome.toNumber(),
      totalTaxExpense: totalTaxExpense.toNumber(),
      effectiveTaxRate: effectiveTaxRate.toNumber(),
      currentTaxExpense: currentTax.totalTaxAfterCredits.toNumber(),
      deferredTaxExpense: deferredTax.netDeferredTaxExpense.toNumber(),
      taxPayable: currentTax.taxPayable.toNumber(),
    },
    currentTax: {
      bookIncome: currentTax.bookIncome.toNumber(),
      totalPermanentAdjustments: currentTax.totalPermanentAdjustments.toNumber(),
      taxableIncome: currentTax.taxableIncome.toNumber(),
      federalTaxRate: currentTax.federalTaxRate.toNumber(),
      federalTax: currentTax.federalTax.toNumber(),
      stateTax: currentTax.stateTax.toNumber(),
      totalTaxBeforeCredits: currentTax.totalTaxBeforeCredits.toNumber(),
      taxCredits: currentTax.taxCredits.toNumber(),
      nolUtilization: currentTax.nolUtilization.toNumber(),
      totalTaxAfterCredits: currentTax.totalTaxAfterCredits.toNumber(),
      estimatedPayments: currentTax.estimatedPayments.toNumber(),
      taxPayable: currentTax.taxPayable.toNumber(),
      effectiveTaxRate: currentTax.effectiveTaxRate.toNumber(),
    },
    deferredTax: {
      totalOpeningDTA: deferredTax.totalOpeningDTA.toNumber(),
      totalOpeningDTL: deferredTax.totalOpeningDTL.toNumber(),
      totalClosingDTA: deferredTax.totalClosingDTA.toNumber(),
      totalClosingDTL: deferredTax.totalClosingDTL.toNumber(),
      netDeferredTaxExpense: deferredTax.netDeferredTaxExpense.toNumber(),
      lines: deferredTax.lines.map((line) => ({
        timingCategory: line.timingCategory,
        openingBalance: line.openingBalance.toNumber(),
        currentYearChange: line.currentYearChange.toNumber(),
        taxRate: line.taxRate.toNumber(),
        deferredTaxAmount: line.deferredTaxAmount.toNumber(),
        reversals: line.reversals.toNumber(),
        closingBalance: line.closingBalance.toNumber(),
        dtType: line.dtType,
      })),
    },
    rollforward: {
      deferredTaxRollforward: rollforward.deferredTaxRollforward.map((line) => ({
        timingCategory: line.timingCategory,
        openingBalance: line.openingBalance.toNumber(),
        currentYearChange: line.currentYearChange.toNumber(),
        taxRate: line.taxRate.toNumber(),
        deferredTaxAmount: line.deferredTaxAmount.toNumber(),
        reversals: line.reversals.toNumber(),
        closingBalance: line.closingBalance.toNumber(),
        dtType: line.dtType,
      })),
      nolRollforward: decimalRecordToNumber(rollforward.nolRollforward),
      creditRollforward: decimalRecordToNumber(rollforward.creditRollforward),
      valuationAllowance: decimalRecordToNumber(rollforward.valuationAllowance),
    },
    etr: {
      statutoryRate: etr.statutoryRate.toNumber(),
      statutoryTax: etr.statutoryTax.toNumber(),
      effectiveTaxRate: etr.effectiveTaxRate.toNumber(),
      totalTaxExpense: etr.totalTaxExpense.toNumber(),
      lines: etr.lines.map((line) => ({
        description: line.description,
        amount: line.amount.toNumber(),
        taxImpact: line.taxImpact.toNumber(),
        rateImpact: line.rateImpact.toNumber(),
      })),
    },
    journalEntries: journalEntries.map((entry) => ({
      type: entry.type,
      entityId: entry.entityId,
      period: entry.period,
      lines: entry.lines.map((line) => ({
        accountId: line.accountId,
        debit: line.debit.toNumber(),
        credit: line.credit.toNumber(),
        memo: line.memo,
      })),
      totalDebit: entry.totalDebit.toNumber(),
      totalCredit: entry.totalCredit.toNumber(),
    })),
    lineItems: {
      permanentDifferences: input.permanentDifferences.map((pd) => ({ label: pd.label, amount: pd.amount })),
      temporaryDifferences: input.temporaryDifferences.map((d) => ({
        accountId: d.accountId,
        difference: d.difference,
        timingCategory: d.timingCategory ?? 'TEMP_OTHER',
      })),
    },
  };
}

function money(value: number | string) {
  const decimal = new Decimal(value ?? 0);
  if (!decimal.isFinite()) throw new Error(`Invalid monetary value: ${value}`);
  return decimal;
}

function rate(value: number | string) {
  const decimal = money(value);
  if (decimal.isNegative() || decimal.greaterThan(1)) throw new Error(`Invalid tax rate: ${value}`);
  return decimal;
}

function decimalRecordToNumber(record: Record<string, ReturnType<typeof money>>) {
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, value.toNumber()]));
}
