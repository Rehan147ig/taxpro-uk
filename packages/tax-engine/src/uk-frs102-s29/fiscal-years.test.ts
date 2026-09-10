import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';
import {
  ukFiscalYearOf,
  splitPeriodByUkFiscalYear,
  blendedUkMainRate,
  apportionUkProfitLimitForShortPeriod,
} from './fiscal-years.js';

const m = (n: number | string) => new Decimal(n);

describe('ukFiscalYearOf', () => {
  it('labels April–December by the starting year', () => {
    expect(ukFiscalYearOf('2024-04-01')).toBe('2024');
    expect(ukFiscalYearOf('2024-12-31')).toBe('2024');
  });

  it('labels January–March by the previous year', () => {
    expect(ukFiscalYearOf('2024-01-01')).toBe('2023');
    expect(ukFiscalYearOf('2024-03-31')).toBe('2023');
  });

  it('rejects non-ISO dates', () => {
    expect(() => ukFiscalYearOf('01/04/2024')).toThrow();
  });
});

describe('splitPeriodByUkFiscalYear', () => {
  it('keeps single-FY periods whole', () => {
    const slices = splitPeriodByUkFiscalYear('2024-04-01', '2025-03-31');
    expect(slices).toHaveLength(1);
    expect(slices[0]).toMatchObject({ fiscalYear: '2024', days: 365 });
    expect(slices[0].fraction).toBeCloseTo(1, 10);
  });

  it('splits a 31 December year-end across FYs (2024 is a leap year)', () => {
    const slices = splitPeriodByUkFiscalYear('2024-01-01', '2024-12-31');
    expect(slices).toHaveLength(2);
    // Jan–Mar 2024 (leap February): 31 + 29 + 31 = 91 days in FY2023.
    expect(slices[0]).toMatchObject({ fiscalYear: '2023', days: 91 });
    // Apr–Dec 2024: 275 days in FY2024.
    expect(slices[1]).toMatchObject({ fiscalYear: '2024', days: 275 });
    expect(slices[0].fraction + slices[1].fraction).toBeCloseTo(1, 10);
  });

  it('rejects inverted ranges', () => {
    expect(() => splitPeriodByUkFiscalYear('2024-12-31', '2024-01-01')).toThrow();
  });
});

describe('blendedUkMainRate', () => {
  it('returns the flat rate when every FY shares it', () => {
    const rate = blendedUkMainRate('2024-01-01', '2024-12-31', { '2023': m('0.25'), '2024': m('0.25') });
    expect(rate.toNumber()).toBeCloseTo(0.25, 10);
  });

  it('day-weights divergent FY rates', () => {
    const rate = blendedUkMainRate('2024-01-01', '2024-12-31', { '2023': m('0.19'), '2024': m('0.25') });
    // (91 × 19% + 275 × 25%) / 366.
    const expected = (91 * 0.19 + 275 * 0.25) / 366;
    expect(rate.toNumber()).toBeCloseTo(expected, 10);
  });

  it('falls back for unknown fiscal years', () => {
    const rate = blendedUkMainRate('2030-06-01', '2030-06-30', {});
    expect(rate.toNumber()).toBe(0.25);
  });
});

describe('apportionUkProfitLimitForShortPeriod', () => {
  it('keeps full limits for 12-month periods', () => {
    expect(apportionUkProfitLimitForShortPeriod(m(50_000), 365).toNumber()).toBe(50_000);
    expect(apportionUkProfitLimitForShortPeriod(m(250_000), 366).toNumber()).toBe(250_000);
  });

  it('time-apportions short periods', () => {
    // 6-month period: £50k × 183/365 ≈ £25,068.49.
    const apportioned = apportionUkProfitLimitForShortPeriod(m(50_000), 183);
    expect(apportioned.toNumber()).toBeCloseTo(25_068.49, 2);
  });

  it('rejects non-positive day counts', () => {
    expect(() => apportionUkProfitLimitForShortPeriod(m(50_000), 0)).toThrow();
  });
});
