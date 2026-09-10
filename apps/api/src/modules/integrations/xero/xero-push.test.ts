import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { pushManualJournal, buildXeroPushLines, XeroApiError } from './xero-client.js';

const CODES = {
  currentTaxExpense: '810',
  corporationTaxPayable: '820',
  deferredTaxExpense: '811',
  deferredTaxProvision: '821',
  deferredTaxAsset: '822',
};

function docWith(lines: Array<{ accountId: string; accountName: string; debit: number; credit: number }>) {
  return {
    entries: [{ type: 'current_tax', memo: 'Current tax', lines: lines.map((l) => ({ ...l, memo: '' })) }],
  };
}

describe('buildXeroPushLines', () => {
  it('maps internal accounts to explicit Xero codes', () => {
    const lines = buildXeroPushLines(docWith([
      { accountId: 'tax-expense-current', accountName: 'Current tax expense', debit: 36000, credit: 0 },
      { accountId: 'tax-payable', accountName: 'Corporation tax payable', debit: 0, credit: 36000 },
    ]), CODES);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ accountCode: '810', debit: 36000, credit: 0 });
    expect(lines[1]).toMatchObject({ accountCode: '820', debit: 0, credit: 36000 });
  });

  it('skips zero lines', () => {
    const lines = buildXeroPushLines(docWith([
      { accountId: 'tax-expense-current', accountName: 'Current tax expense', debit: 36000, credit: 0 },
      { accountId: 'tax-payable', accountName: 'Corporation tax payable', debit: 0, credit: 36000 },
      { accountId: 'deferred-tax-liability', accountName: 'Deferred tax liability', debit: 0, credit: 0 },
    ]), CODES);
    expect(lines).toHaveLength(2);
  });

  it('refuses to guess missing AccountCode mappings', () => {
    expect(() => buildXeroPushLines(docWith([
      { accountId: 'tax-expense-current', accountName: 'Current tax expense', debit: 100, credit: 0 },
      { accountId: 'tax-payable', accountName: 'Corporation tax payable', debit: 0, credit: 100 },
    ]), { ...CODES, corporationTaxPayable: '' })).toThrow(/corporationTaxPayable/);
  });

  it('refuses unknown internal accounts instead of mis-posting', () => {
    expect(() => buildXeroPushLines(docWith([
      { accountId: 'valuation-allowance', accountName: 'Valuation allowance', debit: 50, credit: 0 },
      { accountId: 'tax-payable', accountName: 'Corporation tax payable', debit: 0, credit: 50 },
    ]), CODES)).toThrow(/valuation-allowance/);
  });

  it('refuses empty journals', () => {
    expect(() => buildXeroPushLines({ entries: [] }, CODES)).toThrow(/no non-zero lines/);
  });
});

describe('pushManualJournal', () => {
  beforeEach(() => { vi.stubGlobal('fetch', vi.fn()); });
  afterEach(() => { vi.unstubAllGlobals(); });

  const input = {
    accessToken: 'at',
    xeroTenantId: 'xt',
    narration: 'TaxPro provision journals',
    date: '2026-12-31',
    lines: [
      { accountCode: '810', description: 'CT charge', debit: 36000, credit: 0 },
      { accountCode: '820', description: 'CT creditor', debit: 0, credit: 36000 },
    ],
  };

  it('posts a DRAFT manual journal and parses the ID', async () => {
    (fetch as any).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ManualJournals: [{ ManualJournalID: 'mj-1', Status: 'DRAFT' }] }),
    });
    const res = await pushManualJournal(input);
    expect(res).toEqual({ manualJournalId: 'mj-1', status: 'DRAFT' });

    const [url, init] = (fetch as any).mock.calls[0];
    expect(url).toBe('https://api.xero.com/api.xro/2.0/ManualJournals');
    expect(init.headers['xero-tenant-id']).toBe('xt');
    const body = JSON.parse(init.body);
    expect(body.ManualJournals[0].Status).toBe('DRAFT');
    expect(body.ManualJournals[0].JournalLines).toHaveLength(2);
    // Xero LineAmount convention: debit positive, credit negative.
    expect(body.ManualJournals[0].JournalLines[0].LineAmount).toBe(36000);
    expect(body.ManualJournals[0].JournalLines[1].LineAmount).toBe(-36000);
    expect(body.ManualJournals[0].JournalLines[0].TaxType).toBe('NONE');
  });

  it('surfaces Xero 400 validation errors with the body', async () => {
    (fetch as any).mockResolvedValue({ ok: false, status: 400, text: async () => 'Account code 999 is invalid' });
    const err = await pushManualJournal(input).catch((e) => e);
    expect(err).toBeInstanceOf(XeroApiError);
    expect(err.status).toBe(400);
    expect(err.body).toMatch(/invalid/);
  });

  it('surfaces 401 so the caller can refresh and retry once', async () => {
    (fetch as any).mockResolvedValue({ ok: false, status: 401, text: async () => 'token expired' });
    const err = await pushManualJournal(input).catch((e) => e);
    expect(err).toBeInstanceOf(XeroApiError);
    expect(err.status).toBe(401);
  });

  it('refuses unbalanced journals client-side (never posts)', async () => {
    await expect(pushManualJournal({
      ...input,
      lines: [
        { accountCode: '810', description: 'a', debit: 100, credit: 0 },
        { accountCode: '820', description: 'b', debit: 0, credit: 99 },
      ],
    })).rejects.toThrow(/must balance/);
    expect((fetch as any).mock.calls).toHaveLength(0);
  });

  it('refuses zero journals and bad dates client-side', async () => {
    await expect(pushManualJournal({ ...input, lines: [] })).rejects.toThrow(/no lines/);
    await expect(pushManualJournal({ ...input, date: '31/12/2026' })).rejects.toThrow(/YYYY-MM-DD/);
    expect((fetch as any).mock.calls).toHaveLength(0);
  });
});
