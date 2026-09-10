// ─────────────────────────────────────────────────────────────────────────────
// Xero journal push — live-DB route tests (run in CI with Postgres).
// Mocks only the Xero HTTP boundary (global fetch); everything else
// (tenancy, lock gate, RBAC, token refresh, audit event) runs for real.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Hono } from 'hono';
import jwt from 'jsonwebtoken';
import { and, eq } from 'drizzle-orm';
import crypto from 'crypto';
import { withTenantContext } from '../config/db.js';
import { env } from '../config/env.js';
import { errorHandler } from '../lib/middleware/error-handler.js';
import { xeroRoutes } from '../modules/integrations/xero/xero.routes.js';
import { tenants } from '../db/schema/tenants.js';
import { users } from '../db/schema/users.js';
import { entities } from '../db/schema/entities.js';
import { provisionRuns } from '../db/schema/provision-runs.js';
import { provisionResults } from '../db/schema/provision-results.js';
import { provisionEvents } from '../db/schema/provision-events.js';
import { xeroConnections } from '../db/schema/xero-connections.js';
import { encryptToken } from '../modules/integrations/xero/xero-client.js';

const TENANT_A = crypto.randomUUID();
const TENANT_B = crypto.randomUUID();
const USER_PARTNER = crypto.randomUUID();
const USER_PREPARER = crypto.randomUUID();
const USER_B = crypto.randomUUID();
const ENTITY_A = crypto.randomUUID();
const RUN_LOCKED = crypto.randomUUID();
const RUN_OPEN = crypto.randomUUID();
const RESULT_LOCKED = crypto.randomUUID();
const CONN_A = crypto.randomUUID();

const app = new Hono();
app.onError(errorHandler);
app.route('/api/xero', xeroRoutes);

function tokenFor(userId: string, tenantId: string, role = 'partner'): string {
  return jwt.sign({ userId, tenantId, email: 'xero-push@test.local', role }, env.JWT_SECRET, { expiresIn: '1h' });
}
const TOKEN_PARTNER = tokenFor(USER_PARTNER, TENANT_A, 'partner');
const TOKEN_PREPARER = tokenFor(USER_PREPARER, TENANT_A, 'preparer');
const TOKEN_B = tokenFor(USER_B, TENANT_B, 'partner');

const CODES = {
  currentTaxExpense: '810',
  corporationTaxPayable: '820',
  deferredTaxExpense: '811',
  deferredTaxProvision: '821',
  deferredTaxAsset: '822',
};
const body = (connectionId: string) => JSON.stringify({ connectionId, accountCodes: CODES });

function mockXeroJournalsOk(id = 'mj-123') {
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: any) => {
    const u = String(url);
    if (u.includes('identity.xero.com')) {
      return { ok: true, json: async () => ({ access_token: 'refreshed', refresh_token: 'r2', expires_in: 1800 }) };
    }
    return { ok: true, status: 200, json: async () => ({ ManualJournals: [{ ManualJournalID: id, Status: 'DRAFT' }] }) };
  }));
}

beforeAll(async () => {
  // Routes read Xero credentials per request: dummy values exercise the
  // push logic with fully mocked HTTP (no real Xero calls).
  process.env.XERO_CLIENT_ID = 'test-client-id';
  process.env.XERO_CLIENT_SECRET = 'test-client-secret';
  for (const [tid, uid, role] of [
    [TENANT_A, USER_PARTNER, 'partner'],
    [TENANT_A, USER_PREPARER, 'preparer'],
    [TENANT_B, USER_B, 'partner'],
  ] as const) {
    await withTenantContext(tid, async (tx) => {
      await tx.insert(tenants).values({ id: tid, name: `XeroPush ${tid.slice(0, 8)}`, slug: tid, taxRate: '0.25' }).onConflictDoNothing();
      await tx.insert(users).values({ id: uid, tenantId: tid, email: `xpush-${uid.slice(0, 8)}@test.local`, passwordHash: 'x', role }).onConflictDoNothing();
    });
  }
  await withTenantContext(TENANT_A, async (tx) => {
    await tx.insert(entities).values({ id: ENTITY_A, tenantId: TENANT_A, externalId: 'XPUSH-ENT', name: 'XPush Ltd', type: 'Limited Company', currency: 'GBP', taxJurisdiction: 'UK_FRS102' }).onConflictDoNothing();
    // Runs before results: provision_results.provision_run_id is a real FK.
    await tx.insert(provisionRuns).values({ id: RUN_LOCKED, tenantId: TENANT_A, period: '2026-01-01', endPeriod: '2026-12-31', entityId: ENTITY_A, status: 'locked', approvalStatus: 'approved', resultId: RESULT_LOCKED }).onConflictDoNothing();
    await tx.insert(provisionRuns).values({ id: RUN_OPEN, tenantId: TENANT_A, period: '2026-01-01', entityId: ENTITY_A, status: 'needs_review', approvalStatus: 'pending' }).onConflictDoNothing();
    await tx.insert(provisionResults).values({
      id: RESULT_LOCKED, tenantId: TENANT_A, provisionRunId: RUN_LOCKED, period: '2026-01-01',
      status: 'draft', currentTaxExpense: '36000', deferredTaxExpense: '0', totalTaxExpense: '36000',
      bookIncome: '125000', taxPayable: '36000', detail: null,
    }).onConflictDoNothing();
    await tx.insert(xeroConnections).values({
      id: CONN_A, tenantId: TENANT_A, label: 'Xero — XPush', xeroTenantId: 'xero-org-1',
      accessToken: encryptToken('valid-access'), refreshToken: encryptToken('valid-refresh'),
      tokenExpiresAt: new Date(Date.now() + 3600_000), syncStatus: 'connected',
    }).onConflictDoNothing();
  });
});

