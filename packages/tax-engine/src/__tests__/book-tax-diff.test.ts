import { describe, it, expect } from 'vitest';
import Decimal from 'decimal.js';
import { computeBookTaxDifferences } from '../book-tax-diff.js';
import type { TaxMapping, TrialBalanceLine, Account } from '../types.js';

describe('computeBookTaxDifferences', () => {
  const account: Account = { id: 'a1', accountNumber: '1000', name: 'Equipment', type: 'Asset' };
  const defaultMapping: TaxMapping = {
    accountId: 'a1', taxAccountType: 'TEMP_DEPRECIATION',
    bookTreatment: 'temporary', timingCategory: 'taxable_temporary',
    confidenceScore: new Decimal('0.7'),
  };

  it('no_diff returns zero difference', () => {
    const results = computeBookTaxDifferences(
      [{ entityId: 'e1', accountId: 'a1', period: '2026-01-01', balance: new Decimal('100000') }],
      [account],
      new Map([['a1', { ...defaultMapping, bookTreatment: 'no_diff' }]]),
      '2026-01-01',
    );
    expect(results[0].diffType).toBe('no_diff');
    expect(results[0].difference.toNumber()).toBe(0);
  });

  it('permanent difference returns zero difference', () => {
    const results = computeBookTaxDifferences(
      [{ entityId: 'e1', accountId: 'a1', period: '2026-01-01', balance: new Decimal('100000') }],
      [account],
      new Map([['a1', { ...defaultMapping, bookTreatment: 'permanent', taxAccountType: 'PERM_MEALS_ENTERTAINMENT' }]]),
      '2026-01-01',
    );
    expect(results[0].diffType).toBe('permanent');
    expect(results[0].difference.toNumber()).toBe(0);
  });

  it('temporary difference with MACRS year 1 factor', () => {
    const results = computeBookTaxDifferences(
      [{ entityId: 'e1', accountId: 'a1', period: '2026-01-01', balance: new Decimal('100000') }],
      [account],
      new Map([['a1', defaultMapping]]),
      '2026-01-01', 1,
    );
    // 5-year MACRS year 1 = 0.20 → difference = 100k * 0.20 = 20k
    expect(results[0].diffType).toBe('temporary');
    expect(results[0].difference.toNumber()).toBe(20_000);
  });

  it('deductible temporary difference has negative difference', () => {
    const results = computeBookTaxDifferences(
      [{ entityId: 'e1', accountId: 'a1', period: '2026-01-01', balance: new Decimal('100000') }],
      [account],
      new Map([['a1', { ...defaultMapping, timingCategory: 'deductible_temporary' }]]),
      '2026-01-01', 1,
    );
    expect(results[0].difference.isNegative()).toBe(true);
  });

  it('unmapped accounts default to no_diff', () => {
    const results = computeBookTaxDifferences(
      [{ entityId: 'e1', accountId: 'a1', period: '2026-01-01', balance: new Decimal('100000') }],
      [account],
      new Map(),
      '2026-01-01',
    );
    expect(results[0].diffType).toBe('no_diff');
    expect(results[0].difference.toNumber()).toBe(0);
  });

  it('non-depreciation categories use default timing factors', () => {
    const mapping: TaxMapping = {
      accountId: 'a1', taxAccountType: 'TEMP_BAD_DEBT_RESERVE',
      bookTreatment: 'temporary', timingCategory: 'deductible_temporary',
      confidenceScore: new Decimal('0.75'),
    };
    const results = computeBookTaxDifferences(
      [{ entityId: 'e1', accountId: 'a1', period: '2026-01-01', balance: new Decimal('100000') }],
      [account],
      new Map([['a1', mapping]]),
      '2026-01-01', 1,
    );
    // Bad debt reserve = 0.15 factor → difference = 15k
    expect(results[0].difference.abs().toNumber()).toBe(15_000);
  });

  it('reversal period uses the provided asOfDate year', () => {
    const results = computeBookTaxDifferences(
      [{ entityId: 'e1', accountId: 'a1', period: '2026-01-01', balance: new Decimal('100000') }],
      [account],
      new Map([['a1', defaultMapping]]),
      '2025-06-15', 1,
    );
    // TEMP_DEPRECIATION reverses in 5 years → 2025 + 5 = 2030
    expect(results[0].reversalPeriod).toBe('2030');
  });

  it('empty trial balance returns empty array', () => {
    const results = computeBookTaxDifferences([], [account], new Map(), '2026-01-01');
    expect(results.length).toBe(0);
  });

  it('resolves current-year asset age from placed-in-service date (year 1 MACRS)', () => {
    const results = computeBookTaxDifferences(
      [{ entityId: 'e1', accountId: 'a1', period: '2026-01-01', balance: new Decimal('100000'), placedInServiceDate: '2026-01-15' }],
      [account],
      new Map([['a1', defaultMapping]]),
      '2026-01-01',
    );
    expect(results[0].depreciationAgeSource).toBe('placed_in_service');
    expect(results[0].assetAgeYears).toBe(1);
    expect(results[0].difference.toNumber()).toBe(20_000);
  });

  it('resolves prior-year asset age (year 5 MACRS rate 0.1152)', () => {
    const results = computeBookTaxDifferences(
      [{ entityId: 'e1', accountId: 'a1', period: '2026-01-01', balance: new Decimal('100000'), placedInServiceDate: '2022-07-01' }],
      [account],
      new Map([['a1', defaultMapping]]),
      '2026-01-01',
    );
    expect(results[0].depreciationAgeSource).toBe('placed_in_service');
    expect(results[0].assetAgeYears).toBe(5);
    expect(results[0].difference.toNumber()).toBeCloseTo(11_520, 2);
  });

  it('uses explicit assetAgeYears when placed-in-service date is missing', () => {
    const results = computeBookTaxDifferences(
      [{ entityId: 'e1', accountId: 'a1', period: '2026-01-01', balance: new Decimal('100000'), assetAgeYears: 3 }],
      [account],
      new Map([['a1', defaultMapping]]),
      '2026-01-01',
    );
    expect(results[0].depreciationAgeSource).toBe('explicit_age');
    expect(results[0].assetAgeYears).toBe(3);
    expect(results[0].difference.toNumber()).toBe(19_200);
  });

  it('falls back to account-level placed-in-service date', () => {
    const results = computeBookTaxDifferences(
      [{ entityId: 'e1', accountId: 'a1', period: '2026-01-01', balance: new Decimal('100000') }],
      [{ ...account, placedInServiceDate: '2021-01-01' }],
      new Map([['a1', defaultMapping]]),
      '2026-01-01',
    );
    expect(results[0].depreciationAgeSource).toBe('placed_in_service');
    expect(results[0].assetAgeYears).toBe(6);
    expect(results[0].difference.toNumber()).toBe(5_760);
  });

  it('flags missing metadata instead of silently assuming first-year MACRS', () => {
    const results = computeBookTaxDifferences(
      [{ entityId: 'e1', accountId: 'a1', period: '2026-01-01', balance: new Decimal('100000') }],
      [account],
      new Map([['a1', defaultMapping]]),
      '2026-01-01',
    );
    expect(results[0].depreciationAgeSource).toBe('no_metadata');
    expect(results[0].assetAgeYears).toBe(1);
    expect(results[0].difference.toNumber()).toBe(20_000);
  });

  it('uses zero MACRS factor once the asset is fully depreciated', () => {
    const results = computeBookTaxDifferences(
      [{ entityId: 'e1', accountId: 'a1', period: '2026-01-01', balance: new Decimal('100000'), placedInServiceDate: '2018-01-01' }],
      [account],
      new Map([['a1', defaultMapping]]),
      '2026-01-01',
    );
    // 5-year MACRS fully depreciated after year 6 -> factor 0
    expect(results[0].assetAgeYears).toBe(9);
    expect(results[0].difference.toNumber()).toBe(0);
  });

  it('applies different MACRS class factors (15-year amortization vs 5-year depreciation)', () => {
    const results = computeBookTaxDifferences(
      [{ entityId: 'e1', accountId: 'a1', period: '2026-01-01', balance: new Decimal('100000'), placedInServiceDate: '2026-01-01' }],
      [account],
      new Map([['a1', { ...defaultMapping, taxAccountType: 'TEMP_AMORTIZATION' }]]),
      '2026-01-01',
    );
    expect(results[0].depreciationAgeSource).toBe('placed_in_service');
    expect(results[0].difference.toNumber()).toBeCloseTo(5_000, 2);
  });

  it('never flags UK (non-MACRS) categories for depreciation metadata', () => {
    const results = computeBookTaxDifferences(
      [{ entityId: 'e1', accountId: 'a1', period: '2026-01-01', balance: new Decimal('100000') }],
      [account],
      new Map([['a1', { ...defaultMapping, taxAccountType: 'UK_TEMP_OTHER' }]]),
      '2026-01-01',
    );
    expect(results[0].depreciationAgeSource).toBe('assumed_first_year');
    expect(results[0].difference.abs().toNumber()).toBe(10_000);
  });

  it('flags UK fixed-asset categories without metadata (no silent first-year relief)', () => {
    const results = computeBookTaxDifferences(
      [{ entityId: 'e1', accountId: 'a1', period: '2026-01-01', balance: new Decimal('100000') }],
      [account],
      new Map([['a1', { ...defaultMapping, taxAccountType: 'TEMP_FIXED_ASSET_ALLOWANCE' }]]),
      '2026-01-01',
    );
    expect(results[0].depreciationAgeSource).toBe('no_metadata');
  });

  it('applies main-pool WDA (18%) to UK fixed assets by default — never assumed 100%', () => {
    const results = computeBookTaxDifferences(
      [{ entityId: 'e1', accountId: 'a1', period: '2026-01-01', balance: new Decimal('100000') }],
      [account],
      new Map([['a1', { ...defaultMapping, taxAccountType: 'TEMP_FIXED_ASSET_ALLOWANCE' }]]),
      '2026-01-01', 1,
      { jurisdiction: 'UK_FRS102_S29' },
    );
    // £100k × 18% = £18k timing difference (not £100k).
    expect(results[0].difference.toNumber()).toBe(18_000);
  });

  it('applies 100% factor to year-1 UK fixed assets only with evidenced first-year relief', () => {
    for (const relief of ['aia', 'full-expensing'] as const) {
      const results = computeBookTaxDifferences(
        [{ entityId: 'e1', accountId: 'a1', period: '2026-01-01', balance: new Decimal('100000'), placedInServiceDate: '2026-03-01' }],
        [account],
        new Map([['a1', { ...defaultMapping, taxAccountType: 'TEMP_FIXED_ASSET_ALLOWANCE' }]]),
        '2026-01-01', 1,
        { jurisdiction: 'UK_FRS102_S29', ukFirstYearRelief: relief },
      );
      expect(results[0].difference.toNumber()).toBe(100_000);
    }
  });

  it('keeps WDA rates for older UK fixed assets even with first-year relief evidenced', () => {
    const results = computeBookTaxDifferences(
      [{ entityId: 'e1', accountId: 'a1', period: '2026-01-01', balance: new Decimal('100000'), placedInServiceDate: '2024-01-01' }],
      [account],
      new Map([['a1', { ...defaultMapping, taxAccountType: 'TEMP_FIXED_ASSET_ALLOWANCE' }]]),
      '2026-01-01', 1,
      { jurisdiction: 'UK_FRS102_S29', ukFirstYearRelief: 'aia' },
    );
    expect(results[0].assetAgeYears).toBe(3);
    expect(results[0].difference.toNumber()).toBe(18_000);
  });

  it('leaves US MACRS behaviour untouched when no jurisdiction is passed', () => {
    const results = computeBookTaxDifferences(
      [{ entityId: 'e1', accountId: 'a1', period: '2026-01-01', balance: new Decimal('100000') }],
      [account],
      new Map([['a1', defaultMapping]]),
      '2026-01-01', 1,
    );
    expect(results[0].difference.toNumber()).toBe(20_000);
  });
});
