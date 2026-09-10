import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { env } from '../config/env.js';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Works from both src (tsx dev) and dist (container runtime)
const migrationsFolder = resolve(__dirname, '../../src/db/migrations');

const pool = new pg.Pool({ connectionString: env.DATABASE_URL_MIGRATIONS });
const db = drizzle(pool);

/**
 * Re-applies runtime role grants after migration.
 *
 * The runtime role (taxpro_app, NOBYPASSRLS) needs table-level CRUD that
 * cannot be granted at container initdb time (tables do not exist yet).
 * The blanket ALTER DEFAULT PRIVILEGES from bootstrap-roles.sql covers
 * tables created by this role afterwards, and this step makes the grants
 * explicit on the migrated tables — including the append-only restriction
 * on provision_events (SELECT + INSERT only, no UPDATE/DELETE).
 */
async function applyRuntimeGrants(): Promise<void> {
  const grants = `
    DO $$ DECLARE
      t text;
      full_access_tables text[] := ARRAY[
        'tenants', 'provision_runs', 'provision_results',
        'review_items', 'tax_mappings', 'trial_balance',
        'accounts', 'entities', 'ai_runs', 'ai_steps',
        'classification_patterns', 'connections', 'users', 'usage_events',
        'entity_groups', 'accounting_periods', 'tax_periods',
        'source_documents', 'mapping_proposals', 'uk_rules',
        'workbench_jobs', 'qbo_connections', 'xero_connections',
        'billing_plans', 'tenant_subscriptions', 'billing_accounts',
        'tenant_entitlements'
      ];
    BEGIN
      FOREACH t IN ARRAY full_access_tables
      LOOP
        IF to_regclass(t) IS NOT NULL THEN
          EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO taxpro_app;', t);
        END IF;
      END LOOP;
    END $$;
    DO $$
    BEGIN
      IF to_regclass('provision_events') IS NOT NULL THEN
        EXECUTE 'GRANT SELECT, INSERT ON provision_events TO taxpro_app';
        EXECUTE 'REVOKE UPDATE, DELETE ON provision_events FROM taxpro_app';
      END IF;
      IF to_regclass('review_item_events') IS NOT NULL THEN
        EXECUTE 'GRANT SELECT, INSERT ON review_item_events TO taxpro_app';
        EXECUTE 'REVOKE UPDATE, DELETE ON review_item_events FROM taxpro_app';
      END IF;
      IF to_regclass('external_filings') IS NOT NULL THEN
        EXECUTE 'GRANT SELECT, INSERT ON external_filings TO taxpro_app';
        EXECUTE 'REVOKE UPDATE, DELETE ON external_filings FROM taxpro_app';
      END IF;
    END $$;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO taxpro_app;
  `;
  await pool.query(grants);
  console.log('[Migration] Runtime role grants applied (taxpro_app)');
}

async function main() {
  console.log('[Migration] Running versioned migrations from:', migrationsFolder);
  await migrate(db, { migrationsFolder });
  console.log('[Migration] Migrations applied successfully');
  await applyRuntimeGrants();
  await pool.end();
}

main().catch((err) => {
  console.error('[Migration] Failed', err);
  process.exit(1);
});
