import Decimal from 'decimal.js';
import type { USD, TaxRate } from '../types.js';

/**
 * UK capital allowances (CAA 2001) for FRS 102 Section 29 timing differences.
 *
 * Replaces the US MACRS path for UK fixed-asset categories:
 * - Annual Investment Allowance (AIA): 100% on qualifying plant & machinery
 *   up to £1,000,000 per 12-month chargeable period (permanent from Apr 2023).
 * - Full expensing: 100% first-year allowance on NEW & UNUSED main-rate
 *   plant & machinery (permanent from Autumn Statement 2023); 50% first-year
 *   allowance for new & unused special-rate plant & machinery.
 * - Writing-down allowances (reducing balance): main pool 18%, special-rate
 *   pool 6%. Structures & buildings allowance (SBA): 3% straight-line.
 * - Small pools allowance: pools of £1,000 or less may be written off in full.
 *
 * Cars, gifted assets, and connected-party quirks are NOT modelled — such
 * accounts must resolve to a review item upstream, never to a guessed rate.
 */

export const UK_AIA_ANNUAL_LIMIT: USD = new Decimal('1000000');
export const UK_MAIN_POOL_WDA_RATE: TaxRate = new Decimal('0.18');
export const UK_SPECIAL_POOL_WDA_RATE: TaxRate = new Decimal('0.06');
export const UK_SBA_RATE: TaxRate = new Decimal('0.03');
export const UK_FULL_EXPENSING_RATE: TaxRate = new Decimal('1');
export const UK_SPECIAL_FIRST_YEAR_RATE: TaxRate = new Decimal('0.5');
export const UK_SMALL_POOLS_LIMIT: USD = new Decimal('1000');

export type UkAllowancePool = 'main' | 'special' | 'sba';

export interface UkCapitalAllowanceInput {
  /** Qualifying additions in the period. */
  qualifyingExpenditure: USD;
  pool?: UkAllowancePool;
  /** Opening written-down value brought forward. */
  priorWrittenDownValue?: USD;
  /** Disposal proceeds deducted from the pool in the period. */
  disposals?: USD;
  /** Claim AIA on qualifying expenditure (default true, capped at the limit). */
  claimAIA?: boolean;
  /** AIA cap for the chargeable period (default £1,000,000). */
  aiaLimit?: USD;
  /** Claim full expensing / 50% SR allowance (default false = conservative). */
  claimFullExpensing?: boolean;
  /** Full expensing requires new & unused assets (default false). */
  isNewAndUnused?: boolean;
}

export interface UkCapitalAllowanceResult {
  firstYearAllowance: USD;
  writingDownAllowance: USD;
  totalAllowance: USD;
  closingWrittenDownValue: USD;
  pool: UkAllowancePool;
  aiaUsed: USD;
  notes: string[];
}

const zero = () => new Decimal(0);

export function calculateUkCapitalAllowance(input: UkCapitalAllowanceInput): UkCapitalAllowanceResult {
  const pool = input.pool ?? 'main';
  const expenditure = input.qualifyingExpenditure ?? zero();
  const priorWDV = input.priorWrittenDownValue ?? zero();
  const disposals = input.disposals ?? zero();
  if (expenditure.isNegative() || priorWDV.isNegative() || disposals.isNegative()) {
    throw new Error('Capital allowance inputs cannot be negative');
  }
  const notes: string[] = [];

  // ── Structures & buildings: 3% straight-line, no first-year reliefs ──
  if (pool === 'sba') {
    const base = priorWDV.plus(expenditure).minus(disposals);
    const allowance = base.greaterThan(0) ? base.mul(UK_SBA_RATE) : zero();
    notes.push('SBA at 3% straight-line; AIA and full expensing do not apply');
    return finish(pool, zero(), allowance, base.minus(allowance), zero(), notes);
  }

  // ── Plant & machinery pools ──
  const aiaLimit = input.aiaLimit ?? UK_AIA_ANNUAL_LIMIT;
  const claimAIA = input.claimAIA ?? true;
  const aiaUsed = claimAIA ? Decimal.min(expenditure, aiaLimit) : zero();
  if (claimAIA && expenditure.greaterThan(aiaLimit)) {
    notes.push(`AIA capped at £${aiaLimit.toNumber().toLocaleString()}; excess falls to first-year/pool relief`);
  }
  const remainder = expenditure.minus(aiaUsed);

  const claimFE = input.claimFullExpensing ?? false;
  const isNew = input.isNewAndUnused ?? false;
  let firstYear = zero();
  if (claimFE && isNew && remainder.greaterThan(0)) {
    const feRate = pool === 'main' ? UK_FULL_EXPENSING_RATE : UK_SPECIAL_FIRST_YEAR_RATE;
    firstYear = remainder.mul(feRate);
    notes.push(pool === 'main' ? 'Full expensing at 100% (new & unused main-rate)' : 'Special-rate first-year allowance at 50% (new & unused)');
  } else if (claimFE && !isNew && remainder.greaterThan(0)) {
    notes.push('Full expensing not claimed: assets are not new & unused — remainder enters the pool');
  }

  let poolBalance = priorWDV.plus(remainder).minus(firstYear).minus(disposals);
  if (poolBalance.isNegative()) {
    notes.push('Disposals exceed pool balance — balancing charge territory; pool floored at nil for provision purposes');
    poolBalance = zero();
  }

  const wdaRate = pool === 'main' ? UK_MAIN_POOL_WDA_RATE : UK_SPECIAL_POOL_WDA_RATE;
  let wda = poolBalance.mul(wdaRate);
  let closing = poolBalance.minus(wda);

  // Small pools allowance: write off pools of £1,000 or less in full.
  if (closing.greaterThan(0) && closing.lessThanOrEqualTo(UK_SMALL_POOLS_LIMIT)) {
    notes.push('Small pools allowance: remaining pool of £1,000 or less written off in full');
    wda = wda.plus(closing);
    closing = zero();
  }

  return finish(pool, aiaUsed.plus(firstYear), wda, closing, aiaUsed, notes);
}

function finish(
  pool: UkAllowancePool,
  firstYearAllowance: USD,
  writingDownAllowance: USD,
  closingWrittenDownValue: USD,
  aiaUsed: USD,
  notes: string[],
): UkCapitalAllowanceResult {
  return {
    firstYearAllowance,
    writingDownAllowance,
    totalAllowance: firstYearAllowance.plus(writingDownAllowance),
    closingWrittenDownValue,
    pool,
    aiaUsed,
    notes,
  };
}
