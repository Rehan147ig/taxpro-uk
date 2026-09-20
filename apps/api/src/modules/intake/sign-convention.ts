import Decimal from 'decimal.js';
import type { NormalizedRow } from './validate.js';

/**
 * Sign-convention detection (Feature 2).
 *
 * Some systems export revenue as negative / expenses as positive (or vice
 * versa). Debit/credit control totals still balance, so validate.ts cannot
 * catch it — yet the engine would silently compute the wrong tax. This is a
 * purely deterministic check (no AI, never auto-applied): it classifies a
 * batch and surfaces INVERTED / MIXED as review items for a human to decide.
 *
 * Standard UK convention, with balances stored debit-positive
 * (balance = debit − credit):
 *   Income, Equity, Liability → credit-natured totals (negative)
 *   Expense, Asset            → debit-natured totals (positive)
 */

// Mirror CONTROL_TOLERANCE in validate.ts: per-type totals within £1 of
// zero carry no signal and never drive a classification.
export const SIGN_TOLERANCE = 1.0;

export const CREDIT_NATURED_TYPES = ['Income', 'Equity', 'Liability'] as const;
export const DEBIT_NATURED_TYPES = ['Expense', 'Asset'] as const;
const CREDIT_NATURED = new Set<string>(CREDIT_NATURED_TYPES);
const DEBIT_NATURED = new Set<string>(DEBIT_NATURED_TYPES);

export type SignClassification = 'standard' | 'inverted' | 'mixed';

export interface AccountTypeSignTotal {
  accountType: string;
  /** Exact decimal string (Decimal.js) — audit-safe. */
  total: string;
  expected: 'debit' | 'credit';
  observed: 'debit' | 'credit' | 'zero';
  inverted: boolean;
}

export interface SignConventionReport {
  classification: SignClassification;
  code: 'SIGN_CONVENTION_OK' | 'SIGN_CONVENTION_INVERTED' | 'SIGN_CONVENTION_MIXED';
  /** error blocks commit until a reviewer confirms; warning never blocks. */
  severity: 'none' | 'error' | 'warning';
  totals: AccountTypeSignTotal[];
  /** Account types with a non-trivial total (the evidence base). */
  signalTypes: number;
  message: string;
}

/**
 * Aggregate signed balances by accountType and classify the batch.
 *
 * Guards against false positives by construction:
 * - empty input → standard (no crash, no signal);
 * - fewer than two account types with non-trivial totals → standard
 *   (a single-type TB cannot show a convention, so it never blocks).
 */
export function detectSignConvention(rows: NormalizedRow[]): SignConventionReport {
  const sums = new Map<string, Decimal>();
  for (const row of rows) {
    const amount = toDecimal(row.balance);
    sums.set(row.accountType, (sums.get(row.accountType) ?? new Decimal(0)).plus(amount));
  }

  const tolerance = new Decimal(SIGN_TOLERANCE);
  const totals: AccountTypeSignTotal[] = [];
  for (const [accountType, total] of [...sums.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    // Unknown type strings (shouldn't happen — validate.ts normalises to the
    // five known types) carry no convention signal and are excluded.
    if (!CREDIT_NATURED.has(accountType) && !DEBIT_NATURED.has(accountType)) continue;
    const expected = CREDIT_NATURED.has(accountType) ? 'credit' : 'debit';
    const observed = total.abs().lte(tolerance) ? 'zero' : total.gt(0) ? 'debit' : 'credit';
    totals.push({
      accountType,
      total: total.toString(),
      expected,
      observed,
      inverted: observed !== 'zero' && observed !== expected,
    });
  }

  const signal = totals.filter((t) => t.observed !== 'zero');
  const messageFor = (classification: SignClassification) => {
    const parts = totals.map((t) => `${t.accountType} ${t.total} (expected ${t.expected})`);
    if (classification === 'standard') return `Sign convention standard (${signal.length} signalling type(s)): ${parts.join('; ') || 'no balances'}.`;
    if (classification === 'inverted') {
      return `Sign convention fully inverted: every signalling account type has the opposite sign (${parts.join('; ')}). Confirm the inversion to commit with corrected signs, or reject and fix the source file.`;
    }
    const bad = totals.filter((t) => t.inverted).map((t) => t.accountType);
    return `Sign convention mixed: ${bad.join(', ')} ha(s)ve the opposite sign (${parts.join('; ')}). Check which subset is wrong before committing.`;
  };

  if (signal.length < 2) {
    return {
      classification: 'standard',
      code: 'SIGN_CONVENTION_OK',
      severity: 'none',
      totals,
      signalTypes: signal.length,
      message: messageFor('standard'),
    };
  }

  const invertedCount = signal.filter((t) => t.inverted).length;
  if (invertedCount === 0) {
    return { classification: 'standard', code: 'SIGN_CONVENTION_OK', severity: 'none', totals, signalTypes: signal.length, message: messageFor('standard') };
  }
  if (invertedCount === signal.length) {
    return { classification: 'inverted', code: 'SIGN_CONVENTION_INVERTED', severity: 'error', totals, signalTypes: signal.length, message: messageFor('inverted') };
  }
  return { classification: 'mixed', code: 'SIGN_CONVENTION_MIXED', severity: 'warning', totals, signalTypes: signal.length, message: messageFor('mixed') };
}

/**
 * The reviewer-confirmed correction: multiply every amount of every row by
 * −1 (Decimal-exact, so applying twice reproduces the input exactly).
 * balance = debit − credit is preserved by construction.
 */
export function applySignInversion(rows: NormalizedRow[]): NormalizedRow[] {
  return rows.map((row) => ({
    ...row,
    debit: negate(row.debit),
    credit: negate(row.credit),
    balance: negate(row.balance),
  }));
}

/** Per-type totals of a row set, as exact decimal strings (for audit events). */
export function signTotalsByType(rows: NormalizedRow[]): Record<string, string> {
  const sums = new Map<string, Decimal>();
  for (const row of rows) {
    sums.set(row.accountType, (sums.get(row.accountType) ?? new Decimal(0)).plus(toDecimal(row.balance)));
  }
  return Object.fromEntries([...sums.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, v.toString()]));
}

function toDecimal(value: number | string | null | undefined): Decimal {
  if (value === null || value === undefined || value === '') return new Decimal(0);
  try {
    const d = new Decimal(value);
    return d.isFinite() ? d : new Decimal(0);
  } catch {
    return new Decimal(0);
  }
}

function negate(value: number): number {
  return toDecimal(value).negated().toNumber();
}
