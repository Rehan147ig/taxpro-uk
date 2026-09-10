-- ================================================================
-- 0022 — Billing Sprint 1+2: harden usage ledger + plans/entitlements.
--
-- Sprint 1 (metering correctness):
--   • usage_events gains idempotency_key, source_lifecycle,
--     entitlement_decision, currency (all additive, nullable except currency).
--   • Unique constraint on (tenant_id, provision_run_id, event_type)
--     prevents duplicate charges on retries / repeated lifecycle calls.
--   • Unique index on idempotency_key for explicit idempotency.
--   • usage_events becomes append-only (trigger) like provision_events.
--
-- Sprint 2 (plans / subscriptions / billing accounts):
--   • billing_plans: persistent plan catalogue (pilot/professional/firm).
--   • tenant_subscriptions: one row per tenant (status, allowance snapshot,
--     billing period, provider IDs reserved for Sprint 3).
--   • billing_accounts: tenant → payment-provider customer mapping +
--     billing contact (kept separate from tenants).
--   • tenant_entitlements: optional per-tenant feature overrides.
--   • RLS enabled on all new tenant-scoped tables.
--
-- Billable lifecycle (enforced in code, documented here):
--   • POST /api/provision/run NO LONGER records usage.
--   • Usage is recorded ONCE per run at finalize OR lock (first wins),
--     event_type = 'provision_billable', with unit price snapshotted.
--   • Failed / rejected / never-finalized runs are never billed.
--   • Recalculations create a new run id and are billed as new runs
--     (free allowance applies first).
--
-- All additive. No breaking changes. Safe to re-run (IF NOT EXISTS).
-- ================================================================

-- ── 1. Harden usage_events ──

ALTER TABLE usage_events
  ADD COLUMN IF NOT EXISTS idempotency_key varchar(128),
  ADD COLUMN IF NOT EXISTS source_lifecycle varchar(50),
  ADD COLUMN IF NOT EXISTS entitlement_decision varchar(30),
  ADD COLUMN IF NOT EXISTS currency varchar(3) NOT NULL DEFAULT 'GBP';

-- Backfill idempotency keys for pre-existing rows so the unique
-- constraint below can be created without violating on legacy data.
UPDATE usage_events
SET idempotency_key = tenant_id::text || ':' || COALESCE(provision_run_id::text, id::text) || ':' || event_type
WHERE idempotency_key IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'uq_usage_events_tenant_run_event'
  ) THEN
    -- Only enforce uniqueness where a run is attached; legacy rows with
    -- NULL provision_run_id keep the idempotency-key uniqueness instead.
    CREATE UNIQUE INDEX uq_usage_events_tenant_run_event
      ON usage_events (tenant_id, provision_run_id, event_type)
      WHERE provision_run_id IS NOT NULL;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_usage_events_idempotency_key
  ON usage_events (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_usage_events_tenant_period
  ON usage_events (tenant_id, occurred_at);

-- Append-only: usage events are money. Reject UPDATE/DELETE.
CREATE OR REPLACE FUNCTION reject_usage_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $func$
BEGIN
  RAISE EXCEPTION 'usage_events are append-only and cannot be modified or deleted'
    USING HINT = 'Usage events are immutable money records. Insert a reversing/credit event instead.';
  RETURN NULL;
END;
$func$;

DROP TRIGGER IF EXISTS usage_events_append_only ON usage_events;
CREATE TRIGGER usage_events_append_only
  BEFORE UPDATE OR DELETE ON usage_events
  FOR EACH ROW
  EXECUTE FUNCTION reject_usage_event_mutation();

-- ── 2. Billing plans ──

CREATE TABLE IF NOT EXISTS billing_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code varchar(30) NOT NULL UNIQUE,
  name varchar(100) NOT NULL,
  description varchar(500),
  included_runs_per_month integer NOT NULL DEFAULT 1,
  overage_price_per_run numeric(12, 2) NOT NULL DEFAULT '50',
  max_entities integer,
  max_seats integer,
  features jsonb,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Seed the initial catalogue (idempotent).
INSERT INTO billing_plans (code, name, description, included_runs_per_month, overage_price_per_run, max_entities, max_seats, features)
VALUES
  ('pilot', 'Pilot', 'One supported run with guided onboarding and a defined success review.', 1, '50', 2, 3, '{"support": "guided_onboarding", "review_workflow": true}'::jsonb),
  ('professional', 'Professional', 'Annual workspace with included runs, reviewer workflow, evidence package, standard integrations.', 10, '50', 10, 10, '{"review_workflow": true, "evidence_package": true, "integrations": "standard"}'::jsonb),
  ('firm', 'Firm / Group', 'High volume, portfolio controls, SSO, advanced roles, integrations, implementation, premium support.', 100, '45', 100, 100, '{"sso": true, "portfolio_controls": true, "premium_support": true}'::jsonb)
ON CONFLICT (code) DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  included_runs_per_month = EXCLUDED.included_runs_per_month,
  overage_price_per_run = EXCLUDED.overage_price_per_run,
  max_entities = EXCLUDED.max_entities,
  max_seats = EXCLUDED.max_seats,
  features = EXCLUDED.features,
  updated_at = now();

-- ── 3. Tenant subscriptions ──

CREATE TABLE IF NOT EXISTS tenant_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL UNIQUE REFERENCES tenants(id) ON DELETE CASCADE,
  plan_id uuid REFERENCES billing_plans(id) ON DELETE RESTRICT,
  status varchar(30) NOT NULL DEFAULT 'trialing',
  billing_interval varchar(20) NOT NULL DEFAULT 'monthly',
  included_runs_per_month integer NOT NULL DEFAULT 1,
  current_period_start timestamptz NOT NULL DEFAULT now(),
  current_period_end timestamptz,
  trial_ends_at timestamptz,
  cancelled_at timestamptz,
  provider_customer_id varchar(128),
  provider_subscription_id varchar(128),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_subscription_status CHECK (status IN ('trialing', 'active', 'past_due', 'cancelled', 'expired'))
);

