import Decimal from 'decimal.js';
import { nameSimilarity } from '../import/auto-mapping/precedent-engine.js';

/**
 * Prior-period bridge (Feature 3).
 *
 * Deferred-tax rollforward assumes this period's opening balances match last
 * period's closing — but clients rename/split/merge accounts between years,
 * and silent misalignment corrupts the rollforward. This module diffs the
 * current import against the prior locked run's approved mapped accounts.
 * Pure + deterministic (no AI, no side effects); the routes layer surfaces
 * everything through the existing review-item / mapping-proposal machinery —
 * never a parallel resolution flow, never silent.
 */

// Fuzzy-rename bar: Jaccard-on-tokens similarity at or above this suggests a
// rename. Deliberately stricter than NAME_SIMILARITY_THRESHOLD (0.5) in
// intake/memory.ts: a bridge rename auto-suggests a carry-forward mapping,
// so demand strong evidence before linking two accounts.
export const RENAME_SIMILARITY_THRESHOLD = 0.75;

// Opening/closing continuity bar in GBP. Mirrors CONTROL_TOLERANCE (1.0) in
// intake/validate.ts: sub-pound rounding differences never block a close.
export const OPENING_BALANCE_TOLERANCE = 1.0;

// Only balance-sheet accounts carry forward: P&L balances legitimately differ
// every period, so comparing them would block every normal close.
export const BALANCE_SHEET_TYPES = ['Asset', 'Liability', 'Equity'] as const;
const BALANCE_SHEET = new Set<string>(BALANCE_SHEET_TYPES);

export interface PriorBridgeAccount {
  externalId: string;
  name: string;
  accountType: string;
  /** Last period's closing balance (exact decimal string or number). */
  closingBalance: number | string;
  /** The approved mapping to suggest as carry-forward (if any). */
  mapping?: {
    id: string;
    taxAccountType: string;
    bookTreatment: string;
    timingCategory?: string | null;
  } | null;
}

export interface CurrentBridgeAccount {
  externalId: string;
  name: string;
  accountType: string;
  /** This period's imported (opening) balance. */
  balance: number | string;
}

export interface BridgeNewAccount {
  code: 'NEW_ACCOUNT';
  current: CurrentBridgeAccount;
}

export interface BridgeMissingAccount {
  code: 'MISSING_PRIOR_ACCOUNT';
  prior: PriorBridgeAccount;
}

export interface BridgeRename {
  code: 'POSSIBLE_RENAME';
  current: CurrentBridgeAccount;
  prior: PriorBridgeAccount;
  similarity: number;
}

export interface BridgeMismatch {
  code: 'OPENING_BALANCE_MISMATCH';
  current: CurrentBridgeAccount;
  prior: PriorBridgeAccount;
  priorClosing: string;
  currentOpening: string;
  /** Signed exact decimal string (current − prior). */
  delta: string;
}

export interface PriorPeriodBridgeResult {
  newAccounts: BridgeNewAccount[];
  missingAccounts: BridgeMissingAccount[];
  renames: BridgeRename[];
  mismatches: BridgeMismatch[];
}

export function bridgeItemCount(result: PriorPeriodBridgeResult): number {
  return result.newAccounts.length + result.missingAccounts.length + result.renames.length + result.mismatches.length;
}

