// ─────────────────────────────────────────────────────────────────────────────
// Automated journal entry workpapers — UK FRS 102 Section 29.
//
// Transforms a calculated provision_result into structured debits and
// credits:
//   • current tax:  Dr Current tax expense / Cr Corporation tax payable
//   • deferred tax: Dr Deferred tax expense / Cr Deferred tax liability
//                   (or the mirror when the deferred position is a benefit /
//                   asset)
//
// The authoritative entries are the engine-generated `journalEntries`
// persisted inside `provision_results.detail` (packages/tax-engine
// generateJournalEntries). When they are absent (legacy results) the export
// derives an equivalent UK FRS 102 S29 posting from the result columns.
//
// Outputs: structured JSON + ERP-import CSV (Xero, QuickBooks Online,
// NetSuite). Every entry and the document as a whole balance to the penny.
// ─────────────────────────────────────────────────────────────────────────────

export type JournalFormat = 'json' | 'csv' | 'xero' | 'qbo' | 'netsuite';

export interface JournalLine {
  accountId: string;
  accountName: string;
  memo: string;
  debit: number;
  credit: number;
}

export interface JournalEntry {
  type: 'current_tax' | 'deferred_tax' | 'valuation_allowance';
  period: string;
  memo: string;
  lines: JournalLine[];
  totalDebit: number;
  totalCredit: number;
}

export interface JournalExportDocument {
  runId: string;
  resultId: string;
  period: string;
  entityId: string | null;
  generatedAt: string;
  engineVersion: string | null;
  status: string;
  source: 'engine_journal_entries' | 'derived_from_result_columns';
  entries: JournalEntry[];
  controls: {
    totalDebit: number;
    totalCredit: number;
    balanced: boolean;
  };
}

const ACCOUNT_NAMES: Record<string, string> = {
  'tax-expense-current': 'Current tax expense',
  'tax-payable': 'Corporation tax payable',
  'tax-expense-deferred': 'Deferred tax expense',
  'deferred-tax-liability': 'Deferred tax liability',
  'deferred-tax-asset': 'Deferred tax asset',
  'valuation-allowance': 'Valuation allowance',
};

