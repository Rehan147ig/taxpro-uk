import { createHash, randomBytes, createCipheriv, createDecipheriv } from 'crypto';

/**
 * Xero OAuth2 client (PKCE) + Trial Balance report fetch.
 *
 * Two hard-won API details baked in:
 *  - Xero's TrialBalance report endpoint lives under api.xro (not api.xero.com):
 *      GET https://api.xero.com/api.xro/2.0/Reports/TrialBalance?fromDate=&toDate=
 *    and REQUIRES the `xero-tenant-id` header (organisation UUID) on every call.
 *  - The report comes back as a JSON tree of RowType Header/Section/Row nodes;
 *    balance values for the period are in cells[1] ("Debit" / "Credit" columns).
 *
 * Token exchange is done by the route (it has the DB transaction); this module
 * is pure HTTP + parsing so it stays unit-testable with a mocked fetch.
 */

export interface XeroTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: string; // ISO
}

export interface XeroTbLine {
  accountCode: string;
  accountName: string;
  balance: number; // net signed balance for the period (debit positive)
}

export interface XeroFetchResult {
  periodStart: string;
  periodEnd: string;
  lines: XeroTbLine[];
}

export interface XeroAuthUrlResult {
  url: string;
  codeVerifier: string;
  state: string;
}

export function buildAuthUrl(opts: {
  clientId: string;
  redirectUri: string;
  scopes?: string[];
}): XeroAuthUrlResult {
  const state = randomBytes(16).toString('hex');
  const codeVerifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(codeVerifier).digest('base64url');
  const scopes = opts.scopes ?? ['offline_access', 'accounting.reports.read', 'accounting.transactions.read'];
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    scope: scopes.join(' '),
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  return { url: `https://login.xero.com/identity/connect/authorize?${params}`, codeVerifier, state };
}

export async function exchangeCode(opts: {
  code: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  codeVerifier: string;
}): Promise<XeroTokens> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: opts.code,
    redirect_uri: opts.redirectUri,
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
    code_verifier: opts.codeVerifier,
  });
  const res = await fetch('https://identity.xero.com/connect/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) throw new Error(`Xero token exchange failed: ${res.status} ${await res.text()}`);
  const json = (await res.json()) as { access_token: string; refresh_token: string; expires_in: number };
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: new Date(Date.now() + (json.expires_in ?? 1800) * 1000).toISOString(),
  };
}

export async function refreshTokens(opts: {
  refreshToken: string;
  clientId: string;
  clientSecret: string;
}): Promise<XeroTokens> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: opts.refreshToken,
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
  });
  const res = await fetch('https://identity.xero.com/connect/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) throw new Error(`Xero token refresh failed: ${res.status} ${await res.text()}`);
  const json = (await res.json()) as { access_token: string; refresh_token: string; expires_in: number };
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: new Date(Date.now() + (json.expires_in ?? 1800) * 1000).toISOString(),
  };
}

export async function listOrganisations(accessToken: string): Promise<Array<{ tenantId: string; name: string }>> {
  const res = await fetch('https://api.xero.com/connections', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Xero connections failed: ${res.status}`);
  const json = (await res.json()) as Array<{ tenantId: string; tenantName?: string }>;
  return json.map(c => ({ tenantId: c.tenantId, name: c.tenantName ?? c.tenantId }));
}

export async function fetchTrialBalance(opts: {
  accessToken: string;
  xeroTenantId: string;
  periodStart: string; // YYYY-MM-DD
  periodEnd: string;   // YYYY-MM-DD
}): Promise<XeroFetchResult> {
  const url = new URL('https://api.xero.com/api.xro/2.0/Reports/TrialBalance');
  url.searchParams.set('fromDate', opts.periodStart);
  url.searchParams.set('toDate', opts.periodEnd);
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${opts.accessToken}`,
      'xero-tenant-id': opts.xeroTenantId,
      Accept: 'application/json',
    },
  });
  if (!res.ok) throw new Error(`Xero TrialBalance failed: ${res.status} ${await res.text()}`);

  const json = (await res.json()) as XeroReportEnvelope;
  return {
    periodStart: opts.periodStart,
    periodEnd: opts.periodEnd,
    lines: parseTrialBalanceRows(json),
  };
}

// ── Parsing (pure, unit-testable) ──

