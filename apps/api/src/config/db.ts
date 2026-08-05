import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { env } from './env.js';
import { logger } from '../lib/logger.js';
import * as schema from '../db/schema/index.js';

const { Pool } = pg;

// Runtime pool: connects as app_tenant role (non-owner, NOBYPASSRLS)
export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: 20,
});

export const db = drizzle(pool, { schema });

/** Transaction client type as produced by db.transaction() (and withTenantContext). */
export type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

// Migration pool: connects as schema_owner role for Drizzle migrations
export const migrationPool = new Pool({
  connectionString: env.DATABASE_URL_MIGRATIONS,
  max: 5,
});
export const migrationDb = drizzle(migrationPool, { schema });

// Test runtime connection with retry
export async function testConnection(retries = 3): Promise<void> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const client = await pool.connect();
      await client.query('SELECT 1');
      const roleRes = await client.query('SELECT current_user AS role, (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypassrls');
      const row = roleRes.rows[0];
      client.release();
      logger.info({ role: row?.role, bypassrls: row?.bypassrls, poolSize: pool.totalCount }, `[DB] Runtime connected successfully`);
      return;
    } catch (err) {
      if (attempt < retries) {
        const delay = Math.min(1000 * Math.pow(2, attempt - 1), 8000);
        logger.warn({ err, attempt, retries }, `[DB] Connection attempt ${attempt}/${retries} failed, retrying in ${delay}ms`);
        await new Promise(r => setTimeout(r, delay));
      } else {
        logger.error({ err }, '[DB] Runtime connection failed after all retries');
        process.exit(1);
      }
    }
  }
}

export async function closeDb() {
  await pool.end();
  await migrationPool.end();
}

/**
 * Execute a callback within a database transaction that has the tenant context set.
 * Uses transaction-local set_config so the tenant_id never leaks across connections.
 * The callback receives a Drizzle transactional client scoped to one connection.
 *
 * RLS policies use app_current_tenant_id() which reads app.tenant_id.
 * When the transaction commits, the setting is automatically cleared.
 * No tenant context means RLS fails closed (zero rows).
 */
export async function withTenantContext<T>(
  tenantId: string,
  fn: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT app_current_tenant_id()`);
    await tx.execute(sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`);
    return fn(tx as any);
  });
}

/**
 * For background workers and scripts that have a known tenantId but no HTTP context.
 * Validates that the tenant exists before setting context.
 */
export async function withValidatedTenantContext<T>(
  tenantId: string,
  fn: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => Promise<T>,
): Promise<T> {
  if (!tenantId) throw new Error('tenantId is required for tenant-scoped database access');
  return withTenantContext(tenantId, fn);
}

// ── Startup validation ──

export interface SecurityValidationResult {
  runtimeRole: string;
  isTableOwner: boolean;
  hasBypassRls: boolean;
  rlsEnabled: Record<string, boolean>;
  strictPoliciesExist: Record<string, boolean>;
  valid: boolean;
}

// Shortcut for routes: wraps handler in withTenantContext, returns the tx as the 2nd arg
import type { Context } from 'hono';

export function tenantRoute(handler: (c: Context, tx: any) => Promise<Response>) {
  return async (c: Context) => {
    const user = c.get('user');
    if (!user?.tenantId) throw new Error('No tenant context');
    return withTenantContext(user.tenantId, async (tx) => {
      return handler(c, tx);
    });
  };
}

export async function validateRuntimeRoleSecurity(): Promise<SecurityValidationResult> {
  const result: SecurityValidationResult = {
    runtimeRole: 'unknown',
    isTableOwner: true,
    hasBypassRls: true,
    rlsEnabled: {},
    strictPoliciesExist: {},
    valid: false,
  };

  try {
    const client = await pool.connect();

    // Get current role
    const roleRes = await client.query('SELECT current_user AS role');
    result.runtimeRole = roleRes.rows[0]?.role ?? 'unknown';

    // Check BYPASSRLS
    const bypassRes = await client.query(
      `SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user`,
    );
    result.hasBypassRls = bypassRes.rows[0]?.rolbypassrls ?? true;

    // Check RLS enabled on tenant tables
    const tables = [
      'provision_runs', 'provision_results', 'provision_events',
      'review_items', 'tax_mappings', 'trial_balance',
      'accounts', 'entities', 'ai_runs', 'ai_steps',
      'classification_patterns', 'connections', 'users',
      'entity_groups', 'accounting_periods', 'tax_periods',
      'source_documents', 'mapping_proposals', 'uk_rules',
      'review_item_events', 'qbo_connections', 'xero_connections',
      'workbench_jobs', 'external_filings',
    ];

    for (const t of tables) {
      const rlsRes = await client.query(
        `SELECT relrowsecurity FROM pg_class WHERE relname = $1`,
        [t],
      );
      result.rlsEnabled[t] = rlsRes.rows[0]?.relrowsecurity ?? false;
    }

    // Check if the runtime role owns any tenant tables
    const ownerRes = await client.query(`
      SELECT COUNT(*) AS count FROM pg_class c
      JOIN pg_roles r ON c.relowner = r.oid
      WHERE r.rolname = current_user
        AND c.relname = ANY($1)
        AND c.relkind = 'r'
    `, [tables]);
    result.isTableOwner = Number(ownerRes.rows[0]?.count ?? 0) > 0;

    client.release();

    // Validate
    const rlsAllEnabled = Object.values(result.rlsEnabled).every(Boolean);
    result.valid = !result.hasBypassRls && !result.isTableOwner && rlsAllEnabled;
  } catch (err) {
    logger.error({ err }, '[Security] Runtime role validation failed');
    result.valid = false;
  }

  return result;
}

export function logSecurityValidation(result: SecurityValidationResult): void {
  const status = result.valid ? 'PASS' : 'FAIL';
  logger.info({
    status,
    runtimeRole: result.runtimeRole,
    isTableOwner: result.isTableOwner,
    hasBypassRls: result.hasBypassRls,
    rlsEnabled: Object.entries(result.rlsEnabled)
      .filter(([, v]) => !v)
      .map(([k]) => k)
      .join(', '),
  }, `[Security] Runtime role validation ${status}`);

  if (!result.valid) {
    logger.warn(
      '[Security] Runtime role does not meet security requirements. ' +
      'See bootstrap-roles.sql to set up taxpro_app role. ' +
      'Set DATABASE_URL to connect as the app_tenant role.',
    );
  }
}
