// ─────────────────────────────────────────────────────────────────────────────
// Feature 5 — asset register routes (DB-backed; runs in CI with Postgres).
// Covers: bulk insert + retrieval, tenant isolation (404 across tenants),
// soft delete (excluded from GET, second DELETE 404s), deterministic
// validation codes, RBAC floors, and the flag-off 403. Pure validation and
// engine-feed math live in modules/intake/asset-register.test.ts.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Hono } from 'hono';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { and, eq } from 'drizzle-orm';
import { withTenantContext } from '../config/db.js';
import { env } from '../config/env.js';
import { errorHandler } from '../lib/middleware/error-handler.js';
import { intakeRoutes } from '../modules/intake/intake.routes.js';
import { tenants } from '../db/schema/tenants.js';
import { users } from '../db/schema/users.js';
import { entities } from '../db/schema/entities.js';
import { assetRegisterItems } from '../db/schema/asset-register.js';

const FLAG_ORIGINAL = process.env.INTAKE_ASSET_REGISTER;

const TENANT_A = crypto.randomUUID();
const TENANT_B = crypto.randomUUID();
const ADMIN_A = crypto.randomUUID();
const REVIEWER_A = crypto.randomUUID();
const PREPARER_A = crypto.randomUUID();
const ADMIN_B = crypto.randomUUID();
const ENTITY_A = crypto.randomUUID();
const ENTITY_B = crypto.randomUUID();

const app = new Hono();
app.onError(errorHandler);
app.route('/api/intake', intakeRoutes);

function tokenFor(userId: string, tenantId: string, role: string): string {
  return jwt.sign({ userId, tenantId, email: `asset-${role}-${tenantId.slice(0, 8)}@test.local`, role }, env.JWT_SECRET, { expiresIn: '1h' });
}

const TOKEN_ADMIN_A = tokenFor(ADMIN_A, TENANT_A, 'admin');
const TOKEN_REVIEWER_A = tokenFor(REVIEWER_A, TENANT_A, 'reviewer');
const TOKEN_PREPARER_A = tokenFor(PREPARER_A, TENANT_A, 'preparer');
const TOKEN_ADMIN_B = tokenFor(ADMIN_B, TENANT_B, 'admin');

const ITEMS = [
  {
    assetDescription: 'CNC milling machine',
    cost: 120000,
    poolType: 'main',
    placedInServiceDate: '2026-04-01',
    accountExternalId: '1520',
  },
  {
    assetDescription: 'Delivery van',
    cost: 28000,
    poolType: 'single_asset',
    placedInServiceDate: '2026-05-15',
    disposalDate: '2026-11-01',
    disposalProceeds: 5000,
  },
];

let itemOneId = '';

beforeAll(async () => {
  process.env.INTAKE_ASSET_REGISTER = 'true';
  for (const [tid, uid, eid] of [
    [TENANT_A, ADMIN_A, ENTITY_A],
    [TENANT_B, ADMIN_B, ENTITY_B],
  ] as const) {
    await withTenantContext(tid, async (tx) => {
      await tx.insert(tenants).values({ id: tid, name: `Asset ${tid.slice(0, 8)}`, slug: tid, taxRate: '0.25' }).onConflictDoNothing();
      await tx.insert(users).values({ id: uid, tenantId: tid, email: `asset-admin-${tid.slice(0, 8)}@test.local`, passwordHash: 'x', role: 'admin' }).onConflictDoNothing();
      await tx.insert(entities).values({
        id: eid, tenantId: tid, externalId: eid, name: 'Asset Entity', type: 'Limited Company',
        currency: 'GBP', taxJurisdiction: 'UK_FRS102', isConsolidated: false,
      }).onConflictDoNothing();
    });
  }
  await withTenantContext(TENANT_A, async (tx) => {
    for (const [id, role] of [[REVIEWER_A, 'reviewer'], [PREPARER_A, 'preparer']] as const) {
      await tx.insert(users).values({ id, tenantId: TENANT_A, email: `asset-${role}@test.local`, passwordHash: 'x', role }).onConflictDoNothing();
    }
  });
});

afterAll(async () => {
  if (FLAG_ORIGINAL === undefined) delete process.env.INTAKE_ASSET_REGISTER;
  else process.env.INTAKE_ASSET_REGISTER = FLAG_ORIGINAL;
  for (const tid of [TENANT_A, TENANT_B]) {
    await withTenantContext(tid, async (tx) => {
      await Promise.allSettled([
        tx.delete(assetRegisterItems).where(eq(assetRegisterItems.tenantId, tid)),
        tx.delete(entities).where(eq(entities.tenantId, tid)),
        tx.delete(users).where(eq(users.tenantId, tid)),
        tx.delete(tenants).where(eq(tenants.id, tid)),
      ]);
    });
  }
});

