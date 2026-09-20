import { describe, it, expect } from 'vitest';
import {
  diffPriorPeriod,
  bridgeItemCount,
  RENAME_SIMILARITY_THRESHOLD,
  OPENING_BALANCE_TOLERANCE,
  type PriorBridgeAccount,
  type CurrentBridgeAccount,
} from './prior-period-bridge.js';

function prior(name: string, overrides: Partial<PriorBridgeAccount> = {}): PriorBridgeAccount {
  return {
    externalId: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    name,
    accountType: 'Expense',
    closingBalance: 1000,
    mapping: null,
    ...overrides,
  };
}

function current(name: string, overrides: Partial<CurrentBridgeAccount> = {}): CurrentBridgeAccount {
  return {
    externalId: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    name,
    accountType: 'Expense',
    balance: 1000,
    ...overrides,
  };
}

describe('prior-period bridge diff (pure, deterministic)', () => {
  it('produces zero items for an identical chart period-over-period', () => {
    const priorRows = [prior('Office rent'), prior('Cash', { accountType: 'Asset', closingBalance: 5000 })];
    const currentRows = [current('Office rent'), current('Cash', { accountType: 'Asset', balance: 5000 })];
    const result = diffPriorPeriod(priorRows, currentRows);
    expect(bridgeItemCount(result)).toBe(0);
  });

  it('emits POSSIBLE_RENAME for high-similarity renames (and not missing/new)', () => {
    // "Office rent account" → "Office rent": identical token sets once the
    // stopword "account" is stripped (similarity 1.0) with different
    // external ids, so identity matching misses and fuzzy matching fires.
    const result = diffPriorPeriod(
      [prior('Office rent account')],
      [current('Office rent')],
    );
    expect(result.renames).toHaveLength(1);
    expect(result.renames[0].code).toBe('POSSIBLE_RENAME');
    expect(result.renames[0].similarity).toBeGreaterThanOrEqual(RENAME_SIMILARITY_THRESHOLD);
    expect(result.missingAccounts).toHaveLength(0);
    expect(result.newAccounts).toHaveLength(0);
  });

  it('emits NEW_ACCOUNT for added accounts', () => {
    const result = diffPriorPeriod(
      [prior('Office rent')],
      [current('Office rent'), current('Cloud hosting')],
    );
    expect(result.newAccounts).toHaveLength(1);
    expect(result.newAccounts[0]).toMatchObject({ code: 'NEW_ACCOUNT' });
    expect(result.newAccounts[0].current.name).toBe('Cloud hosting');
  });

  it('emits MISSING_PRIOR_ACCOUNT for disappearing accounts', () => {
    const result = diffPriorPeriod(
      [prior('Office rent'), prior('Fax line')],
      [current('Office rent')],
    );
    expect(result.missingAccounts).toHaveLength(1);
    expect(result.missingAccounts[0]).toMatchObject({ code: 'MISSING_PRIOR_ACCOUNT' });
    expect(result.missingAccounts[0].prior.name).toBe('Fax line');
  });

  it('blocks a £5 opening mismatch on cash but tolerates £0.50', () => {
    expect(OPENING_BALANCE_TOLERANCE).toBe(1.0);
    const bad = diffPriorPeriod(
      [prior('Cash', { accountType: 'Asset', closingBalance: 5000 })],
      [current('Cash', { accountType: 'Asset', balance: 5005 })],
    );
    expect(bad.mismatches).toHaveLength(1);
    expect(bad.mismatches[0]).toMatchObject({ code: 'OPENING_BALANCE_MISMATCH', delta: '5' });

    const ok = diffPriorPeriod(
      [prior('Cash', { accountType: 'Asset', closingBalance: 5000 })],
      [current('Cash', { accountType: 'Asset', balance: 5000.5 })],
    );
    expect(ok.mismatches).toHaveLength(0);
  });

  it('ignores P&L movement (revenue doubling is not a continuity break)', () => {
    const result = diffPriorPeriod(
      [prior('Sales revenue', { accountType: 'Income', closingBalance: -48000 })],
      [current('Sales revenue', { accountType: 'Income', balance: -96000 })],
    );
    expect(result.mismatches).toHaveLength(0);
  });

  it('treats low-similarity pairs as new + missing, never a rename', () => {
    const result = diffPriorPeriod([prior('Cash')], [current('Bank deposits')]);
    expect(result.renames).toHaveLength(0);
    expect(result.newAccounts).toHaveLength(1);
    expect(result.missingAccounts).toHaveLength(1);
  });

  it('handles empty inputs without crashing', () => {
    expect(bridgeItemCount(diffPriorPeriod([], []))).toBe(0);
    expect(diffPriorPeriod([], [current('Cash')]).newAccounts).toHaveLength(1);
  });
});
