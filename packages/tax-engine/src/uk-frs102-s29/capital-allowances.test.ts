import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';
import {
  calculateUkCapitalAllowance,
  UK_AIA_ANNUAL_LIMIT,
} from './capital-allowances.js';

const m = (n: number | string) => new Decimal(n);

describe('calculateUkCapitalAllowance', () => {
  it('relieves £500k of main-rate additions in full via AIA', () => {
    const r = calculateUkCapitalAllowance({ qualifyingExpenditure: m(500_000) });
    expect(r.totalAllowance.toNumber()).toBe(500_000);
    expect(r.aiaUsed.toNumber()).toBe(500_000);
    expect(r.closingWrittenDownValue.toNumber()).toBe(0);
  });

  it('caps AIA at £1m and writes down the excess at 18%', () => {
    const r = calculateUkCapitalAllowance({ qualifyingExpenditure: m(1_500_000) });
    // AIA £1m + WDA 18% × £500k = £90k → £1.09m; closing £410k.
    expect(r.aiaUsed.toNumber()).toBe(1_000_000);
    expect(r.writingDownAllowance.toNumber()).toBe(90_000);
    expect(r.totalAllowance.toNumber()).toBe(1_090_000);
    expect(r.closingWrittenDownValue.toNumber()).toBe(410_000);
    expect(r.notes.join(' ')).toMatch(/AIA capped/);
  });

  it('honours a custom AIA cap', () => {
    const r = calculateUkCapitalAllowance({
      qualifyingExpenditure: m(600_000),
      aiaLimit: m(200_000),
    });
    expect(r.aiaUsed.toNumber()).toBe(200_000);
    // £400k excess × 18% = £72k.
    expect(r.writingDownAllowance.toNumber()).toBe(72_000);
  });

  it('applies full expensing at 100% for new & unused main-rate assets', () => {
    const r = calculateUkCapitalAllowance({
      qualifyingExpenditure: m(200_000),
      claimAIA: false,
      claimFullExpensing: true,
      isNewAndUnused: true,
    });
    expect(r.firstYearAllowance.toNumber()).toBe(200_000);
    expect(r.totalAllowance.toNumber()).toBe(200_000);
    expect(r.closingWrittenDownValue.toNumber()).toBe(0);
  });

  it('refuses full expensing for second-hand assets (pool treatment instead)', () => {
    const r = calculateUkCapitalAllowance({
      qualifyingExpenditure: m(200_000),
      claimAIA: false,
      claimFullExpensing: true,
      isNewAndUnused: false,
    });
    // £200k × 18% = £36k WDA.
    expect(r.firstYearAllowance.toNumber()).toBe(0);
    expect(r.writingDownAllowance.toNumber()).toBe(36_000);
    expect(r.notes.join(' ')).toMatch(/not new & unused/);
  });

  it('AIA is claimed before full expensing', () => {
    const r = calculateUkCapitalAllowance({
      qualifyingExpenditure: m(300_000),
      claimFullExpensing: true,
      isNewAndUnused: true,
    });
    // AIA absorbs the full £300k; nothing left for full expensing.
    expect(r.aiaUsed.toNumber()).toBe(300_000);
    expect(r.totalAllowance.toNumber()).toBe(300_000);
  });

  it('writes down special-rate pools at 6%', () => {
    const r = calculateUkCapitalAllowance({
      qualifyingExpenditure: m(100_000),
      pool: 'special',
      claimAIA: false,
    });
    expect(r.writingDownAllowance.toNumber()).toBe(6_000);
    expect(r.closingWrittenDownValue.toNumber()).toBe(94_000);
  });

  it('applies the 50% first-year allowance for new & unused special-rate assets', () => {
    const r = calculateUkCapitalAllowance({
      qualifyingExpenditure: m(100_000),
      pool: 'special',
      claimAIA: false,
      claimFullExpensing: true,
      isNewAndUnused: true,
    });
    // £50k FYA + 6% × £50k (£3k) = £53k.
    expect(r.firstYearAllowance.toNumber()).toBe(50_000);
    expect(r.totalAllowance.toNumber()).toBe(53_000);
    expect(r.closingWrittenDownValue.toNumber()).toBe(47_000);
  });

  it('relieves structures & buildings at 3% straight-line with no first-year relief', () => {
    const r = calculateUkCapitalAllowance({
      qualifyingExpenditure: m(1_000_000),
      pool: 'sba',
    });
    expect(r.firstYearAllowance.toNumber()).toBe(0);
    expect(r.totalAllowance.toNumber()).toBe(30_000);
    expect(r.closingWrittenDownValue.toNumber()).toBe(970_000);
  });

  it('carries prior WDV forward alongside in-year additions', () => {
    const r = calculateUkCapitalAllowance({
      qualifyingExpenditure: m(50_000),
      priorWrittenDownValue: m(100_000),
    });
    // AIA £50k + WDA 18% × £100k (£18k) = £68k; closing £82k.
    expect(r.totalAllowance.toNumber()).toBe(68_000);
    expect(r.closingWrittenDownValue.toNumber()).toBe(82_000);
  });

  it('deducts disposal proceeds from the pool', () => {
    const r = calculateUkCapitalAllowance({
      qualifyingExpenditure: m(0),
      priorWrittenDownValue: m(100_000),
      disposals: m(40_000),
      claimAIA: false,
    });
    // (£100k − £40k) × 18% = £10.8k; closing £49.2k.
    expect(r.writingDownAllowance.toNumber()).toBe(10_800);
    expect(r.closingWrittenDownValue.toNumber()).toBe(49_200);
  });

  it('writes off small pools of £1,000 or less in full', () => {
    const r = calculateUkCapitalAllowance({
      qualifyingExpenditure: m(0),
      priorWrittenDownValue: m(800),
      claimAIA: false,
    });
    expect(r.totalAllowance.toNumber()).toBe(800);
    expect(r.closingWrittenDownValue.toNumber()).toBe(0);
    expect(r.notes.join(' ')).toMatch(/Small pools/);
  });

  it('floors over-disposed pools at nil instead of going negative', () => {
    const r = calculateUkCapitalAllowance({
      qualifyingExpenditure: m(0),
      priorWrittenDownValue: m(10_000),
      disposals: m(50_000),
      claimAIA: false,
    });
    expect(r.closingWrittenDownValue.toNumber()).toBe(0);
    expect(r.notes.join(' ')).toMatch(/balancing charge/);
  });

  it('rejects negative inputs', () => {
    expect(() => calculateUkCapitalAllowance({ qualifyingExpenditure: m(-1) })).toThrow();
  });

  it('exposes the £1m AIA limit constant', () => {
    expect(UK_AIA_ANNUAL_LIMIT.toNumber()).toBe(1_000_000);
  });
});