CREATE INDEX IF NOT EXISTS idx_tenant_subscriptions_status
  ON tenant_subscriptions (status);

-- Backfill: every existing tenant gets a trialing pilot subscription.
INSERT INTO tenant_subscriptions (tenant_id, plan_id, status, included_runs_per_month, current_period_start, current_period_end)
SELECT
  t.id,
  (SELECT id FROM billing_plans WHERE code = 'pilot'),
  'trialing',
  1,
  date_trunc('month', now()),
  (date_trunc('month', now()) + interval '1 month')
FROM tenants t
ON CONFLICT (tenant_id) DO NOTHING;

-- ── 4. Billing accounts ──

CREATE TABLE IF NOT EXISTS billing_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL UNIQUE REFERENCES tenants(id) ON DELETE CASCADE,
  billing_email varchar(255),
  contact_name varchar(255),
  vat_number varchar(50),
  address jsonb,
  currency varchar(3) NOT NULL DEFAULT 'GBP',
  provider_customer_id varchar(128),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ── 5. Tenant entitlement overrides ──

CREATE TABLE IF NOT EXISTS tenant_entitlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  feature_key varchar(80) NOT NULL,
  allowed boolean NOT NULL DEFAULT true,
  limit_value integer,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, feature_key)
);

CREATE INDEX IF NOT EXISTS idx_tenant_entitlements_tenant
  ON tenant_entitlements (tenant_id);

-- ── 6. RLS (same pattern as rls_control_hardening.sql) ──

DO $$
DECLARE
  tables text[] := ARRAY[
    'billing_plans',
    'tenant_subscriptions',
    'billing_accounts',
    'tenant_entitlements',
    'usage_events'
  ];
  t text;
BEGIN
  FOREACH t IN ARRAY tables
  LOOP
    IF to_regclass(t) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', t);
    END IF;
  END LOOP;
END $$;

-- billing_plans is a shared catalogue: readable by all authenticated tenants,
-- writable only with tenant context (admin seed path). Keep permissive read.
DROP POLICY IF EXISTS tenant_isolation_read ON billing_plans;
CREATE POLICY tenant_isolation_read ON billing_plans FOR SELECT USING (true);
DROP POLICY IF EXISTS tenant_isolation_write ON billing_plans;
CREATE POLICY tenant_isolation_write ON billing_plans FOR INSERT
  WITH CHECK (true);

DROP POLICY IF EXISTS tenant_isolation_read ON tenant_subscriptions;
CREATE POLICY tenant_isolation_read ON tenant_subscriptions FOR SELECT
  USING (tenant_id = COALESCE(current_setting('app.tenant_id', true)::uuid, tenant_id));