afterAll(() => {
  vi.unstubAllGlobals();
  delete process.env.XERO_CLIENT_ID;
  delete process.env.XERO_CLIENT_SECRET;
});

describe('POST /api/xero/push-journals/:runId', () => {
  it('refuses non-partner roles (RBAC)', async () => {
    const res = await app.request(`/api/xero/push-journals/${RUN_LOCKED}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN_PREPARER}` },
      body: body(CONN_A),
    });
    expect(res.status).toBe(403);
  });

  it('refuses unlocked runs (lock gate)', async () => {
    const res = await app.request(`/api/xero/push-journals/${RUN_OPEN}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN_PARTNER}` },
      body: body(CONN_A),
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/locked/i);
  });

  it('refuses cross-tenant pushes (isolation)', async () => {
    const res = await app.request(`/api/xero/push-journals/${RUN_LOCKED}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN_B}` },
      body: body(CONN_A),
    });
    expect([400, 403, 404]).toContain(res.status);
  });

  it('pushes balanced journals as DRAFT and records the audit event', async () => {
    mockXeroJournalsOk('mj-123');
    try {
      const res = await app.request(`/api/xero/push-journals/${RUN_LOCKED}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN_PARTNER}` },
        body: body(CONN_A),
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as any;
      expect(json.manualJournalId).toBe('mj-123');
      expect(json.status).toBe('DRAFT');
      expect(json.totalDebit).toBe(json.totalCredit);

      const events = await withTenantContext(TENANT_A, async (tx) =>
        tx.select().from(provisionEvents).where(and(eq(provisionEvents.provisionRunId, RUN_LOCKED), eq(provisionEvents.eventType, 'xero.journals_pushed'))),
      );
      expect(events.length).toBeGreaterThan(0);
      expect(JSON.stringify(events[events.length - 1].metadata)).toContain('mj-123');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('refreshes an expired token and retries once', async () => {
    await withTenantContext(TENANT_A, async (tx) => {
      await tx.update(xeroConnections).set({ tokenExpiresAt: new Date(Date.now() - 1000) }).where(eq(xeroConnections.id, CONN_A));
    });
    const seen: string[] = [];
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: any) => {
      const u = String(url);
      seen.push(u);
      if (u.includes('identity.xero.com')) {
        return { ok: true, json: async () => ({ access_token: 'fresh', refresh_token: 'fresh-r', expires_in: 1800 }) };
      }
      return { ok: true, status: 200, json: async () => ({ ManualJournals: [{ ManualJournalID: 'mj-retry', Status: 'DRAFT' }] }) };
    }));
    try {
      const res = await app.request(`/api/xero/push-journals/${RUN_LOCKED}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN_PARTNER}` },
        body: body(CONN_A),
      });
      expect(res.status).toBe(200);
      expect(((await res.json()) as any).manualJournalId).toBe('mj-retry');
      expect(seen.some((u) => u.includes('identity.xero.com'))).toBe(true);
    } finally {
      vi.unstubAllGlobals();
      await withTenantContext(TENANT_A, async (tx) => {
        await tx.update(xeroConnections).set({ tokenExpiresAt: new Date(Date.now() + 3600_000) }).where(eq(xeroConnections.id, CONN_A));
      });
    }
  });

  it('surfaces Xero 400 validation errors as 400', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 400, text: async () => 'Account code 810 is invalid' }));
    try {
      const res = await app.request(`/api/xero/push-journals/${RUN_LOCKED}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN_PARTNER}` },
        body: body(CONN_A),
      });
      expect(res.status).toBe(400);
      expect(await res.text()).toMatch(/invalid/i);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
