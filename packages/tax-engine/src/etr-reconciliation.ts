import Decimal from 'decimal.js';
import type { ETRInput, ETRResult, ETRLine, USD, TaxRate } from './types.js';
import { validateRate, validatePositive } from './types.js';

/**
 * ASC 740-270: Effective Tax Rate reconciliation.
 * P1 UK-safe: pass jurisdiction UK_FRS102_S29 to suppress the US
 * state-benefit line and label the statutory line as the UK main rate.
 * Legacy callers omitting jurisdiction keep exact US behaviour.
 */
export function calculateETR(input: ETRInput): ETRResult {
  validateRate('federalTaxRate', input.federalTaxRate);
  validatePositive('taxCredits', input.taxCredits);

  const isUk = (input as { jurisdiction?: string }).jurisdiction === 'UK_FRS102_S29';
  const lines: ETRLine[] = [];
  const bookIncome: USD = input.bookIncome;

  const statutoryTax: USD = bookIncome.mul(input.federalTaxRate);
  lines.push({
    description: isUk
      ? `UK main rate (${input.federalTaxRate.mul(100).toFixed(2)}%)`
      : `Federal statutory rate (${input.federalTaxRate.mul(100).toFixed(0)}%)`,
    amount: statutoryTax,
    taxImpact: statutoryTax,
    rateImpact: input.federalTaxRate,
  });

  for (const pd of input.permanentDifferences) {
    const taxImpact: USD = pd.amount.mul(input.federalTaxRate);
    const rateImpact: TaxRate = bookIncome.greaterThan(0)
      ? pd.amount.div(bookIncome).mul(input.federalTaxRate)
      : new Decimal(0);
    lines.push({
      description: pd.label,
      amount: pd.amount,
      taxImpact,
      rateImpact,
    });
  }

  if (input.stateTax.greaterThan(0) && !isUk) {
    const stateNetOfFederal: USD = input.stateTax.mul(new Decimal(1).minus(input.federalTaxRate));
    const rateImpact: TaxRate = bookIncome.greaterThan(0)
      ? stateNetOfFederal.div(bookIncome)
      : new Decimal(0);
    lines.push({
      description: 'State income taxes (net of federal benefit)',
      amount: input.stateTax,
      taxImpact: stateNetOfFederal,
      rateImpact,
    });
  }

  if (input.taxCredits.greaterThan(0)) {
    const rateImpact: TaxRate = bookIncome.greaterThan(0)
      ? input.taxCredits.negated().div(bookIncome)
      : new Decimal(0);
    lines.push({
      description: 'Tax credits',
      amount: input.taxCredits.negated(),
      taxImpact: input.taxCredits.negated(),
      rateImpact,
    });
  }

  for (const adj of input.otherAdjustments) {
    const rateImpact: TaxRate = bookIncome.greaterThan(0)
      ? adj.amount.div(bookIncome)
      : new Decimal(0);
    lines.push({
      description: adj.label,
      amount: adj.amount,
      taxImpact: adj.amount,
      rateImpact,
    });
  }

  const totalTaxExpense: USD = lines.reduce((sum, l) => sum.plus(l.taxImpact), new Decimal(0));
  const effectiveTaxRate: TaxRate = bookIncome.greaterThan(0)
    ? totalTaxExpense.div(bookIncome)
    : new Decimal(0);

  return {
    statutoryRate: input.federalTaxRate,
    statutoryTax,
    lines,
    totalTaxExpense,
    effectiveTaxRate,
  };
}