describe('Feature 5 — asset register routes', () => {
  it('bulk-inserts items as a preparer and reads them back as a reviewer', async () => {
    const post = await app.request(`/api/intake/entities/${ENTITY_A}/assets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN_PREPARER_A}` },
      body: JSON.stringify({ items: ITEMS }),
    });
    expect(post.status).toBe(201);
    const created = await post.json();
    expect(created.count).toBe(2);
    itemOneId = created.items[0].id;

    const get = await app.request(`/api/intake/entities/${ENTITY_A}/assets`, {
      headers: { Authorization: `Bearer ${TOKEN_REVIEWER_A}` },
    });
    expect(get.status).toBe(200);
    const body = await get.json();
    expect(body.items).toHaveLength(2);
    expect(body.items.map((i: { assetDescription: string }) => i.assetDescription).sort())
      .toEqual(['CNC milling machine', 'Delivery van']);
  });

  it('enforces RBAC: preparer cannot list, readonly cannot insert', async () => {
    const asPreparer = await app.request(`/api/intake/entities/${ENTITY_A}/assets`, {
      headers: { Authorization: `Bearer ${TOKEN_PREPARER_A}` },
    });
    expect(asPreparer.status).toBe(403);

    const readonlyToken = tokenFor(ADMIN_A, TENANT_A, 'client_readonly');
    const asReadonly = await app.request(`/api/intake/entities/${ENTITY_A}/assets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${readonlyToken}` },
      body: JSON.stringify({ items: ITEMS.slice(0, 1) }),
    });
    expect(asReadonly.status).toBe(403);
  });

  it('isolates tenants: B cannot read, insert into, or delete under A', async () => {
    const get = await app.request(`/api/intake/entities/${ENTITY_A}/assets`, {
      headers: { Authorization: `Bearer ${TOKEN_ADMIN_B}` },
    });
    // Tenant-scoped entity lookup fails closed (404, never an existence oracle).
    expect(get.status).toBe(404);

    const del = await app.request(`/api/intake/entities/${ENTITY_A}/assets/${itemOneId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${TOKEN_ADMIN_B}` },
    });
    expect(del.status).toBe(404);

    const stillThere = await withTenantContext(TENANT_A, async (tx) =>
      tx.select().from(assetRegisterItems).where(and(eq(assetRegisterItems.tenantId, TENANT_A), eq(assetRegisterItems.isActive, true))));
    expect(stillThere).toHaveLength(2);
  });

  it('soft-deletes: item leaves GET results and second DELETE 404s', async () => {
    const del = await app.request(`/api/intake/entities/${ENTITY_A}/assets/${itemOneId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${TOKEN_ADMIN_A}` },
    });
    expect(del.status).toBe(200);
    expect((await del.json()).item.isActive).toBe(false);

    const get = await app.request(`/api/intake/entities/${ENTITY_A}/assets`, {
      headers: { Authorization: `Bearer ${TOKEN_REVIEWER_A}` },
    });
    expect((await get.json()).items).toHaveLength(1);

    const again = await app.request(`/api/intake/entities/${ENTITY_A}/assets/${itemOneId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${TOKEN_ADMIN_A}` },
    });
    expect(again.status).toBe(404);
  });

  it('rejects invalid payloads with stable codes', async () => {
    const badPool = await app.request(`/api/intake/entities/${ENTITY_A}/assets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN_ADMIN_A}` },
      body: JSON.stringify({ items: [{ ...ITEMS[0], poolType: 'hyper_pool' }] }),
    });
    expect(badPool.status).toBe(400);
    expect(await badPool.text()).toContain('INVALID_POOL_TYPE');

    const badDates = await app.request(`/api/intake/entities/${ENTITY_A}/assets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN_ADMIN_A}` },
      body: JSON.stringify({
        items: [{ ...ITEMS[0], placedInServiceDate: '2026-04-01', disposalDate: '2026-03-01', disposalProceeds: 100 }],
      }),
    });
    expect(badDates.status).toBe(400);
    expect(await badDates.text()).toContain('DISPOSAL_BEFORE_ACQUISITION');
  });

  it('returns 403 on all three routes when the flag is off', async () => {
    process.env.INTAKE_ASSET_REGISTER = 'false';
    try {
      const get = await app.request(`/api/intake/entities/${ENTITY_A}/assets`, {
        headers: { Authorization: `Bearer ${TOKEN_REVIEWER_A}` },
      });
      expect(get.status).toBe(403);
      const post = await app.request(`/api/intake/entities/${ENTITY_A}/assets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN_ADMIN_A}` },
        body: JSON.stringify({ items: ITEMS.slice(0, 1) }),
      });
      expect(post.status).toBe(403);
      const del = await app.request(`/api/intake/entities/${ENTITY_A}/assets/${itemOneId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${TOKEN_ADMIN_A}` },
      });
      expect(del.status).toBe(403);
    } finally {
      process.env.INTAKE_ASSET_REGISTER = 'true';
    }
  });
});
