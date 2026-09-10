import Decimal from 'decimal.js';
import type { USD, TaxRate } from '../types.js';

/**
 * UK corporation tax fiscal years (FRS 102 Section 29 rate application).
 *
 * A UK fiscal year runs 1 April – 31 March and is labelled by its starting
 * calendar year: FY2024 = 1 April 2024 – 31 March 2025. Company accounting
 * periods rarely align (e.g. a 31 December year-end straddles two FYs), so
 * rates — and, for short periods, profit limits — must be apportioned.
 *
 * Day-count convention: both endpoints inclusive ([start, end]), measured in
 * UTC calendar days. All helpers are pure and side-effect free.
 */

export interface UkFiscalYearSlice {
  /** Fiscal-year label, e.g. '2024' for FY2024 (1 Apr 2024 – 31 Mar 2025). */
  fiscalYear: string;
  days: number;
  /** Share of the whole period, 0–1. Sums to 1 across slices. */
  fraction: number;
}

/** Fiscal-year label containing the given ISO date (YYYY-MM-DD). */
export function ukFiscalYearOf(date: string): string {
  const d = parseIsoDate(date);
  // January–March belong to the FY that started the previous April.
  return d.month >= 4 ? String(d.year) : String(d.year - 1);
}

/** Split an inclusive ISO date range into per-fiscal-year day slices. */
export function splitPeriodByUkFiscalYear(startDate: string, endDate: string): UkFiscalYearSlice[] {
  const start = parseIsoDate(startDate);
  const end = parseIsoDate(endDate);
  const startMs = Date.UTC(start.year, start.month - 1, start.day);
  const endMs = Date.UTC(end.year, end.month - 1, end.day);
  if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs < startMs) {
    throw new Error(`Invalid period: ${startDate} to ${endDate}`);
  }

  const days: Record<string, number> = {};
  for (let ms = startMs; ms <= endMs; ms += 86_400_000) {
    const d = new Date(ms);
    const fy = d.getUTCMonth() + 1 >= 4 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
    const key = String(fy);
    days[key] = (days[key] ?? 0) + 1;
  }
  const total = Object.values(days).reduce((a, b) => a + b, 0);
  return Object.keys(days).sort().map((fiscalYear) => ({
    fiscalYear,
    days: days[fiscalYear],
    fraction: days[fiscalYear] / total,
  }));
}

/** Day-weighted main rate for a period (supports future rate divergence). */
export function blendedUkMainRate(
  startDate: string,
  endDate: string,
  ratesByFiscalYear: Record<string, TaxRate>,
  fallbackRate: TaxRate = new Decimal('0.25'),
): TaxRate {
  const slices = splitPeriodByUkFiscalYear(startDate, endDate);
  let blended = new Decimal(0);
  for (const s of slices) {
    const rate = ratesByFiscalYear[s.fiscalYear] ?? fallbackRate;
    blended = blended.plus(rate.mul(s.fraction));
  }
  return blended;
}

/**
 * Apportion a profit limit (e.g. the £50k/£250k marginal-relief limits) for a
 * SHORT accounting period (< 12 months) by time. Full 12-month periods —
 * including 12-month periods that straddle fiscal years — use the full
 * limits; only short periods apportion.
 */
export function apportionUkProfitLimitForShortPeriod(limit: USD, daysInPeriod: number, daysInYear = 365): USD {
  if (!Number.isInteger(daysInPeriod) || daysInPeriod < 1) {
    throw new Error(`daysInPeriod must be a positive integer. Got: ${daysInPeriod}`);
  }
  if (daysInPeriod >= daysInYear) return limit;
  return limit.mul(daysInPeriod).div(daysInYear);
}

function parseIsoDate(date: string): { year: number; month: number; day: number } {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) throw new Error(`Expected ISO date YYYY-MM-DD. Got: ${date}`);
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
}
