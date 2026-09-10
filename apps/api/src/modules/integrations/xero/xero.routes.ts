import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { withTenantContext } from '../../../config/db.js';
import { xeroConnections } from '../../../db/schema/xero-connections.js';
import { entities } from '../../../db/schema/entities.js';
import { accounts } from '../../../db/schema/accounts.js';
import { trialBalance } from '../../../db/schema/trial-balance.js';
import { provisionRuns } from '../../../db/schema/provision-runs.js';
import { provisionResults } from '../../../db/schema/provision-results.js';
import { authMiddleware } from '../../../lib/middleware/auth.js';
import { getUser, requireRole } from '../../../lib/middleware/rbac.js';
import { AppError, BadRequestError } from '../../../lib/errors.js';
import { recordProvisionEvent, EVENT_TYPES } from '../../provision/provision-events.js';
import { buildJournalExport } from '../../export/journals.js';
import { encryptToken, decryptToken, buildAuthUrl, exchangeCode, refreshTokens, fetchTrialBalance, listOrganisations, pushManualJournal, buildXeroPushLines, XeroApiError } from './xero-client.js';

export const xeroRoutes = new Hono();
xeroRoutes.use('*', authMiddleware);

// Read per request (not at module load): supports credential rotation
// without a restart and lets tests inject dummy credentials.
function xeroCreds() {
  return {
    clientId: process.env.XERO_CLIENT_ID ?? '',
    clientSecret: process.env.XERO_CLIENT_SECRET ?? '',
    redirectUri: process.env.XERO_REDIRECT_URI ?? 'http://localhost:3000/api/xero/callback',
  };
}

const connectSchema = z.object({
  code: z.string(),
  state: z.string().optional(),
  codeVerifier: z.string().optional(),
  label: z.string().max(255).optional(),
});

xeroRoutes.post('/auth-url', async (c) => {
  const user = getUser(c);
  const { clientId, redirectUri } = xeroCreds();
  if (!clientId) throw new BadRequestError('XERO_CLIENT_ID not configured on the server');
  const { url, codeVerifier, state } = buildAuthUrl({
    clientId,
    redirectUri,
  });
  // code_verifier must survive the browser round-trip; it is returned to the
  // client and posted back with the callback. (MVP compromise — in production
  // keep it server-side keyed by state.)
  return c.json({ url, state, codeVerifier, tenantId: user.tenantId });
});

xeroRoutes.post('/callback', zValidator('json', connectSchema), async (c) => {
  const user = getUser(c);
  const { code, codeVerifier } = c.req.valid('json');
  if (!codeVerifier) throw new BadRequestError('codeVerifier is required (request a fresh auth-url)');
  const { clientId, clientSecret, redirectUri } = xeroCreds();
  if (!clientId || !clientSecret) throw new BadRequestError('Xero app credentials not configured');

  const tokens = await exchangeCode({ code, clientId, clientSecret, redirectUri, codeVerifier });
  const orgs = await listOrganisations(tokens.accessToken);
  if (orgs.length === 0) throw new BadRequestError('No Xero organisations connected to this app');

  return withTenantContext(user.tenantId, async (tx) => {
    const first = orgs[0];
    const [conn] = await tx.insert(xeroConnections).values({
      tenantId: user.tenantId,
      label: c.req.valid('json').label ?? `Xero — ${first.name}`,
      xeroTenantId: first.tenantId,
      accessToken: encryptToken(tokens.accessToken),
      refreshToken: encryptToken(tokens.refreshToken),
      tokenExpiresAt: new Date(tokens.expiresAt),
      syncStatus: 'connected',
    }).returning();
    return c.json({ id: conn.id, organisation: first.name, expiresAt: tokens.expiresAt });
  });
});

xeroRoutes.get('/connections', async (c) => {
  const user = getUser(c);
  return withTenantContext(user.tenantId, async (tx) => {
    const conns = await tx.select({
      id: xeroConnections.id,
      label: xeroConnections.label,
      xeroTenantId: xeroConnections.xeroTenantId,
      syncStatus: xeroConnections.syncStatus,
      lastSyncedAt: xeroConnections.lastSyncedAt,
    }).from(xeroConnections).where(eq(xeroConnections.tenantId, user.tenantId));
    return c.json(conns);
  });
});