export interface XeroReportEnvelope {
  Reports?: Array<{
    ReportID?: string;
    ReportTitles?: string[];
    Rows?: XeroReportRow[];
  }>;
}

export interface XeroReportRow {
  RowType: 'Header' | 'Section' | 'Row' | 'SummaryRow';
  Title?: string;
  Cells?: Array<{ Value?: string }>;
  Rows?: XeroReportRow[];
}

export function parseTrialBalanceRows(envelope: XeroReportEnvelope): XeroTbLine[] {
  const report = envelope.Reports?.[0];
  if (!report?.Rows) return [];
  const lines: XeroTbLine[] = [];

  const walk = (rows: XeroReportRow[] | undefined) => {
    for (const row of rows ?? []) {
      if (row.RowType === 'Section' && row.Rows) {
        walk(row.Rows);
      } else if (row.RowType === 'Row' && row.Cells && row.Cells.length >= 3) {
        const code = row.Cells[0].Value ?? '';
        const name = row.Cells[1].Value ?? '';
        const debit = parseSigned(row.Cells[2]?.Value ?? '');
        const credit = parseSigned(row.Cells[3]?.Value ?? '');
        if (!code && !name) continue; // blank spacer rows
        lines.push({ accountCode: code, accountName: name, balance: round2(debit - credit) });
      } else if (row.Rows) {
        walk(row.Rows);
      }
    }
  };
  walk(report.Rows);
  return lines;
}

function parseSigned(v: string): number {
  const cleaned = v.replace(/[£$€,]/g, '').trim();
  if (!cleaned) return 0;
  let negative = false;
  let numeric = cleaned;
  if (/^\(.*\)$/.test(cleaned)) {
    negative = true;
    numeric = cleaned.slice(1, -1);
  } else if (/^-/.test(cleaned)) {
    negative = true;
    numeric = cleaned.replace(/^-/, '');
  }
  const n = Number(numeric);
  if (!Number.isFinite(n)) return 0;
  return negative ? -Math.abs(n) : Math.abs(n);
}

export function round2(n: number) {
  return Math.round(n * 100) / 100;
}

// ── ManualJournal push (TaxPro → Xero, locked runs only) ──
// POST https://api.xero.com/api.xro/2.0/ManualJournals
// Journals are created as DRAFT: the partner authorises inside Xero.
// Nothing is ever auto-authorised from TaxPro.

export interface XeroJournalPushLine {
  accountCode: string;
  description: string;
  /** Exactly one of debit / credit must be positive. */
  debit: number;
  credit: number;
  /** Xero tax type. 'NONE' keeps provision journals tax-neutral. */
  taxType?: string;
}

export interface XeroJournalPushInput {
  accessToken: string;
  xeroTenantId: string;
  narration: string;
  /** YYYY-MM-DD — the provision period-end. */
  date: string;
  lines: XeroJournalPushLine[];
}

export interface XeroJournalPushResult {
  manualJournalId: string;
  status: string;
}

export class XeroApiError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(status: number, body: string, message?: string) {
    super(message ?? `Xero API failed: ${status} ${body}`);
    this.name = 'XeroApiError';
    this.status = status;
    this.body = body;
  }
}

export interface XeroManualJournalResponse {
  ManualJournals?: Array<{ ManualJournalID?: string; Status?: string }>;
}