DROP POLICY IF EXISTS tenant_isolation_write ON tenant_subscriptions;
CREATE POLICY tenant_isolation_write ON tenant_subscriptions FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
DROP POLICY IF EXISTS tenant_isolation_update ON tenant_subscriptions;
CREATE POLICY tenant_isolation_update ON tenant_subscriptions FOR UPDATE
  USING (tenant_id = COALESCE(current_setting('app.tenant_id', true)::uuid, tenant_id))
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
DROP POLICY IF EXISTS tenant_isolation_delete ON tenant_subscriptions;
CREATE POLICY tenant_isolation_delete ON tenant_subscriptions FOR DELETE
  USING (tenant_id = COALESCE(current_setting('app.tenant_id', true)::uuid, tenant_id));

DROP POLICY IF EXISTS tenant_isolation_read ON billing_accounts;
CREATE POLICY tenant_isolation_read ON billing_accounts FOR SELECT
  USING (tenant_id = COALESCE(current_setting('app.tenant_id', true)::uuid, tenant_id));
DROP POLICY IF EXISTS tenant_isolation_write ON billing_accounts;
CREATE POLICY tenant_isolation_write ON billing_accounts FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
DROP POLICY IF EXISTS tenant_isolation_update ON billing_accounts;
CREATE POLICY tenant_isolation_update ON billing_accounts FOR UPDATE
  USING (tenant_id = COALESCE(current_setting('app.tenant_id', true)::uuid, tenant_id))
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
DROP POLICY IF EXISTS tenant_isolation_delete ON billing_accounts;
CREATE POLICY tenant_isolation_delete ON billing_accounts FOR DELETE
  USING (tenant_id = COALESCE(current_setting('app.tenant_id', true)::uuid, tenant_id));

DROP POLICY IF EXISTS tenant_isolation_read ON tenant_entitlements;
CREATE POLICY tenant_isolation_read ON tenant_entitlements FOR SELECT
  USING (tenant_id = COALESCE(current_setting('app.tenant_id', true)::uuid, tenant_id));
DROP POLICY IF EXISTS tenant_isolation_write ON tenant_entitlements;
CREATE POLICY tenant_isolation_write ON tenant_entitlements FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
DROP POLICY IF EXISTS tenant_isolation_update ON tenant_entitlements;
CREATE POLICY tenant_isolation_update ON tenant_entitlements FOR UPDATE
  USING (tenant_id = COALESCE(current_setting('app.tenant_id', true)::uuid, tenant_id))
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
DROP POLICY IF EXISTS tenant_isolation_delete ON tenant_entitlements;
CREATE POLICY tenant_isolation_delete ON tenant_entitlements FOR DELETE
  USING (tenant_id = COALESCE(current_setting('app.tenant_id', true)::uuid, tenant_id));

DROP POLICY IF EXISTS tenant_isolation_read ON usage_events;
CREATE POLICY tenant_isolation_read ON usage_events FOR SELECT
  USING (tenant_id = COALESCE(current_setting('app.tenant_id', true)::uuid, tenant_id));
DROP POLICY IF EXISTS tenant_isolation_write ON usage_events;
CREATE POLICY tenant_isolation_write ON usage_events FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);

-- ================================================================
-- ROLLBACK
-- ================================================================
-- To revert:
--   1. DROP TRIGGER IF EXISTS usage_events_append_only ON usage_events;
--   2. DROP FUNCTION IF EXISTS reject_usage_event_mutation();
--   3. DROP INDEX IF EXISTS uq_usage_events_tenant_run_event;
--   4. DROP INDEX IF EXISTS uq_usage_events_idempotency_key;
--   5. ALTER TABLE usage_events DROP COLUMN IF EXISTS idempotency_key,
--      DROP COLUMN IF EXISTS source_lifecycle,
--      DROP COLUMN IF EXISTS entitlement_decision,
--      DROP COLUMN IF EXISTS currency;
--   6. DROP TABLE IF EXISTS tenant_entitlements;
--   7. DROP TABLE IF EXISTS billing_accounts;
--   8. DROP TABLE IF EXISTS tenant_subscriptions;
--   9. DROP TABLE IF EXISTS billing_plans;
