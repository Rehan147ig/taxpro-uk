import { describe, it, expect } from 'vitest';
import Decimal from 'decimal.js';
import {
  detectSignConvention,
  applySignInversion,
  signTotalsByType,
  SIGN_TOLERANCE,
} from './sign-convention.js';
import type { NormalizedRow } from './validate.js';

function row(
  accountName: string,
  accountType: string,
  debit: number,
  credit: number,
  balance: number,
): NormalizedRow {
  return {
    entityName: 'Acme UK Ltd',
    entityExternalId: 'acme-uk',
    accountName,
    accountNumber: '',
    accountExternalId: accountName,
    accountType,
    detailType: accountType,
    period: '2026-03-31',
    periodEnd: '2026-03-31',
    debit,
    credit,
    balance,
    currency: 'GBP',
  };
}

/** Standard UK convention: Income/Equity/Liability credit-natured, Expense/Asset debit-natured. */
function standardRows(): NormalizedRow[] {
  return [
    row('Sales revenue', 'Income', 0, 48000, -48000),
    row('Salaries', 'Expense', 20000, 0, 20000),
    row('Office rent', 'Expense', 12000, 0, 12000),
    row('Cash', 'Asset', 50000, 0, 50000),
    row('Trade payables', 'Liability', 0, 30000, -30000),
    row('Share capital', 'Equity', 0, 40000, -40000),
  ];
}

function negateRows(rows: NormalizedRow[]): NormalizedRow[] {
  return rows.map((r) => ({ ...r, debit: -r.debit, credit: -r.credit, balance: -r.balance }));
}

describe('sign-convention detection (pure, deterministic)', () => {
  it('passes a standard-convention TB silently', () => {
    const report = detectSignConvention(standardRows());
    expect(report.classification).toBe('standard');
    expect(report.code).toBe('SIGN_CONVENTION_OK');
    expect(report.severity).toBe('none');
    expect(report.signalTypes).toBe(5);
  });

  it('flags a fully inverted TB with INVERTED (error)', () => {
    const report = detectSignConvention(negateRows(standardRows()));
    expect(report.classification).toBe('inverted');
    expect(report.code).toBe('SIGN_CONVENTION_INVERTED');
    expect(report.severity).toBe('error');
    expect(report.totals.filter((t) => t.inverted)).toHaveLength(5);
  });

  it('flags a TB where only revenue is inverted as MIXED (warning)', () => {
    const rows = standardRows().map((r) =>
      r.accountType === 'Income' ? { ...r, debit: 48000, credit: 0, balance: 48000 } : r,
    );
    const report = detectSignConvention(rows);
    expect(report.classification).toBe('mixed');
    expect(report.code).toBe('SIGN_CONVENTION_MIXED');
    expect(report.severity).toBe('warning');
    expect(report.totals.find((t) => t.accountType === 'Income')?.inverted).toBe(true);
    expect(report.totals.find((t) => t.accountType === 'Expense')?.inverted).toBe(false);
  });

  it('does not crash on an empty TB', () => {
    const report = detectSignConvention([]);
    expect(report.classification).toBe('standard');
    expect(report.signalTypes).toBe(0);
  });

  it('does not false-positive on single-account-type TBs', () => {
    const onlyExpense = [row('Rent', 'Expense', 1000, 0, 1000)];
    expect(detectSignConvention(onlyExpense).classification).toBe('standard');
    // Even when the lone type has the "wrong" sign — one type is not a convention.
    const onlyExpenseNegative = [row('Rent', 'Expense', 0, 1000, -1000)];
    expect(detectSignConvention(onlyExpenseNegative).classification).toBe('standard');
    expect(detectSignConvention(onlyExpenseNegative).signalTypes).toBe(1);
  });

  it('treats sub-tolerance totals (£0.50) as no signal', () => {
    expect(SIGN_TOLERANCE).toBe(1.0);
    const rows = [row('Dust', 'Income', 0.5, 0, 0.5), row('Rent', 'Expense', 1000, 0, 1000)];
    const report = detectSignConvention(rows);
    expect(report.signalTypes).toBe(1);
    expect(report.classification).toBe('standard');
  });

  it('is exact on fractional amounts (Decimal, no float drift)', () => {
    const rows = [
      row('Sales', 'Income', 0, 1234.56, -1234.56),
      row('Interest', 'Income', 0, 0.07, -0.07),
      row('Wages', 'Expense', 1234.63, 0, 1234.63),
    ];
    expect(detectSignConvention(rows).classification).toBe('standard');
    const totals = signTotalsByType(rows);
    expect(totals.Income).toBe('-1234.63');
  });
});

describe('sign-convention transformation', () => {
  it('negating every balance of a standard TB produces INVERTED, then the transform reproduces the original (Decimal-exact)', () => {
    const original = standardRows();
    const corrupted = negateRows(original);
    expect(detectSignConvention(corrupted).classification).toBe('inverted');

    const repaired = applySignInversion(corrupted);
    expect(repaired).toHaveLength(original.length);
    for (let i = 0; i < original.length; i++) {
      for (const field of ['debit', 'credit', 'balance'] as const) {
        expect(
          new Decimal(repaired[i][field]).equals(new Decimal(original[i][field])),
          `${original[i].accountName}.${field}`,
        ).toBe(true);
      }
      // balance = debit − credit still holds after the flip.
      expect(new Decimal(repaired[i].balance).equals(new Decimal(repaired[i].debit).minus(repaired[i].credit))).toBe(true);
    }
    expect(detectSignConvention(repaired).classification).toBe('standard');
  });

  it('applying the transform twice is the identity', () => {
    const original = standardRows();
    const twice = applySignInversion(applySignInversion(original));
    for (let i = 0; i < original.length; i++) {
      expect(new Decimal(twice[i].balance).equals(new Decimal(original[i].balance))).toBe(true);
    }
  });
});
