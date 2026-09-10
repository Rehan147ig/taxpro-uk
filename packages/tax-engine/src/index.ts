// ── Tax Engine — Pure ASC 740 / FRS 102 Calculation Logic ──

export { default as Decimal } from 'decimal.js';
export * from './types.js';
export * from './constants.js';
export { calculateCurrentTax } from './current-tax.js';
export { calculateDeferredTax, calculateDeferredTaxLine } from './deferred-tax.js';
export { computeBookTaxDifferences } from './book-tax-diff.js';
export { generateRollforward } from './rollforward.js';
export { calculateETR } from './etr-reconciliation.js';
export { generateJournalEntries } from './journal-entries.js';
export { calculateUkDeferredTax, ukDeferredTaxLine } from './uk-frs102-s29/deferred-tax.js';
export { calculateUkCurrentTax } from './uk-frs102-s29/current-tax.js';
export {
  getRateForFiscalYear,
  calculateUkMarginalRelief,
  getUkMarginalReliefConfig,
  etrAdjustmentsForMarginalRelief,
  UK_SMALL_PROFITS_RATE,
  UK_SMALL_PROFITS_THRESHOLD,
  UK_MARGINAL_RELIEF_UPPER,
  UK_MARGINAL_RELIEF_FRACTION,
} from './uk-frs102-s29/rules.js';
export {
  calculateUkCapitalAllowance,
  UK_AIA_ANNUAL_LIMIT,
  UK_MAIN_POOL_WDA_RATE,
  UK_SPECIAL_POOL_WDA_RATE,
  UK_SBA_RATE,
  UK_FULL_EXPENSING_RATE,
  UK_SPECIAL_FIRST_YEAR_RATE,
  UK_SMALL_POOLS_LIMIT,
} from './uk-frs102-s29/capital-allowances.js';
export type { UkAllowancePool, UkCapitalAllowanceInput, UkCapitalAllowanceResult } from './uk-frs102-s29/capital-allowances.js';
export {
  ukFiscalYearOf,
  splitPeriodByUkFiscalYear,
  blendedUkMainRate,
  apportionUkProfitLimitForShortPeriod,
} from './uk-frs102-s29/fiscal-years.js';
export type { UkFiscalYearSlice } from './uk-frs102-s29/fiscal-years.js';
export { remeasureUkDeferredTaxBalance, directionNoteFor } from './uk-frs102-s29/deferred-tax.js';
export { Jurisdiction } from './types.js';
export { createEngine } from './engine-factory.js';
export type { TaxEngine } from './engine-factory.js';
