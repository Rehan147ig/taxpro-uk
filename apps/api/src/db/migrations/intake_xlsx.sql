-- ================================================================
-- 0022 — XLSX ingest with column mapping (Feature 1).
--
-- New table intake_column_maps remembers a client's workbook layout so
-- the column map is reused next period:
--   key = (tenant_id, client_fingerprint)
--   client_fingerprint = sha256(JSON { sortedHeaders, sheetName })
--   (see apps/api/src/modules/intake/xlsx.ts buildClientFingerprint)
--
-- Conventions: additive-only, IF NOT EXISTS, tenant RLS via
-- app_current_tenant_id(), runtime grants for taxpro_app, rollback notes.
-- ================================================================

CREATE TABLE IF NOT EXISTS intake_column_maps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  client_fingerprint varchar(64) NOT NULL,
  sheet_name varchar(255) NOT NULL,
  headers jsonb NOT NULL,
  column_map jsonb NOT NULL,
  created_by_user_id uuid REFERENCES users(id),
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_intake_column_maps_tenant_fingerprint
  ON intake_column_maps (tenant_id, client_fingerprint);
CREATE INDEX IF NOT EXISTS idx_intake_column_maps_tenant
  ON intake_column_maps (tenant_id);

-- ── RLS: strict default-deny, tenant_isolation_* convention ──

ALTER TABLE intake_column_maps ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_select ON intake_column_maps;
CREATE POLICY tenant_isolation_select ON intake_column_maps
  FOR SELECT USING (tenant_id = app_current_tenant_id());
DROP POLICY IF EXISTS tenant_isolation_insert ON intake_column_maps;
CREATE POLICY tenant_isolation_insert ON intake_column_maps
  FOR INSERT WITH CHECK (tenant_id = app_current_tenant_id());
DROP POLICY IF EXISTS tenant_isolation_update ON intake_column_maps;
CREATE POLICY tenant_isolation_update ON intake_column_maps
  FOR UPDATE USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

-- ── Runtime role privileges (taxpro_app) ──

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'taxpro_app') THEN
    GRANT SELECT, INSERT, UPDATE ON intake_column_maps TO taxpro_app;
    REVOKE DELETE, TRUNCATE ON intake_column_maps FROM taxpro_app;
  END IF;
END $$;

-- ================================================================
-- ROLLBACK
-- ================================================================
-- To revert:
--   1. DROP TABLE IF EXISTS intake_column_maps;
--   2. DELETE FROM __drizzle_migrations WHERE hash = (this migration hash);
