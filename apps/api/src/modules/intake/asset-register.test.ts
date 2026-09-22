import { describe, it, expect } from 'vitest';
import Decimal from 'decimal.js';
import {
  ASSET_POOL_TYPES,
  POOL_TO_ENGINE_INPUT,
  validateAssetInput,
  summarizeRegisterCapitalAllowances,
  type AssetPoolType,
} from './asset-register.js';

const GOOD: { assetDescription: string; cost: number; poolType: AssetPoolType; placedInServiceDate: string } = {
  assetDescription: 'CNC milling machine',
  cost: 120000,
  poolType: 'main',
  placedInServiceDate: '2026-04-01',
};

describe('asset register validator (deterministic codes)', () => {
  it('accepts a well-formed asset with no issues', () => {
    expect(validateAssetInput(GOOD)).toEqual([]);
  });

  it('requires description, cost and placed-in-service date', () => {
    const issues = validateAssetInput({ assetDescription: '  ', cost: '', poolType: 'main', placedInServiceDate: '' });
    expect(issues.map((i) => i.code)).toContain('MISSING_REQUIRED');
    expect(issues).toHaveLength(3);
  });

  it('rejects unknown pool types', () => {
    const issues = validateAssetInput({ ...GOOD, poolType: 'hyper_pool' });
    expect(issues).toEqual([expect.objectContaining({ code: 'INVALID_POOL_TYPE', field: 'poolType' })]);
  });

  it('enforces the category enum from the engine-facing vocabulary', () => {
    expect([...ASSET_POOL_TYPES].sort()).toEqual(['aia', 'fya', 'main', 'single_asset', 'special_rate']);
  });

  it('rejects malformed dates and negative amounts', () => {
    expect(validateAssetInput({ ...GOOD, placedInServiceDate: '04/01/2026' }))
      .toEqual([expect.objectContaining({ code: 'INVALID_DATE' })]);
    expect(validateAssetInput({ ...GOOD, cost: -50 }))
      .toEqual([expect.objectContaining({ code: 'INVALID_AMOUNT' })]);
    expect(validateAssetInput({ ...GOOD, disposalProceeds: 'abc' }))
      .toEqual([expect.objectContaining({ code: 'INVALID_AMOUNT' })]);
  });

  it('rejects disposals before acquisition', () => {
    const issues = validateAssetInput({
      ...GOOD,
      placedInServiceDate: '2026-04-01',
      disposalDate: '2026-03-31',
      disposalProceeds: 1000,
    });
    expect(issues).toEqual([expect.objectContaining({ code: 'DISPOSAL_BEFORE_ACQUISITION' })]);
  });
});

describe('pool_type → engine mapping (engine untouched)', () => {
  it('maps every intake pool onto a real engine pool without inventing vocabulary', () => {
    expect(POOL_TO_ENGINE_INPUT.main).toMatchObject({ pool: 'main', claimAIA: false });
    expect(POOL_TO_ENGINE_INPUT.special_rate).toMatchObject({ pool: 'special', claimAIA: false });
    expect(POOL_TO_ENGINE_INPUT.aia).toMatchObject({ pool: 'main', claimAIA: true });
    // FYA records intent but never assumes new & unused — the engine falls
    // back to pool treatment with its own note.
    expect(POOL_TO_ENGINE_INPUT.fya).toMatchObject({ pool: 'main', claimFullExpensing: true, isNewAndUnused: false });
    expect(POOL_TO_ENGINE_INPUT.single_asset).toMatchObject({ pool: 'main' });
  });
});

describe('summarizeRegisterCapitalAllowances (engine-fed, Decimal-exact)', () => {
  it('computes a non-zero main-pool WDA matching the 18% pool mechanics', () => {
    const summary = summarizeRegisterCapitalAllowances(
      [{ id: 'a1', ...GOOD }],
      '2026-01-01',
      '2026-12-31',
    );
    expect(summary.assetCount).toBe(1);
    expect(summary.pools).toHaveLength(1);
    expect(summary.pools[0].qualifyingExpenditure).toBe('120000');
    // 120,000 × 18% = 21,600 WDA, closing 98,400.
    expect(summary.pools[0].writingDownAllowance).toBe('21600');
    expect(summary.pools[0].closingWrittenDownValue).toBe('98400');
    expect(summary.totalAllowance).toBe('21600');
  });

  it('honours AIA claims and per-pool aggregation', () => {
    const summary = summarizeRegisterCapitalAllowances(
      [
        { id: 'a1', assetDescription: 'Laptops', cost: 40000, poolType: 'aia', placedInServiceDate: '2026-05-01' },
        { id: 'a2', assetDescription: 'Servers', cost: 60000, poolType: 'aia', placedInServiceDate: '2026-06-01' },
        { id: 'a3', assetDescription: 'HVAC', cost: 100000, poolType: 'special_rate', placedInServiceDate: '2026-07-01' },
      ],
      '2026-01-01',
      '2026-12-31',
    );
    const aia = summary.pools.find((p) => p.pool.startsWith('main|aia'));
    expect(aia?.firstYearAllowance).toBe('100000');
    const special = summary.pools.find((p) => p.pool.startsWith('special|'));
    // 100,000 × 6% = 6,000 WDA.
    expect(special?.writingDownAllowance).toBe('6000');
    expect(new Decimal(summary.totalAllowance).equals(new Decimal('106000'))).toBe(true);
  });

  it('computes single-asset pools individually', () => {
    const summary = summarizeRegisterCapitalAllowances(
      [
        { id: 's1', assetDescription: 'Van', cost: 20000, poolType: 'single_asset', placedInServiceDate: '2026-02-01' },
        { id: 's2', assetDescription: 'Press', cost: 30000, poolType: 'single_asset', placedInServiceDate: '2026-03-01' },
      ],
      '2026-01-01',
      '2026-12-31',
    );
    expect(summary.pools).toHaveLength(2);
    expect(summary.pools.map((p) => p.assetCount)).toEqual([1, 1]);
  });

  it('deducts in-period disposals and ignores out-of-period assets', () => {
    const summary = summarizeRegisterCapitalAllowances(
      [
        {
          id: 'd1', assetDescription: 'Old lathe', cost: 50000, poolType: 'main',
          placedInServiceDate: '2026-02-01', disposalDate: '2026-09-01', disposalProceeds: 10000,
        },
        {
          id: 'f1', assetDescription: 'Next-year press', cost: 90000, poolType: 'main',
          placedInServiceDate: '2027-02-01',
        },
      ],
      '2026-01-01',
      '2026-12-31',
    );
    expect(summary.assetCount).toBe(1);
    expect(summary.pools[0].disposals).toBe('10000');
    // (50,000 − 10,000) × 18% = 7,200.
    expect(summary.pools[0].writingDownAllowance).toBe('7200');
  });
});