export async function pushManualJournal(input: XeroJournalPushInput): Promise<XeroJournalPushResult> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) {
    throw new XeroApiError(400, 'date must be YYYY-MM-DD');
  }
  if (input.lines.length === 0) throw new XeroApiError(400, 'journal has no lines');
  let totalDebit = 0;
  let totalCredit = 0;
  const journalLines = input.lines.map((l) => {
    if (!l.accountCode) throw new XeroApiError(400, 'every journal line needs a Xero AccountCode');
    const debit = round2(l.debit);
    const credit = round2(l.credit);
    if ((debit > 0 && credit > 0) || (debit === 0 && credit === 0)) {
      throw new XeroApiError(400, `line "${l.description}" must have exactly one of debit/credit positive`);
    }
    totalDebit = round2(totalDebit + debit);
    totalCredit = round2(totalCredit + credit);
    // Xero LineAmount convention: positive = debit, negative = credit.
    return {
      AccountCode: l.accountCode,
      Description: l.description,
      LineAmount: debit > 0 ? debit : -credit,
      TaxType: l.taxType ?? 'NONE',
    };
  });
  if (totalDebit <= 0 || totalDebit !== totalCredit) {
    throw new XeroApiError(400, `journal must balance: debit ${totalDebit} vs credit ${totalCredit}`);
  }

  const res = await fetch('https://api.xero.com/api.xro/2.0/ManualJournals', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${input.accessToken}`,
      'xero-tenant-id': input.xeroTenantId,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      ManualJournals: [{
        Narration: input.narration,
        Date: input.date,
        Status: 'DRAFT',
        ShowOnCashBasisReports: false,
        JournalLines: journalLines,
      }],
    }),
  });
  if (!res.ok) throw new XeroApiError(res.status, await res.text());
  const json = (await res.json()) as XeroManualJournalResponse;
  const journal = json.ManualJournals?.[0];
  if (!journal?.ManualJournalID) throw new XeroApiError(res.status, 'Xero returned no ManualJournalID');
  return { manualJournalId: journal.ManualJournalID, status: journal.Status ?? 'DRAFT' };
}

/**
 * Map a TaxPro journal-export document to Xero push lines.
 * Every internal account must map to an explicit Xero AccountCode supplied by
 * the partner — codes are never guessed. Zero lines are skipped. Throws on
 * unmapped accounts or an unbalanced result.
 */
export interface XeroAccountCodeMap {
  currentTaxExpense: string;
  corporationTaxPayable: string;
  deferredTaxExpense: string;
  deferredTaxProvision: string;
  deferredTaxAsset: string;
}

const INTERNAL_TO_CODE_KEY: Record<string, keyof XeroAccountCodeMap> = {
  'tax-expense-current': 'currentTaxExpense',
  'tax-payable': 'corporationTaxPayable',
  'tax-expense-deferred': 'deferredTaxExpense',
  'deferred-tax-liability': 'deferredTaxProvision',
  'deferred-tax-asset': 'deferredTaxAsset',
};

export function buildXeroPushLines(
  doc: { entries: Array<{ type: string; memo: string; lines: Array<{ accountId: string; accountName: string; memo: string; debit: number; credit: number }> }> },
  accountCodes: XeroAccountCodeMap,
): XeroJournalPushLine[] {
  for (const [key, code] of Object.entries(accountCodes)) {
    if (!code || !code.trim()) throw new XeroApiError(400, `missing Xero AccountCode mapping for "${key}"`);
  }
  const lines: XeroJournalPushLine[] = [];
  for (const entry of doc.entries) {
    for (const line of entry.lines) {
      if (line.debit === 0 && line.credit === 0) continue;
      const key = INTERNAL_TO_CODE_KEY[line.accountId];
      if (!key) {
        throw new XeroApiError(400, `no Xero AccountCode mapping for TaxPro account "${line.accountId}" (${line.accountName}) — map it explicitly before pushing`);
      }
      lines.push({
        accountCode: accountCodes[key].trim(),
        description: `${line.accountName} — ${line.memo || entry.memo}`.slice(0, 4000),
        debit: line.debit,
        credit: line.credit,
      });
    }
  }
  if (lines.length === 0) throw new XeroApiError(400, 'journal has no non-zero lines to push');
  return lines;
}

// ── Token field obfuscation (defense-in-depth for at-rest tokens) ──
// AES-256-GCM with an env-derived key. For production, inject TOKEN_ENCRYPTION_KEY
// and rotate it via KMS; the format prefix allows future migration.

const TOKEN_KEY = getTokenKey();

function getTokenKey(): Buffer {
  if (process.env.TOKEN_ENCRYPTION_KEY) {
    return createHash('sha256').update(process.env.TOKEN_ENCRYPTION_KEY).digest();
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'TOKEN_ENCRYPTION_KEY is not set. Refusing to start in production with a known fallback key.'
    );
  }
  return createHash('sha256').update('dev-only-key-do-not-use-in-prod').digest();
}

export function encryptToken(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', getTokenKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64url')}:${tag.toString('base64url')}:${enc.toString('base64url')}`;
}

export function decryptToken(payload: string): string {
  const [ver, ivB64, tagB64, dataB64] = payload.split(':');
  if (ver !== 'v1') throw new Error('Unsupported token format');
  const decipher = createDecipheriv('aes-256-gcm', getTokenKey(), Buffer.from(ivB64, 'base64url'), { authTagLength: 16 });
  decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64url')), decipher.final()]).toString('utf8');
}
