// ── Core domain types for the tax engine ──
// All monetary values use Decimal for audit-safe fixed-point arithmetic.

import Decimal from 'decimal.js';

export type USD = Decimal;
export type TaxRate = Decimal;
export type Ratio = Decimal;
export type Years = number;

export interface TaxRateConfig {
  rateTableSource: 'IRS' | 'HMRC';
}

export interface Entity {
  id: string;
  name: string;
  currency: string;
  taxJurisdiction: Jurisdiction;
  parentEntityId?: string;
  taxRate: TaxRate;
  stateTaxRate?: TaxRate;
}

export interface Account {
  id: string;
  accountNumber: string;
  name: string;
  type: 'Income' | 'Expense' | 'Asset' | 'Liability' | 'Equity';
  placedInServiceDate?: string;
}

export interface TrialBalanceLine {
  entityId: string;
  accountId: string;
  period: string;
  balance: USD;
  placedInServiceDate?: string;
  assetAgeYears?: number;
}

export enum Jurisdiction {
  US_ASC740 = 'US_ASC740',
  UK_FRS102_S29 = 'UK_FRS102_S29',
}

export type TaxAccountTypeUS =
  | 'PERM_MEALS_ENTERTAINMENT'
  | 'PERM_PENALTIES_FINES'
  | 'PERM_DIVIDENDS_RECEIVED_DEDUCTION'
  | 'PERM_LIFE_INSURANCE'
  | 'PERM_TAX_EXEMPT_INTEREST'
  | 'PERM_NONDEDUCTIBLE_GOODWILL'
  | 'PERM_OTHER'
  | 'TEMP_DEPRECIATION'
  | 'TEMP_AMORTIZATION'
  | 'TEMP_ACCELERATED_DEPRECIATION'
  | 'TEMP_BONUS_DEPRECIATION'
  | 'TEMP_SECTION_179'
  | 'TEMP_RESEARCH_CREDIT'
  | 'TEMP_BAD_DEBT_RESERVE'
  | 'TEMP_INVENTORY_RESERVE'
  | 'TEMP_WARRANTY_RESERVE'
  | 'TEMP_DEFERRED_REVENUE'
  | 'TEMP_ACCRUED_LIABILITIES'
  | 'TEMP_PENSION'
  | 'TEMP_NOL_CARRYFORWARD'
  | 'TEMP_TAX_CREDIT_CARRYFORWARD'
  | 'TEMP_OTHER'
  | 'NODIFF_CASH'
  | 'NODIFF_AR'
  | 'NODIFF_AP'
  | 'NODIFF_REVENUE'
  | 'NODIFF_SALARIES'
  | 'NODIFF_RENT'
  | 'NODIFF_UTILITIES'
  | 'NODIFF_OTHER';

export type TaxAccountTypeUK =
  | 'TEMP_TIMING_DIFFERENCE'
  | 'TEMP_UNRELIEVED_LOSS'
  | 'TEMP_FIXED_ASSET_ALLOWANCE'
  | 'PERM_OTHER'
  | 'NODIFF_OTHER';

export type TaxAccountType = TaxAccountTypeUS | TaxAccountTypeUK;

export interface TaxMapping {
  accountId: string;
  taxAccountType: TaxAccountType;
  bookTreatment: 'permanent' | 'temporary' | 'no_diff';
  timingCategory?: 'deductible_temporary' | 'taxable_temporary';
  confidenceScore: Ratio;
}

export interface BookTaxDifference {
  accountId: string;
  entityId: string;
  period: string;
  bookBalance: USD;
  taxBalance: USD;
  difference: USD;
  diffType: 'permanent' | 'temporary' | 'no_diff';
  timingCategory?: string;
  reversalPeriod?: string;
  depreciationAgeSource?: 'placed_in_service' | 'explicit_age' | 'assumed_first_year' | 'no_metadata';
  assetAgeYears?: number;
}

export interface PermanentDifferenceItem {
  amount: USD;
  label: string;
}

export interface CurrentTaxInput {
  bookIncome: USD;
  permanentDifferences: PermanentDifferenceItem[];
  taxRate: TaxRate;
  stateTaxRate?: TaxRate;
  taxCredits: USD;
  estimatedPayments: USD;
  nolUtilization: USD;
  asOfDate: string;
}