xeroRoutes.post('/connections/:id/sync', zValidator('json', z.object({
  periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  entityName: z.string().max(255).optional(),
})), async (c) => {
  const user = getUser(c);
  const { periodStart, periodEnd, entityName } = c.req.valid('json');
  const connId = c.req.param('id');
  const { clientId, clientSecret } = xeroCreds();
  if (!clientId || !clientSecret) throw new BadRequestError('Xero app credentials not configured');

  return withTenantContext(user.tenantId, async (tx) => {
    const [conn] = await tx.select().from(xeroConnections)
      .where(and(eq(xeroConnections.id, connId), eq(xeroConnections.tenantId, user.tenantId))).limit(1);
    if (!conn) throw new BadRequestError('Xero connection not found');

    let accessToken = decryptToken(conn.accessToken);
    if (new Date(conn.tokenExpiresAt).getTime() < Date.now() + 60_000) {
      const refreshed = await refreshTokens({ refreshToken: decryptToken(conn.refreshToken), clientId, clientSecret });
      accessToken = refreshed.accessToken;
      await tx.update(xeroConnections).set({
        accessToken: encryptToken(refreshed.accessToken),
        refreshToken: encryptToken(refreshed.refreshToken),
        tokenExpiresAt: new Date(refreshed.expiresAt),
        updatedAt: new Date(),
      }).where(eq(xeroConnections.id, conn.id));
    }

    const tb = await fetchTrialBalance({ accessToken, xeroTenantId: conn.xeroTenantId, periodStart, periodEnd });

    // Import into the provisioning data model (same shape the upload route produces).
    const [entity] = await tx.insert(entities).values({
      tenantId: user.tenantId,
      externalId: conn.xeroTenantId,
      name: entityName ?? conn.label,
      type: 'domestic',
      currency: 'GBP',
      isConsolidated: true,
      taxJurisdiction: 'UK',
    }).onConflictDoUpdate({
      target: [entities.tenantId, entities.externalId],
      set: { name: entityName ?? conn.label, updatedAt: new Date() },
    }).returning();
    const entityId = entity.id;

    const periodKey = periodEnd;
    const fiscalYear = Number(periodEnd.slice(0, 4));
    let inserted = 0;
    for (const line of tb.lines) {
      if (!line.accountCode) continue;
      const [account] = await tx.insert(accounts).values({
        tenantId: user.tenantId,
        externalId: line.accountCode,
        accountNumber: line.accountCode,
        name: line.accountName || line.accountCode,
        type: guessAccountType(line.accountName),
        isSummary: false,
      }).onConflictDoUpdate({
        target: [accounts.tenantId, accounts.externalId],
        set: { name: line.accountName || line.accountCode, type: guessAccountType(line.accountName), updatedAt: new Date() },
      }).returning();

      await tx.insert(trialBalance).values({
        tenantId: user.tenantId,
        entityId,
        accountId: account.id,
        period: periodEnd,
        periodEnd,
        fiscalYear,
        fiscalPeriod: fiscalYear,
        balance: String(line.balance),
        source: 'xero',
      }).onConflictDoUpdate({
        target: [trialBalance.tenantId, trialBalance.entityId, trialBalance.accountId, trialBalance.period, trialBalance.source],
        set: { balance: String(line.balance) },
      });
      inserted++;
    }

    await tx.update(xeroConnections).set({ lastSyncedAt: new Date(), syncStatus: 'synced' }).where(eq(xeroConnections.id, conn.id));
    return c.json({ periodStart, periodEnd, linesFetched: tb.lines.length, rowsImported: inserted });
  });
});

// ── Push provision journals to Xero (locked runs only) ──
// Journals post as DRAFT — the partner authorises inside Xero. TaxPro never
// auto-authorises. Every push is recorded as an immutable provision event.

const accountCodesSchema = z.object({
  currentTaxExpense: z.string().min(1).max(20),
  corporationTaxPayable: z.string().min(1).max(20),
  deferredTaxExpense: z.string().min(1).max(20),
  deferredTaxProvision: z.string().min(1).max(20),
  deferredTaxAsset: z.string().min(1).max(20),
});

const pushJournalsSchema = z.object({
  connectionId: z.string().uuid(),
  accountCodes: accountCodesSchema,
  narration: z.string().max(200).optional(),
});

function toXeroError(err: unknown): never {
  if (err instanceof XeroApiError) {
    if (err.status === 400) throw new BadRequestError(`Xero rejected the journal: ${err.body}`);
    if (err.status === 401) throw new BadRequestError('Xero authorization failed — reconnect the Xero organisation and retry');
    throw new AppError(502, `Xero push failed: ${err.status} ${err.body}`);
  }
  throw err;
}

