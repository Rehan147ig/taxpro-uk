import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import jwt from 'jsonwebtoken';
import { Jurisdiction } from '@taxpro/tax-engine';
import { resolveJurisdiction } from '../modules/provision/provision-calculator.js';
import { syncParamsSchema, DEFAULT_SYNC_JURISDICTION, DEFAULT_SYNC_CURRENCY } from '../modules/integrations/quickbooks/sync-options.js';
import { errorHandler } from '../lib/middleware/error-handler.js';
import { env } from '../config/env.js';

describe('Phase A follow-up — QBO is a UK data source', () => {

  it('sync params default to a UK FRS 102 entity in GBP', () => {
    const parsed = syncParamsSchema.parse({
      periodStart: '2026-04-06',
      periodEnd: '2027-04-05',
    });
    expect(parsed.jurisdiction).toBe('UK_FRS102');
    expect(parsed.currency).toBe('GBP');
    expect(DEFAULT_SYNC_JURISDICTION).toBe('UK_FRS102');
    expect(DEFAULT_SYNC_CURRENCY).toBe('GBP');
  });

  it('sync params reject malformed jurisdiction or currency', () => {
    expect(() => syncParamsSchema.parse({
      periodStart: '2026-01-01', periodEnd: '2026-12-31',
      jurisdiction: 'UK FRS 102', currency: 'GBP',
    })).toThrow();
    expect(() => syncParamsSchema.parse({
      periodStart: '2026-01-01', periodEnd: '2026-12-31',
      jurisdiction: 'UK_FRS102', currency: 'GBPX',
    })).toThrow();
  });

  it('resolveJurisdiction accepts the Xero-written "UK" alias as UK FRS 102', () => {
    expect(resolveJurisdiction('UK')).toBe(Jurisdiction.UK_FRS102_S29);
  });

  it('QBO auth-url without server credentials fails cleanly for an authenticated user (route stays mounted)', async () => {
    const app = new Hono();
    app.onError(errorHandler);
    const { qboRoutes } = await import('../modules/integrations/quickbooks/quickbooks.routes.js');
    app.route('/api/qbo', qboRoutes);
    const token = jwt.sign(
      { userId: 'user-1', tenantId: '00000000-0000-0000-0000-000000000001', email: 'preparer@test.local', role: 'preparer' },
      env.JWT_SECRET,
    );
    const res = await app.request('/api/qbo/auth-url', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    // The route must be mounted for UK tenants: 400 when QBO_CLIENT_ID is
    // unset (CI), 200 when real credentials are configured locally. A 404
    // would mean the connector was missing.
    expect([400, 200]).toContain(res.status);
  });
});
