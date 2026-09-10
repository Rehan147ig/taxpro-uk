import Decimal from 'decimal.js';
import type { DeferredTaxInput, DeferredTaxLine, DeferredTaxResult, BookTaxDifference, USD, TaxRate } from '../types.js';
import { Jurisdiction } from '../types.js';
import { checkProbableRecovery, shouldDiscount, applyTimingDifferenceLabel, getRateForFiscalYear, UK_RATES_BY_FISCAL_YEAR } from './rules.js';
import { validateRate, validatePositive } from '../types.js';
import { aggregateByCategory } from '../deferred-tax.js';

export function ukDeferredTaxLine(input: DeferredTaxInput): DeferredTaxLine {
  validateRate('taxRate', input.taxRate);
  validatePositive('openingDTA', input.openingDTA);
  validatePositive('openingDTL', input.openingDTL);

  const recovery = checkProbableRecovery(Jurisdiction.UK_FRS102_S29, input.probableRecovery, input.dtType);
  if (!recovery.allowed) {
    return {
      timingCategory: applyTimingDifferenceLabel(input.timingCategory, Jurisdiction.UK_FRS102_S29),
      openingBalance: new Decimal(0),
      currentYearChange: new Decimal(0),
      taxRate: input.taxRate,
      deferredTaxAmount: new Decimal(0),
      reversals: new Decimal(0),
      closingBalance: new Decimal(0),
      dtType: input.dtType,
    };
  }

  const discountFactor = shouldDiscount(input.jurisdiction)
    ? new Decimal(1).div(new Decimal(1.05).pow(1))
    : new Decimal(1);
  const grossDeferred: USD = input.currentYearTemporaryChange.abs().mul(input.taxRate);
  const deferredTaxAmount: USD = grossDeferred.mul(discountFactor);
  const openingBalance: USD = input.dtType === 'DTA' ? input.openingDTA : input.openingDTL;
  const closingBalance: USD = openingBalance.plus(deferredTaxAmount);

  const label = applyTimingDifferenceLabel(input.timingCategory, Jurisdiction.UK_FRS102_S29);

  return {
    timingCategory: label,
    openingBalance,
    currentYearChange: input.currentYearTemporaryChange,
    taxRate: input.taxRate,
    deferredTaxAmount,
    reversals: new Decimal(0),
    closingBalance,
    dtType: input.dtType,
    directionNote: directionNoteFor(input.currentYearTemporaryChange, input.dtType),
  };
}

/**
 * Remeasure a recognised deferred-tax balance when the substantively-enacted
 * rate changes (FRS 102 29.27 disclosure). The underlying timing difference
 * is recovered from the old rate, re-rated, and the P&L adjustment returned.
 */
export function remeasureUkDeferredTaxBalance(
  balance: USD,
  oldRate: TaxRate,
  newRate: TaxRate,
): { timingDifference: USD; newBalance: USD; adjustment: USD } {
  validateRate('oldRate', oldRate);
  validateRate('newRate', newRate);
  if (oldRate.isZero()) {
    throw new Error('Cannot remeasure a balance recognised at a nil rate — re-establish the underlying timing difference first');
  }
  const timingDifference = balance.div(oldRate);
  const newBalance = timingDifference.mul(newRate);
  return { timingDifference, newBalance, adjustment: newBalance.minus(balance) };
}

/**
 * Magnitude recognition with direction honesty: deductible (DTA) buckets
 * expect non-positive differences, taxable (DTL) buckets non-negative.
 * Returns a reviewer note when the sign contradicts the bucket, else undefined.
 * Amounts are unaffected — recognition stays by magnitude.
 */
export function directionNoteFor(difference: USD, dtType: 'DTA' | 'DTL'): string | undefined {
  if (difference.isZero()) return undefined;
  const contradicts = dtType === 'DTA' ? difference.isPositive() : difference.isNegative();
  if (!contradicts) return undefined;
  return `Unexpected ${difference.isPositive() ? 'positive' : 'negative'} movement in a ${dtType} bucket — recognised by magnitude; confirm the mapping and timing direction`;
}