xeroRoutes.post('/push-journals/:runId',
  requireRole('partner', 'admin'),
  zValidator('json', pushJournalsSchema), async (c) => {
    const user = getUser(c);
    const runId = c.req.param('runId');
    const { connectionId, accountCodes, narration } = c.req.valid('json');
    const { clientId, clientSecret } = xeroCreds();
    if (!clientId || !clientSecret) throw new BadRequestError('Xero app credentials not configured');

    return withTenantContext(user.tenantId, async (tx) => {
      const [run] = await tx.select().from(provisionRuns)
        .where(and(eq(provisionRuns.id, runId), eq(provisionRuns.tenantId, user.tenantId))).limit(1);
      if (!run) throw new BadRequestError('Provision run not found');
      if (run.status !== 'locked') throw new BadRequestError('Run must be locked before journals can be pushed to Xero');
      if (!run.resultId) throw new BadRequestError('Run has no provision result to push');

      const [result] = await tx.select().from(provisionResults)
        .where(and(eq(provisionResults.id, run.resultId), eq(provisionResults.tenantId, user.tenantId))).limit(1);
      if (!result) throw new BadRequestError('Provision result not found');

      const doc = buildJournalExport({
        id: result.id,
        provisionRunId: result.provisionRunId,
        period: result.period,
        status: result.status ?? 'draft',
        currentTaxExpense: result.currentTaxExpense,
        deferredTaxExpense: result.deferredTaxExpense,
        totalTaxExpense: result.totalTaxExpense,
        bookIncome: result.bookIncome,
        taxPayable: result.taxPayable,
        detail: result.detail,
        createdAt: result.createdAt,
      }, {
        id: run.id,
        period: run.period,
        endPeriod: run.endPeriod,
        entityId: run.entityId,
        status: run.status,
        engineVersion: run.engineVersion,
      });
      if (!doc.controls.balanced) throw new BadRequestError('Journal export does not balance — refusing to push');
      let lines;
      try {
        lines = buildXeroPushLines(doc, accountCodes);
      } catch (err) {
        toXeroError(err);
      }

      const [conn] = await tx.select().from(xeroConnections)
        .where(and(eq(xeroConnections.id, connectionId), eq(xeroConnections.tenantId, user.tenantId))).limit(1);
      if (!conn) throw new BadRequestError('Xero connection not found');

      const storeRefreshed = async () => {
        const refreshed = await refreshTokens({ refreshToken: decryptToken(conn.refreshToken), clientId, clientSecret });
        await tx.update(xeroConnections).set({
          accessToken: encryptToken(refreshed.accessToken),
          refreshToken: encryptToken(refreshed.refreshToken),
          tokenExpiresAt: new Date(refreshed.expiresAt),
          updatedAt: new Date(),
        }).where(eq(xeroConnections.id, conn.id));
        return refreshed.accessToken;
      };

      const pushWith = async (accessToken: string) => pushManualJournal({
        accessToken,
        xeroTenantId: conn.xeroTenantId,
        narration: narration ?? `TaxPro provision journals — ${run.period} (run ${run.id.slice(0, 8)})`,
        date: String(run.endPeriod ?? run.period),
        lines,
      });

      let pushed;
      try {
        let accessToken = decryptToken(conn.accessToken);
        let refreshed = false;
        if (new Date(conn.tokenExpiresAt).getTime() < Date.now() + 60_000) {
          accessToken = await storeRefreshed();
          refreshed = true;
        }
        try {
          pushed = await pushWith(accessToken);
        } catch (err) {
          if (err instanceof XeroApiError && err.status === 401 && !refreshed) {
            accessToken = await storeRefreshed();
            pushed = await pushWith(accessToken);
          } else {
            throw err;
          }
        }
      } catch (err) {
        toXeroError(err);
      }

      await recordProvisionEvent({
        tenantId: user.tenantId,
        provisionRunId: run.id,
        eventType: EVENT_TYPES.XERO_JOURNALS_PUSHED,
        actorType: 'user',
        actorUserId: user.userId,
        reason: `Pushed ${lines.length} provision journal lines to Xero as ${pushed.manualJournalId} (${pushed.status})`,
        metadata: {
          manualJournalId: pushed.manualJournalId,
          status: pushed.status,
          connectionId: conn.id,
          resultId: result.id,
          totalDebit: doc.controls.totalDebit,
          totalCredit: doc.controls.totalCredit,
        },
      }, tx);

      return c.json({
        runId: run.id,
        manualJournalId: pushed.manualJournalId,
        status: pushed.status,
        lines: lines.length,
        totalDebit: doc.controls.totalDebit,
        totalCredit: doc.controls.totalCredit,
      });
    });
  });

function guessAccountType(name: string): string {  const n = (name ?? '').toLowerCase();
  if (/\b(sales|revenue|income|service fees)\b/.test(n)) return 'Income';
  if (/\b(cost of sales|cogs)\b/.test(n)) return 'COGS';
  if (/\b(rent|salary|wages|insurance|advertising|utilities|postage|travel|repairs)\b/.test(n)) return 'Expense';
  if (/\b(tax|vat|national insurance|paye)\b/.test(n)) return 'TaxLiability';
  if (/\b(debtors|creditors|cash|bank|stock|inventory|equipment|vehicles|prepayments|accruals)\b/.test(n)) return 'BalanceSheet';
  return 'BalanceSheet';
}
