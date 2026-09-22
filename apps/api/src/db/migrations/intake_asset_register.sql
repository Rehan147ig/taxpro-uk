-- ================================================================
-- 0024 — Fixed Asset Register Ingestion (Feature 5).
--
-- Dedicated asset_register_items table so detailed asset schedules
-- (machinery, IT equipment, vehicles, fixtures) can be ingested per
-- entity and fed into the engine's CAA 2001 capital-allowance pools.
-- pool_type uses the intake vocabulary ('main', 'special_rate', 'aia',
-- 'fya', 'single_asset'); the deterministic mapping onto the engine's
-- UkAllowancePool ('main' | 'special' | 'sba') lives in
-- apps/api/src/modules/intake/asset-register.ts (POOL_TO_ENGINE_INPUT)
-- so the engine itself is never touched.
--
-- Conventions: additive-only, IF NOT EXISTS, tenant RLS via
-- app_current_tenant_id(), runtime grants for taxpro_app, rollback notes.
-- ================================================================

CREATE TABLE IF NOT EXISTS asset_register_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  entity_id uuid NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  import_batch_id uuid REFERENCES import_batches(id) ON DELETE SET NULL,
  account_external_id text,
  asset_description text NOT NULL,
  cost numeric(15, 2) NOT NULL,
  pool_type text NOT NULL,
  placed_in_service_date date NOT NULL,
  disposal_date date,
  disposal_proceeds numeric(15, 2),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_asset_register_entity_active
  ON asset_register_items (tenant_id, entity_id, is_active);

-- ── RLS: strict default-deny, tenant_isolation_* convention ──

ALTER TABLE asset_register_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_select ON asset_register_items;
CREATE POLICY tenant_isolation_select ON asset_register_items
  FOR SELECT USING (tenant_id = app_current_tenant_id());
DROP POLICY IF EXISTS tenant_isolation_insert ON asset_register_items;
CREATE POLICY tenant_isolation_insert ON asset_register_items
  FOR INSERT WITH CHECK (tenant_id = app_current_tenant_id());
DROP POLICY IF EXISTS tenant_isolation_update ON asset_register_items;
CREATE POLICY tenant_isolation_update ON asset_register_items
  FOR UPDATE USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

-- ── Runtime role privileges (taxpro_app — no DELETE/TRUNCATE) ──

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'taxpro_app') THEN
    GRANT SELECT, INSERT, UPDATE ON asset_register_items TO taxpro_app;
    REVOKE DELETE, TRUNCATE ON asset_register_items FROM taxpro_app;
  END IF;
END $$;

-- ================================================================
-- ROLLBACK
-- ================================================================
-- To revert:
--   1. DROP TABLE IF EXISTS asset_register_items;
--   2. DELETE FROM __drizzle_migrations WHERE hash = (this migration hash);
