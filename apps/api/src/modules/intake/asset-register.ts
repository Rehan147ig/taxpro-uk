import Decimal from 'decimal.js';
import {
  calculateUkCapitalAllowance,
  type UkAllowancePool,
  type UkCapitalAllowanceResult,
} from '@taxpro/tax-engine';

/**
 * Fixed Asset Register ingestion (Feature 5).
 *
 * Pure + deterministic helpers around the asset_register_items table. The
 * intake pool_type vocabulary is translated here — and only here — onto the
 * engine's UkAllowancePool inputs. The engine itself is never touched.
 */

export const ASSET_POOL_TYPES = ['main', 'special_rate', 'aia', 'fya', 'single_asset'] as const;
export type AssetPoolType = (typeof ASSET_POOL_TYPES)[number];

export interface AssetRegisterInput {
  assetDescription: string;
  cost: number | string;
  poolType: string;
  placedInServiceDate: string;
  accountExternalId?: string | null;
  disposalDate?: string | null;
  disposalProceeds?: number | string | null;
}

export interface AssetIssue {
  code: 'MISSING_REQUIRED' | 'INVALID_POOL_TYPE' | 'INVALID_DATE' | 'INVALID_AMOUNT' | 'DISPOSAL_BEFORE_ACQUISITION';
  message: string;
  field: string;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function toDecimal(value: number | string | null | undefined): Decimal | null {
  if (value === null || value === undefined || value === '') return null;
  try {
    const d = new Decimal(value);
    return d.isFinite() ? d : null;
  } catch {
    return null;
  }
}

/** Deterministic validator with stable machine-readable codes. */
export function validateAssetInput(input: AssetRegisterInput): AssetIssue[] {
  const issues: AssetIssue[] = [];

  if (!input.assetDescription?.trim()) {
    issues.push({ code: 'MISSING_REQUIRED', message: 'assetDescription is required', field: 'assetDescription' });
  }
  if (input.cost === null || input.cost === undefined || String(input.cost).trim() === '') {
    issues.push({ code: 'MISSING_REQUIRED', message: 'cost is required', field: 'cost' });
  } else {
    const cost = toDecimal(input.cost);
    if (!cost || cost.isNegative()) {
      issues.push({ code: 'INVALID_AMOUNT', message: `cost "${input.cost}" must be a non-negative amount`, field: 'cost' });
    }
  }
  if (!(ASSET_POOL_TYPES as readonly string[]).includes(input.poolType)) {
    issues.push({
      code: 'INVALID_POOL_TYPE',
      message: `poolType "${input.poolType}" must be one of ${ASSET_POOL_TYPES.join(', ')}`,
      field: 'poolType',
    });
  }
  if (!input.placedInServiceDate) {
    issues.push({ code: 'MISSING_REQUIRED', message: 'placedInServiceDate is required', field: 'placedInServiceDate' });
  } else if (!DATE_RE.test(input.placedInServiceDate)) {
    issues.push({
      code: 'INVALID_DATE',
      message: `placedInServiceDate "${input.placedInServiceDate}" is not a valid YYYY-MM-DD date`,
      field: 'placedInServiceDate',
    });
  }
  if (input.disposalDate !== undefined && input.disposalDate !== null && input.disposalDate !== '') {
    if (!DATE_RE.test(input.disposalDate)) {
      issues.push({
        code: 'INVALID_DATE',
        message: `disposalDate "${input.disposalDate}" is not a valid YYYY-MM-DD date`,
        field: 'disposalDate',
      });
    } else if (DATE_RE.test(input.placedInServiceDate) && input.disposalDate < input.placedInServiceDate) {
      issues.push({
        code: 'DISPOSAL_BEFORE_ACQUISITION',
        message: `disposalDate ${input.disposalDate} is before placedInServiceDate ${input.placedInServiceDate}`,
        field: 'disposalDate',
      });
    }
  }
  if (input.disposalProceeds !== undefined && input.disposalProceeds !== null && String(input.disposalProceeds).trim() !== '') {
    const proceeds = toDecimal(input.disposalProceeds);
    if (!proceeds || proceeds.isNegative()) {
      issues.push({ code: 'INVALID_AMOUNT', message: `disposalProceeds "${input.disposalProceeds}" must be a non-negative amount`, field: 'disposalProceeds' });
    }
  }
  return issues;
}

export interface EnginePoolInput {
  pool: UkAllowancePool;
  claimAIA: boolean;
  claimFullExpensing: boolean;
  isNewAndUnused: boolean;
}

/**
 * Intake pool_type → engine inputs. Conservative throughout: only AIA is
 * ever auto-claimed (capped at £1M by the engine); 'fya' records the
 * first-year intent but the engine falls back to pool treatment unless the
 * asset is evidenced as new & unused (which v1 does not track — the engine
 * notes this itself); 'single_asset' is computed as its own pool balance at
 * the main rate rather than pooled.
 */
export const POOL_TO_ENGINE_INPUT: Record<AssetPoolType, EnginePoolInput> = {
  main: { pool: 'main', claimAIA: false, claimFullExpensing: false, isNewAndUnused: false },
  special_rate: { pool: 'special', claimAIA: false, claimFullExpensing: false, isNewAndUnused: false },
  aia: { pool: 'main', claimAIA: true, claimFullExpensing: false, isNewAndUnused: false },
  fya: { pool: 'main', claimAIA: false, claimFullExpensing: true, isNewAndUnused: false },
  single_asset: { pool: 'main', claimAIA: false, claimFullExpensing: false, isNewAndUnused: false },
};

export interface RegisterAsset {
  id: string;
  assetDescription: string;
  cost: number | string;
  poolType: AssetPoolType;
  placedInServiceDate: string;
  disposalDate?: string | null;
  disposalProceeds?: number | string | null;
}

export interface PoolAllowanceSummary {
  pool: string;
  assetCount: number;
  qualifyingExpenditure: string;
  disposals: string;
  firstYearAllowance: string;
  writingDownAllowance: string;
  totalAllowance: string;
  closingWrittenDownValue: string;
  notes: string[];
}

export interface RegisterAllowanceSummary {
  pools: PoolAllowanceSummary[];
  assetCount: number;
  totalAllowance: string;
}

/**
 * Feed register assets into the engine's CAA 2001 calculator for one period.
 * Additions = placed in service within [periodStart, periodEnd]; disposals =
 * disposal date within the period. 'single_asset' items are computed as
 * individual pool balances (then reported under one row); all other types
 * aggregate by engine pool. priorWDV is zero in v1 (no brought-forward
 * tracking) — stated, not hidden.
 */
export function summarizeRegisterCapitalAllowances(
  assets: RegisterAsset[],
  periodStart: string,
  periodEnd: string,
): RegisterAllowanceSummary {
  const inPeriod = assets.filter(
    (a) => a.placedInServiceDate >= periodStart && a.placedInServiceDate <= periodEnd,
  );

  const aggregate = new Map<string, { expenditure: Decimal; disposals: Decimal; count: number }>();
  const singles: RegisterAsset[] = [];
  for (const asset of inPeriod) {
    if (asset.poolType === 'single_asset') {
      singles.push(asset);
      continue;
    }
    const mapped = POOL_TO_ENGINE_INPUT[asset.poolType];
    const key = `${mapped.pool}|${mapped.claimAIA ? 'aia' : 'wda'}|${mapped.claimFullExpensing ? 'fya' : 'pool'}`;
    const bucket = aggregate.get(key) ?? { expenditure: new Decimal(0), disposals: new Decimal(0), count: 0 };
    bucket.expenditure = bucket.expenditure.plus(toDecimal(asset.cost) ?? new Decimal(0));
    if (asset.disposalDate && asset.disposalDate >= periodStart && asset.disposalDate <= periodEnd) {
      bucket.disposals = bucket.disposals.plus(toDecimal(asset.disposalProceeds) ?? new Decimal(0));
    }
    bucket.count += 1;
    aggregate.set(key, bucket);
  }

  const pools: PoolAllowanceSummary[] = [];
  const sortedKeys = [...aggregate.keys()].sort();
  for (const key of sortedKeys) {
    const [pool, aiaFlag, fyaFlag] = key.split('|');
    const bucket = aggregate.get(key)!;
    const result: UkCapitalAllowanceResult = calculateUkCapitalAllowance({
      qualifyingExpenditure: bucket.expenditure,
      pool: pool as UkAllowancePool,
      priorWrittenDownValue: new Decimal(0),
      disposals: bucket.disposals,
      claimAIA: aiaFlag === 'aia',
      claimFullExpensing: fyaFlag === 'fya',
      isNewAndUnused: false,
    });
    pools.push({
      pool: key,
      assetCount: bucket.count,
      qualifyingExpenditure: bucket.expenditure.toString(),
      disposals: bucket.disposals.toString(),
      firstYearAllowance: result.firstYearAllowance.toString(),
      writingDownAllowance: result.writingDownAllowance.toString(),
      totalAllowance: result.totalAllowance.toString(),
      closingWrittenDownValue: result.closingWrittenDownValue.toString(),
      notes: result.notes,
    });
  }

  for (const asset of [...singles].sort((a, b) => a.id.localeCompare(b.id))) {
    const cost = toDecimal(asset.cost) ?? new Decimal(0);
    const disposals =
      asset.disposalDate && asset.disposalDate >= periodStart && asset.disposalDate <= periodEnd
        ? (toDecimal(asset.disposalProceeds) ?? new Decimal(0))
        : new Decimal(0);
    const result = calculateUkCapitalAllowance({
      qualifyingExpenditure: cost,
      pool: 'main',
      priorWrittenDownValue: new Decimal(0),
      disposals,
      claimAIA: false,
      claimFullExpensing: false,
      isNewAndUnused: false,
    });
    pools.push({
      pool: `single_asset:${asset.id}`,
      assetCount: 1,
      qualifyingExpenditure: cost.toString(),
      disposals: disposals.toString(),
      firstYearAllowance: result.firstYearAllowance.toString(),
      writingDownAllowance: result.writingDownAllowance.toString(),
      totalAllowance: result.totalAllowance.toString(),
      closingWrittenDownValue: result.closingWrittenDownValue.toString(),
      notes: [`Single-asset pool for "${asset.assetDescription}" (own balance at main rate)`, ...result.notes],
    });
  }

  const totalAllowance = pools
    .reduce((sum, p) => sum.plus(new Decimal(p.totalAllowance)), new Decimal(0))
    .toString();

  return { pools, assetCount: inPeriod.length, totalAllowance };
}
