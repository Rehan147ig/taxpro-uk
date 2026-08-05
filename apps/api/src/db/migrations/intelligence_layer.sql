-- ================================================================
-- 0019 — Tax Intelligence Layer: evidence metadata + agent events.
--
-- 1. source_documents becomes a complete evidence object:
--    source_system, parser_version, ocr_version, updated_at.
-- 2. import_batches records the persisted evidence: storage_key,
--    parser_version (bytes are stored by the intake service).
-- 3. agent_events: append-only structured outbox for agent-to-agent
--    communication (agents never talk directly; they emit events).
-- All additive. No breaking changes.
-- ================================================================

ALTER TABLE source_documents
  ADD COLUMN IF NOT EXISTS source_system varchar(60),
  ADD COLUMN IF NOT EXISTS parser_version varchar(80),
  ADD COLUMN IF NOT EXISTS ocr_version varchar(80),
  ADD COLUMN IF NOT EXISTS updated_at timestamp NOT NULL DEFAULT now();

ALTER TABLE import_batches
  ADD COLUMN IF NOT EXISTS storage_key varchar(255),
  ADD COLUMN IF NOT EXISTS parser_version varchar(80);

-- ---- agent_events: append-only agent communication ledger ----

CREATE TABLE IF NOT EXISTS agent_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  run_id uuid REFERENCES ai_runs(id) ON DELETE SET NULL,
  source_agent varchar(100) NOT NULL,
  event_type varchar(100) NOT NULL,
  payload jsonb,
  correlation_id varchar(128),
  occurred_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agent_events_tenant_type
  ON agent_events (tenant_id, event_type, occurred_at);
CREATE INDEX IF NOT EXISTS idx_agent_events_run
  ON agent_events (run_id);

CREATE OR REPLACE FUNCTION reject_agent_event_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'agent_events is append-only; UPDATE/DELETE are forbidden';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS agent_events_append_only ON agent_events;
CREATE TRIGGER agent_events_append_only
  BEFORE UPDATE OR DELETE ON agent_events
  FOR EACH ROW EXECUTE FUNCTION reject_agent_event_mutation();

ALTER TABLE agent_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_select ON agent_events;
CREATE POLICY tenant_isolation_select ON agent_events
  FOR SELECT USING (tenant_id = app_current_tenant_id());
DROP POLICY IF EXISTS tenant_isolation_insert ON agent_events;
CREATE POLICY tenant_isolation_insert ON agent_events
  FOR INSERT WITH CHECK (tenant_id = app_current_tenant_id());

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'taxpro_app') THEN
    GRANT SELECT, INSERT ON agent_events TO taxpro_app;
    REVOKE UPDATE, DELETE, TRUNCATE ON agent_events FROM taxpro_app;
  END IF;
END $$;

-- ================================================================
-- ROLLBACK
-- ================================================================
-- To revert:
--   1. DROP TRIGGER agent_events_append_only ON agent_events;
--   2. DROP FUNCTION IF EXISTS reject_agent_event_mutation();
--   3. DROP TABLE IF EXISTS agent_events;
--   4. ALTER TABLE import_batches DROP COLUMN IF EXISTS storage_key,
--      DROP COLUMN IF EXISTS parser_version;
--   5. ALTER TABLE source_documents DROP COLUMN IF EXISTS source_system,
--      DROP COLUMN IF EXISTS parser_version, DROP COLUMN IF EXISTS ocr_version,
--      DROP COLUMN IF EXISTS updated_at;