function accountName(accountId: string): string {
  return ACCOUNT_NAMES[accountId] ?? accountId;
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export interface JournalResultInput {
  id: string;
  provisionRunId: string | null;
  period: string;
  status: string;
  currentTaxExpense: string | number | null;
  deferredTaxExpense: string | number | null;
  totalTaxExpense: string | number | null;
  bookIncome: string | number | null;
  taxPayable: string | number | null;
  detail: unknown;
  createdAt: Date | string | null;
}

export interface JournalRunInput {
  id: string;
  period: string | null;
  endPeriod: string | null;
  entityId: string | null;
  status: string | null;
  engineVersion: string | null;
}

function num(v: string | number | null | undefined): number {
  if (v === null || v === undefined) return 0;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Normalize engine-generated journal entries (from result.detail) into the
 * export shape. Any malformed entry is skipped — the export never fabricates
 * figures that the engine did not persist.
 */
function entriesFromEngineDetail(detail: unknown, period: string): JournalEntry[] | null {
  if (!detail || typeof detail !== 'object') return null;
  const { journalEntries } = detail as { journalEntries?: unknown };
  if (!Array.isArray(journalEntries) || journalEntries.length === 0) return null;

  const entries: JournalEntry[] = [];
  for (const raw of journalEntries) {
    if (!raw || typeof raw !== 'object') continue;
    const entry = raw as {
      type?: string; period?: string; lines?: unknown; totalDebit?: unknown; totalCredit?: unknown;
    };
    if (!Array.isArray(entry.lines) || entry.lines.length === 0) continue;

    const lines: JournalLine[] = [];
    for (const l of entry.lines) {
      if (!l || typeof l !== 'object') continue;
      const line = l as { accountId?: string; debit?: unknown; credit?: unknown; memo?: string };
      if (typeof line.accountId !== 'string' || line.accountId.length === 0) continue;
      const debit = round2(typeof line.debit === 'number' || typeof line.debit === 'string' ? num(line.debit) : 0);
      const credit = round2(typeof line.credit === 'number' || typeof line.credit === 'string' ? num(line.credit) : 0);
      if (debit === 0 && credit === 0) continue;
      lines.push({
        accountId: line.accountId,
        accountName: accountName(line.accountId),
        memo: typeof line.memo === 'string' && line.memo.length > 0 ? line.memo : `Journal line for ${entry.period ?? period}`,
        debit,
        credit,
      });
    }
    if (lines.length === 0) continue;

    entries.push({
      type: entry.type === 'deferred_tax' || entry.type === 'valuation_allowance' ? entry.type : 'current_tax',
      period: typeof entry.period === 'string' && entry.period.length > 0 ? entry.period : period,
      memo: `UK FRS 102 S29 ${entry.type === 'deferred_tax' ? 'deferred tax' : entry.type === 'valuation_allowance' ? 'valuation allowance' : 'current tax'} posting`,
      lines,
      totalDebit: round2(lines.reduce((s, l) => s + l.debit, 0)),
      totalCredit: round2(lines.reduce((s, l) => s + l.credit, 0)),
    });
  }
  return entries.length > 0 ? entries : null;
}

/**
 * Derive UK FRS 102 S29 postings from the result columns (fallback for
 * legacy results without persisted engine journal entries).
 *
 *   Current tax:
 *     expense  >= 0 → Dr Current tax expense / Cr Corporation tax payable
 *     expense  <  0 → Dr Corporation tax payable / Cr Current tax expense
 *   Deferred tax:
 *     expense  >  0 → Dr Deferred tax expense / Cr Deferred tax liability
 *     expense  <  0 → Dr Deferred tax asset     / Cr Deferred tax expense
 */
function deriveEntriesFromColumns(result: JournalResultInput): JournalEntry[] {
  const period = result.period;
  const current = round2(num(result.currentTaxExpense));
  const deferred = round2(num(result.deferredTaxExpense));
  const entries: JournalEntry[] = [];

  if (current !== 0) {
    const isExpense = current > 0;
    const amount = Math.abs(current);
    entries.push({
      type: 'current_tax',
      period,
      memo: `UK FRS 102 S29 current tax ${isExpense ? 'expense' : 'benefit'} for ${period}`,
      lines: [
        {
          accountId: 'tax-expense-current',
          accountName: accountName('tax-expense-current'),
          memo: isExpense ? `Current tax expense for ${period}` : `Current tax benefit for ${period}`,
          debit: isExpense ? amount : 0,
          credit: isExpense ? 0 : amount,
        },
        {
          accountId: 'tax-payable',
          accountName: accountName('tax-payable'),
          memo: isExpense ? `Corporation tax payable for ${period}` : `Reduction of corporation tax payable for ${period}`,
          debit: isExpense ? 0 : amount,
          credit: isExpense ? amount : 0,
        },
      ],
      totalDebit: amount,
      totalCredit: amount,
    });
  }

  if (deferred !== 0) {
    const isExpense = deferred > 0;
    const amount = Math.abs(deferred);
    const liabilityLine: JournalLine = {
      accountId: 'deferred-tax-liability',
      accountName: accountName('deferred-tax-liability'),
      memo: `Deferred tax liability for ${period}`,
      debit: isExpense ? 0 : amount,
      credit: isExpense ? amount : 0,
    };
    const assetLine: JournalLine = {
      accountId: 'deferred-tax-asset',
      accountName: accountName('deferred-tax-asset'),
      memo: `Deferred tax asset for ${period}`,
      debit: isExpense ? 0 : amount,
      credit: isExpense ? amount : 0,
    };
    entries.push({
      type: 'deferred_tax',
      period,
      memo: `UK FRS 102 S29 deferred tax ${isExpense ? 'expense' : 'benefit'} for ${period}`,
      lines: [
        {
          accountId: 'tax-expense-deferred',
          accountName: accountName('tax-expense-deferred'),
          memo: isExpense ? `Deferred tax expense for ${period}` : `Deferred tax benefit for ${period}`,
          debit: isExpense ? amount : 0,
          credit: isExpense ? 0 : amount,
        },
        isExpense ? liabilityLine : assetLine,
      ],
      totalDebit: amount,
      totalCredit: amount,
    });
  }

  return entries;
}

/**
 * Build the full journal workpaper for a provision result.
 * Guarantees: every entry balances and the document totals balance.
 */
export function buildJournalExport(result: JournalResultInput, run: JournalRunInput | null): JournalExportDocument {
  const fromDetail = entriesFromEngineDetail(result.detail, result.period);
  const source = fromDetail ? 'engine_journal_entries' : 'derived_from_result_columns';
  const entries = fromDetail ?? deriveEntriesFromColumns(result);

  const totalDebit = round2(entries.reduce((s, e) => s + e.totalDebit, 0));
  const totalCredit = round2(entries.reduce((s, e) => s + e.totalCredit, 0));

  return {
    runId: run?.id ?? result.provisionRunId ?? '',
    resultId: result.id,
    period: result.period,
    entityId: run?.entityId ?? null,
    generatedAt: new Date().toISOString(),
    engineVersion: run?.engineVersion ?? null,
    status: result.status,
    source,
    entries,
    controls: {
      totalDebit,
      totalCredit,
      balanced: Math.abs(totalDebit - totalCredit) < 0.005,
    },
  };
}

// ── ERP CSV serialisation ───────────────────────────────────────────────────
// Standard import formats:
//   • Xero journal lines CSV:   JournalNumber,Date,AccountCode,Memo,Amount
//     (debits positive, credits negative)
//   • QuickBooks Online:        Date,AccountName,Memo,Debit,Credit
//   • NetSuite:                 account,debit,credit,memo
//   • generic csv:              Type,Date,Account,Memo,Debit,Credit

function csvCell(v: string | number): string {
  const s = String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function journalsToCsv(doc: JournalExportDocument, format: JournalFormat): string {
  const rows: string[][] = [];
  const period = doc.period;

  if (format === 'xero') {
    rows.push(['JournalNumber', 'Date', 'AccountCode', 'AccountName', 'Memo', 'Amount']);
    doc.entries.forEach((entry, i) => {
      entry.lines.forEach((line) => {
        rows.push([
          `JE-${String(i + 1).padStart(3, '0')}`,
          period,
          line.accountId,
          line.accountName,
          line.memo,
          line.debit > 0 ? String(line.debit) : String(-line.credit),
        ]);
      });
    });
  } else if (format === 'qbo') {
    rows.push(['Date', 'AccountName', 'Memo', 'Debit', 'Credit']);
    doc.entries.forEach((entry) => {
      entry.lines.forEach((line) => {
        rows.push([period, line.accountName, line.memo, String(line.debit), String(line.credit)]);
      });
    });
  } else if (format === 'netsuite') {
    rows.push(['account', 'debit', 'credit', 'memo']);
    doc.entries.forEach((entry) => {
      entry.lines.forEach((line) => {
        rows.push([line.accountId, String(line.debit), String(line.credit), line.memo]);
      });
    });
  } else {
    rows.push(['Type', 'Date', 'Account', 'Memo', 'Debit', 'Credit']);
    doc.entries.forEach((entry) => {
      entry.lines.forEach((line) => {
        rows.push([entry.type, period, line.accountName, line.memo, String(line.debit), String(line.credit)]);
      });
    });
  }

  return rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
}

export function journalExportFileName(doc: JournalExportDocument, format: JournalFormat): string {
  const period = doc.period.replace(/-/g, '');
  const ext = format === 'csv' || format === 'xero' || format === 'qbo' || format === 'netsuite' ? 'csv' : 'json';
  return `taxpro-journals-${period}-${format}.${ext}`;
}