export function calculateUkDeferredTax(
  temporaryDifferences: BookTaxDifference[],
  priorYearDTAByCategory: Record<string, USD>,
  priorYearDTLByCategory: Record<string, USD>,
  taxRates: Record<string, TaxRate>,
  probableRecoveryMap?: Record<string, boolean>,
  asOfDate?: string,
): DeferredTaxResult {
  const lines: DeferredTaxLine[] = [];

  const fiscalYear = asOfDate ? asOfDate.slice(0, 4) : new Date().getFullYear().toString();
  const defaultRate = getRateForFiscalYear('UK_FRS102_S29', fiscalYear, taxRates, UK_RATES_BY_FISCAL_YEAR);

  for (const diff of temporaryDifferences) {
    if (diff.diffType !== 'temporary') continue;

    const cat = diff.timingCategory ?? 'TEMP_TIMING_DIFFERENCE';
    const ukCat = cat.replace(/temporary/gi, 'timing');
    const isDeductible = cat === 'deductible_temporary' || ukCat === 'deductible_timing';
    const dtType: 'DTA' | 'DTL' = isDeductible ? 'DTA' : 'DTL';

    const taxRate: TaxRate = getRateForFiscalYear('UK_FRS102_S29', fiscalYear, taxRates, UK_RATES_BY_FISCAL_YEAR, cat);
    validateRate(`taxRates.${cat}`, taxRate);

    const opening: USD = isDeductible
      ? (priorYearDTAByCategory[cat] ?? new Decimal(0))
      : (priorYearDTLByCategory[cat] ?? new Decimal(0));

    const probableRecovery = probableRecoveryMap?.[cat] ?? true;
    const recovery = checkProbableRecovery(Jurisdiction.UK_FRS102_S29, probableRecovery, dtType);
    if (!recovery.allowed) {
      lines.push({
        timingCategory: applyTimingDifferenceLabel(ukCat, Jurisdiction.UK_FRS102_S29),
        openingBalance: opening,
        currentYearChange: new Decimal(0),
        taxRate,
        deferredTaxAmount: new Decimal(0),
        reversals: new Decimal(0),
        closingBalance: opening,
        dtType,
      });
      continue;
    }

    const deferredTaxAmount: USD = diff.difference.abs().mul(taxRate);
    const closingBalance: USD = opening.plus(deferredTaxAmount);

    lines.push({
      timingCategory: applyTimingDifferenceLabel(ukCat, Jurisdiction.UK_FRS102_S29),
      openingBalance: opening,
      currentYearChange: diff.difference,
      taxRate,
      deferredTaxAmount,
      reversals: new Decimal(0),
      closingBalance,
      dtType,
      directionNote: directionNoteFor(diff.difference, dtType),
    });
  }

  const aggregated = aggregateByCategory(lines);

  const totalOpeningDTA: USD = aggregated
    .filter(l => l.dtType === 'DTA')
    .reduce((s, l) => s.plus(l.openingBalance), new Decimal(0));
  const totalOpeningDTL: USD = aggregated
    .filter(l => l.dtType === 'DTL')
    .reduce((s, l) => s.plus(l.openingBalance), new Decimal(0));
  const totalClosingDTA: USD = aggregated
    .filter(l => l.dtType === 'DTA')
    .reduce((s, l) => s.plus(l.closingBalance), new Decimal(0));
  const totalClosingDTL: USD = aggregated
    .filter(l => l.dtType === 'DTL')
    .reduce((s, l) => s.plus(l.closingBalance), new Decimal(0));

  const dtaChange: USD = totalClosingDTA.minus(totalOpeningDTA);
  const dtlChange: USD = totalClosingDTL.minus(totalOpeningDTL);
  const netDeferredTaxExpense: USD = dtlChange.minus(dtaChange);

  return {
    lines: aggregated,
    totalOpeningDTA,
    totalOpeningDTL,
    totalClosingDTA,
    totalClosingDTL,
    netDeferredTaxExpense,
  };
}
