import { rowToRecord } from './csv.js';
import type { ParsedCsvRow } from './csv.js';

/**
 * Deterministic trial-balance row validator.
 *
 * Validation is purely rule-based (no AI): every failure is a machine
 * readable error code that the review UI can group and the commit gate
 * can enforce. No internal implementation details are leaked to callers —
 * codes are stable, messages are operator-facing.
 */

export type ValidationSeverity = 'error' | 'warning';

export interface RowIssue {
  code: string;
  message: string;
  severity: ValidationSeverity;
  fields?: string[];
}

export interface NormalizedRow {
  entityName: string;
  entityExternalId: string;
  accountName: string;
  accountNumber: string;
  accountExternalId: string;
  accountType: string;
  detailType: string;
  period: string;
  periodEnd: string;
  debit: number;
  credit: number;
  balance: number;
  currency: string;
}

export interface RowValidationResult {
  status: 'ok' | 'error' | 'warning';
  normalized?: NormalizedRow;
  issues: RowIssue[];
}

export interface BatchValidationContext {
  periodStart: string;
  periodEnd: string;
  defaultCurrency: string;
}

export interface BatchValidationSummary {
  errorCount: number;
  warningCount: number;
  okCount: number;
  issues: Array<{ code: string; message: string; lineNumber?: number }>;
  controlTotals: {
    debitTotal: number;
    creditTotal: number;
    difference: number;
    balanced: boolean;
  };
}

const CONTROL_TOLERANCE = 1.0;

const ACCOUNT_TYPE_MAP: Record<string, string> = {
  income: 'Income',
  revenue: 'Income',
  sales: 'Income',
  service: 'Income',
  otherincome: 'Income',
  expense: 'Expense',
  cogs: 'Expense',
  costofgoodsold: 'Expense',
  otherexpense: 'Expense',
  operatingexpense: 'Expense',
  sga: 'Expense',
  sgana: 'Expense',
  asset: 'Asset',
  liability: 'Liability',
  equity: 'Equity',
};

const FIELD_ALIASES: Record<string, string[]> = {
  entityName: ['entityName', 'entity', 'subsidiary', 'legalEntity'],
  entityExternalId: ['entityExternalId', 'entityId', 'entity'],
  accountName: ['accountName', 'account', 'name'],
  accountNumber: ['accountNumber', 'accountNo', 'number'],
  accountExternalId: ['accountExternalId', 'accountId'],
  accountType: ['accountType', 'type'],
  detailType: ['detailType', 'accountDetailType'],
  period: ['period', 'periodStart', 'date'],
  periodEnd: ['periodEnd', 'endPeriod'],
  debit: ['debit', 'debits'],
  credit: ['credit', 'credits'],
  balance: ['balance', 'endingBalance', 'net'],
  currency: ['currency'],
};

function getField(row: Record<string, string>, key: string): string | undefined {
  const lower = new Map(Object.entries(row).map(([k, v]) => [k.toLowerCase().replace(/[\s_-]/g, ''), v]));
  for (const alias of FIELD_ALIASES[key]) {
    const value = lower.get(alias.toLowerCase().replace(/[\s_-]/g, ''));
    if (value?.trim()) return value.trim();
  }
  return undefined;
}

function parseAmount(value: string | undefined): number | undefined {
  if (value === undefined || value === '') return 0;
  const normalized = value.replace(/[£$€,\s]/g, '');
  const amount = Number(normalized);
  if (!Number.isFinite(amount)) return undefined;
  return amount;
}

function normalizeAccountType(value: string): string | undefined {
  const normalized = value.trim().toLowerCase();
  return ACCOUNT_TYPE_MAP[normalized];
}