function identityKey(account: { externalId: string; name: string }): string {
  const ext = account.externalId.trim();
  if (ext !== '') return `ext:${ext.toLowerCase()}`;
  return `name:${account.name.trim().toLowerCase()}`;
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

/**
 * Diff current-period imports against prior-period approved accounts.
 *
 * Pass 1 — exact identity (externalId, else normalized name).
 * Pass 2 — fuzzy renames on the leftovers: same accountType and
 *   nameSimilarity ≥ RENAME_SIMILARITY_THRESHOLD (best match wins;
 *   deterministic: priors scanned in sorted order, currents in sorted order).
 * Pass 3 — leftovers become NEW_ACCOUNT (current-only) and
 *   MISSING_PRIOR_ACCOUNT (prior-only), so a rename never double-emits.
 * Pass 4 — continuity: for matched pairs (exact + rename) where both sides
 *   are balance-sheet types, |current − prior| > OPENING_BALANCE_TOLERANCE
 *   emits OPENING_BALANCE_MISMATCH.
 */
export function diffPriorPeriod(
  prior: PriorBridgeAccount[],
  current: CurrentBridgeAccount[],
): PriorPeriodBridgeResult {
  const sortedPrior = [...prior].sort((a, b) =>
    identityKey(a).localeCompare(identityKey(b)) || a.name.localeCompare(b.name),
  );
  const sortedCurrent = [...current].sort((a, b) =>
    identityKey(a).localeCompare(identityKey(b)) || a.name.localeCompare(b.name),
  );

  const priorByKey = new Map<string, PriorBridgeAccount>();
  for (const p of sortedPrior) {
    if (!priorByKey.has(identityKey(p))) priorByKey.set(identityKey(p), p);
  }

  const matched: Array<{ prior: PriorBridgeAccount; current: CurrentBridgeAccount }> = [];
  const unmatchedCurrent: CurrentBridgeAccount[] = [];
  const consumedPrior = new Set<PriorBridgeAccount>();
  for (const c of sortedCurrent) {
    const hit = priorByKey.get(identityKey(c));
    if (hit && !consumedPrior.has(hit)) {
      matched.push({ prior: hit, current: c });
      consumedPrior.add(hit);
    } else {
      unmatchedCurrent.push(c);
    }
  }
  const unmatchedPrior = sortedPrior.filter((p) => !consumedPrior.has(p));

  // Pass 2 — renames.
  const renames: BridgeRename[] = [];
  const consumedUnmatchedPrior = new Set<PriorBridgeAccount>();
  const stillNew: CurrentBridgeAccount[] = [];
  for (const c of unmatchedCurrent) {
    let best: PriorBridgeAccount | null = null;
    let bestScore = 0;
    for (const p of unmatchedPrior) {
      if (consumedUnmatchedPrior.has(p)) continue;
      if (p.accountType !== c.accountType) continue;
      const score = nameSimilarity(p.name, c.name);
      if (score >= RENAME_SIMILARITY_THRESHOLD && score > bestScore) {
        best = p;
        bestScore = score;
      }
    }
    if (best) {
      renames.push({ code: 'POSSIBLE_RENAME', current: c, prior: best, similarity: bestScore });
      matched.push({ prior: best, current: c });
      consumedUnmatchedPrior.add(best);
    } else {
      stillNew.push(c);
    }
  }

  const newAccounts: BridgeNewAccount[] = stillNew.map((current) => ({ code: 'NEW_ACCOUNT', current }));
  const missingAccounts: BridgeMissingAccount[] = unmatchedPrior
    .filter((p) => !consumedUnmatchedPrior.has(p))
    .map((prior) => ({ code: 'MISSING_PRIOR_ACCOUNT', prior }));

  // Pass 4 — continuity on matched balance-sheet pairs.
  const tolerance = new Decimal(OPENING_BALANCE_TOLERANCE);
  const mismatches: BridgeMismatch[] = [];
  for (const { prior: p, current: c } of matched) {
    if (!BALANCE_SHEET.has(p.accountType) || !BALANCE_SHEET.has(c.accountType)) continue;
    const priorClosing = toDecimal(p.closingBalance);
    const currentOpening = toDecimal(c.balance);
    const delta = currentOpening.minus(priorClosing);
    if (delta.abs().gt(tolerance)) {
      mismatches.push({
        code: 'OPENING_BALANCE_MISMATCH',
        current: c,
        prior: p,
        priorClosing: priorClosing.toString(),
        currentOpening: currentOpening.toString(),
        delta: delta.toString(),
      });
    }
  }
  mismatches.sort((a, b) =>
    a.current.name.localeCompare(b.current.name) || a.prior.name.localeCompare(b.prior.name),
  );

  return { newAccounts, missingAccounts, renames, mismatches };
}