export interface CurrentTaxResult {
  bookIncome: USD;
  totalPermanentAdjustments: USD;
  taxableIncome: USD;
  federalTaxRate: TaxRate;
  federalTax: USD;
  stateTax: USD;
  totalTaxBeforeCredits: USD;
  taxCredits: USD;
  nolUtilization: USD;
  totalTaxAfterCredits: USD;
  estimatedPayments: USD;
  taxPayable: USD;
  effectiveTaxRate: TaxRate;
  /** UK only: marginal relief deducted between the small profits and upper limits (else 0). */
  marginalRelief?: USD;
}

export interface DeferredTaxInput {
  entityId: string;
  timingCategory: string;
  openingDTA: USD;
  openingDTL: USD;
  currentYearTemporaryChange: USD;
  taxRate: TaxRate;
  dtType: 'DTA' | 'DTL';
  probableRecovery?: boolean;
  jurisdiction: Jurisdiction;
}

export interface DeferredTaxLine {
  timingCategory: string;
  openingBalance: USD;
  currentYearChange: USD;
  taxRate: TaxRate;
  deferredTaxAmount: USD;
  reversals: USD;
  closingBalance: USD;
  dtType: 'DTA' | 'DTL';
  /**
   * P1: set when the input difference sign contradicts the bucket direction
   * (deductible buckets expect ≤ 0, taxable buckets expect ≥ 0). The amount
   * is still recognised by magnitude; the note tells the reviewer to confirm
   * the mapping rather than silently accepting it.
   */
  directionNote?: string;
}

export interface DeferredTaxResult {
  lines: DeferredTaxLine[];
  totalOpeningDTA: USD;
  totalOpeningDTL: USD;
  totalClosingDTA: USD;
  totalClosingDTL: USD;
  netDeferredTaxExpense: USD;
}

export interface RollforwardInput {
  priorYear: {
    deferredTaxLines: DeferredTaxLine[];
    valuationAllowance: USD;
    nolCarryforward: USD;
    taxCreditCarryforward: USD;
  };
  currentYear: {
    temporaryDifferences: BookTaxDifference[];
    nolUtilized: USD;
    nolGenerated: USD;
    creditsUtilized: USD;
    creditsGenerated: USD;
    valuationAllowanceChange: USD;
    taxRateChanges: { category: string; oldRate: TaxRate; newRate: TaxRate }[];
  };
}

export interface RollforwardResult {
  deferredTaxRollforward: DeferredTaxLine[];
  nolRollforward: { opening: USD; generated: USD; utilized: USD; closing: USD };
  creditRollforward: { opening: USD; generated: USD; utilized: USD; closing: USD };
  valuationAllowance: { opening: USD; change: USD; closing: USD };
}

export interface ETRInput {
  bookIncome: USD;
  federalTaxRate: TaxRate;
  federalTax: USD;
  stateTax: USD;
  permanentDifferences: PermanentDifferenceItem[];
  taxCredits: USD;
  otherAdjustments: PermanentDifferenceItem[];
  /**
   * P1: optional jurisdiction for UK-safe rendering. When UK_FRS102_S29,
   * calculateETR() suppresses the US state-benefit line and labels the
   * statutory line as the UK main rate. Omitted = legacy US behaviour.
   */
  jurisdiction?: Jurisdiction;
}

export interface ETRLine {
  description: string;
  amount: USD;
  taxImpact: USD;
  rateImpact: TaxRate;
}

export interface ETRResult {
  statutoryRate: TaxRate;
  statutoryTax: USD;
  lines: ETRLine[];
  totalTaxExpense: USD;
  effectiveTaxRate: TaxRate;
}

export interface JournalEntryLine {
  accountId: string;
  debit: USD;
  credit: USD;
  memo: string;
}

export interface JournalEntry {
  type: 'current_tax' | 'deferred_tax' | 'valuation_allowance';
  entityId: string;
  period: string;
  lines: JournalEntryLine[];
  totalDebit: USD;
  totalCredit: USD;
}

export interface ProvisionSummary {
  period: string;
  entityId: string;
  bookIncome: USD;
  currentTax: CurrentTaxResult;
  deferredTax: DeferredTaxResult;
  rollforward: RollforwardResult;
  etr: ETRResult;
  journalEntries: JournalEntry[];
}

// ── Input validation helpers ──

export function validatePositive(label: string, value: USD): void {
  if (value.isNegative()) {
    throw new Error(`${label} cannot be negative. Got: ${value.toString()}`);
  }
}

export function validateNonZero(label: string, value: USD): void {
  if (value.isZero()) {
    throw new Error(`${label} cannot be zero.`);
  }
}

export function validateRate(label: string, rate: TaxRate): void {
  if (rate.isNegative() || rate.greaterThan(1)) {
    throw new Error(`${label} must be between 0 and 1. Got: ${rate.toString()}`);
  }
}