export function validateRow(
  row: ParsedCsvRow,
  headers: string[],
  ctx: BatchValidationContext,
): RowValidationResult {
  const record = rowToRecord(headers, row.values);
  const issues: RowIssue[] = [];

  const accountName = getField(record, 'accountName');
  if (!accountName) {
    issues.push({ code: 'MISSING_REQUIRED', message: 'accountName is required', severity: 'error', fields: ['accountName'] });
  }

  const accountTypeRaw = getField(record, 'accountType');
  if (!accountTypeRaw) {
    issues.push({ code: 'MISSING_REQUIRED', message: 'accountType is required', severity: 'error', fields: ['accountType'] });
  }

  const period = getField(record, 'period');
  if (!period) {
    issues.push({ code: 'MISSING_REQUIRED', message: 'period is required', severity: 'error', fields: ['period'] });
  } else if (!/^\d{4}-\d{2}-\d{2}$/.test(period)) {
    issues.push({ code: 'INVALID_DATE', message: `period "${period}" is not a valid YYYY-MM-DD date`, severity: 'error', fields: ['period'] });
  } else if (ctx.periodStart && (period < ctx.periodStart || period > ctx.periodEnd)) {
    issues.push({
      code: 'PERIOD_OUT_OF_RANGE',
      message: `period ${period} is outside the accounting period ${ctx.periodStart}..${ctx.periodEnd}`,
      severity: 'error',
      fields: ['period'],
    });
  }

  const periodEnd = getField(record, 'periodEnd') ?? period ?? ctx.periodStart;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(periodEnd)) {
    issues.push({ code: 'INVALID_DATE', message: `periodEnd "${periodEnd}" is not a valid YYYY-MM-DD date`, severity: 'error', fields: ['periodEnd'] });
  }

  const debit = parseAmount(getField(record, 'debit'));
  const credit = parseAmount(getField(record, 'credit'));
  if (debit === undefined) {
    issues.push({ code: 'INVALID_AMOUNT', message: `debit "${getField(record, 'debit')}" is not a valid amount`, severity: 'error', fields: ['debit'] });
  }
  if (credit === undefined) {
    issues.push({ code: 'INVALID_AMOUNT', message: `credit "${getField(record, 'credit')}" is not a valid amount`, severity: 'error', fields: ['credit'] });
  }

  const balanceRaw = getField(record, 'balance');
  let balance: number | undefined;
  if (balanceRaw !== undefined && balanceRaw !== '') {
    balance = parseAmount(balanceRaw);
    if (balance === undefined) {
      issues.push({ code: 'INVALID_AMOUNT', message: `balance "${balanceRaw}" is not a valid amount`, severity: 'error', fields: ['balance'] });
    }
  } else if (debit !== undefined && credit !== undefined) {
    balance = debit - credit;
  }

  const currency = getField(record, 'currency') ?? ctx.defaultCurrency;
  if (!/^[A-Z]{3}$/.test(currency)) {
    issues.push({ code: 'INVALID_CURRENCY', message: `currency "${currency}" must be a 3-letter ISO code`, severity: 'error', fields: ['currency'] });
  } else if (currency !== 'GBP') {
    issues.push({
      code: 'INVALID_CURRENCY',
      message: `currency "${currency}" is not supported by this UK-FRS102 tenant; use GBP`,
      severity: 'error',
      fields: ['currency'],
    });
  }

  if (debit !== undefined && credit !== undefined && debit > 0 && credit > 0) {
    issues.push({
      code: 'AMOUNT_MISMATCH',
      message: 'row has both debit and credit; supply exactly one (or balance only)',
      severity: 'warning',
      fields: ['debit', 'credit'],
    });
  }

  const normalized: NormalizedRow = {
    entityName: getField(record, 'entityName') ?? 'Imported Entity',
    entityExternalId: slugify(getField(record, 'entityExternalId') ?? getField(record, 'entityName') ?? 'Imported Entity'),
    accountName: accountName ?? `Account ${row.lineNumber}`,
    accountNumber: getField(record, 'accountNumber') ?? '',
    accountExternalId: getField(record, 'accountExternalId') ?? `${getField(record, 'accountNumber') ?? slugify(accountName ?? '')}`,
    accountType: normalizeAccountType(accountTypeRaw ?? '') ?? 'Expense',
    detailType: getField(record, 'detailType') ?? normalizeAccountType(accountTypeRaw ?? '') ?? 'Expense',
    period: period ?? ctx.periodStart,
    periodEnd,
    debit: debit ?? 0,
    credit: credit ?? 0,
    balance: balance ?? 0,
    currency,
  };

  const hasErrors = issues.some((i) => i.severity === 'error');
  return {
    status: hasErrors ? 'error' : issues.length > 0 ? 'warning' : 'ok',
    normalized,
    issues,
  };
}

export function buildBatchSummary(
  results: Array<{ lineNumber: number; result: RowValidationResult }>,
): BatchValidationSummary {
  let errorCount = 0;
  let warningCount = 0;
  let okCount = 0;
  let debitTotal = 0;
  let creditTotal = 0;
  const issues: BatchValidationSummary['issues'] = [];

  for (const { lineNumber, result } of results) {
    if (result.status === 'error') errorCount++;
    else if (result.status === 'warning') warningCount++;
    else okCount++;
    for (const issue of result.issues) {
      issues.push({ code: issue.code, message: issue.message, lineNumber: issue.severity === 'error' ? lineNumber : undefined });
    }
    if (result.normalized) {
      debitTotal += result.normalized.debit;
      creditTotal += result.normalized.credit;
    }
  }

  const difference = Math.round((debitTotal - creditTotal) * 100) / 100;
  const balanced = Math.abs(difference) <= CONTROL_TOLERANCE;

  return {
    errorCount,
    warningCount,
    okCount,
    issues: issues.slice(0, 100),
    controlTotals: { debitTotal, creditTotal, difference, balanced },
  };
}

function slugify(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'imported';
}
