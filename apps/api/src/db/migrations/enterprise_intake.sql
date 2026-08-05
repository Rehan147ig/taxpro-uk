-- ================================================================
-- 0017 — Phase 1: Enterprise Data Intake
--
-- Import batch domain model, knowledge graph foundation
-- (data_lineage_edges), evidence graph (evidence_links), tax memory
-- (tax_memory_precedents), reviewable mapping suggestions,
-- reviewer feedback events (learning system), governed manual
-- adjustments, and the rule_version_hash on provision_runs.
--
-- All tables follow the tenant_isolation_* RLS convention used by
-- every tenant table; import_batch_events is append-only.
-- ================================================================

-- ── provision_runs: rule version hash (deterministic repro) ──
ALTER TABLE provision_runs
  ADD COLUMN IF NOT EXISTS rule_version_hash varchar(128);

-- ================================================================
-- Import batches
-- ================================================================

CREATE TABLE IF NOT EXISTS import_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  entity_id uuid NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  accounting_period_id uuid NOT NULL REFERENCES accounting_periods(id) ON DELETE CASCADE,
  source_document_id uuid REFERENCES source_documents(id) ON DELETE SET NULL,
  source_type varchar(20) NOT NULL,
  source_system varchar(100),
  source_reference varchar(255),
  original_filename varchar(255) NOT NULL,
  checksum varchar(64) NOT NULL,
  row_count integer NOT NULL DEFAULT 0,
  status varchar(30) NOT NULL DEFAULT 'draft',
  validation_summary jsonb,
  control_totals jsonb,
  headers jsonb,
  created_by_user_id uuid REFERENCES users(id),
  reviewed_by_user_id uuid REFERENCES users(id),
  committed_at timestamp,
  failed_at timestamp,
  failure_reason text,
  superseded_by_batch_id uuid REFERENCES import_batches(id) ON DELETE SET NULL,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_import_batches_idempotency
  ON import_batches (tenant_id, entity_id, accounting_period_id, source_type, source_system, checksum);
CREATE INDEX IF NOT EXISTS idx_import_batches_tenant_status
  ON import_batches (tenant_id, status, created_at);

CREATE TABLE IF NOT EXISTS import_batch_rows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  batch_id uuid NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
  row_number integer NOT NULL,
  raw jsonb NOT NULL,
  normalized jsonb,
  validation jsonb,
  status varchar(20) NOT NULL DEFAULT 'ok',
  account_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
  committed_trial_balance_id uuid REFERENCES trial_balance(id) ON DELETE SET NULL,
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_import_batch_rows_batch
  ON import_batch_rows (batch_id, row_number);
CREATE INDEX IF NOT EXISTS idx_import_batch_rows_batch_status
  ON import_batch_rows (batch_id, status);

-- ── Import batch event ledger (append-only) ──
CREATE TABLE IF NOT EXISTS import_batch_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  batch_id uuid NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
  event_type varchar(60) NOT NULL,
  actor_type varchar(20) NOT NULL DEFAULT 'user',
  actor_user_id uuid REFERENCES users(id),
  reason text,
  before_state jsonb,
  after_state jsonb,
  metadata jsonb,
  occurred_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_import_batch_events_batch
  ON import_batch_events (batch_id, occurred_at);

CREATE OR REPLACE FUNCTION reject_import_batch_event_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'import_batch_events is append-only; UPDATE/DELETE are forbidden';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS import_batch_events_append_only ON import_batch_events;
CREATE TRIGGER import_batch_events_append_only
  BEFORE UPDATE OR DELETE ON import_batch_events
  FOR EACH ROW EXECUTE FUNCTION reject_import_batch_event_mutation();

-- ================================================================
-- Evidence graph
-- ================================================================

CREATE TABLE IF NOT EXISTS evidence_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  subject_kind varchar(40) NOT NULL,
  subject_id uuid NOT NULL,
  document_id uuid NOT NULL REFERENCES source_documents(id) ON DELETE CASCADE,
  evidence_role varchar(20) NOT NULL DEFAULT 'supporting',
  note text,
  created_by_user_id uuid REFERENCES users(id),
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_evidence_links_subject
  ON evidence_links (tenant_id, subject_kind, subject_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_evidence_links_subject_document
  ON evidence_links (tenant_id, subject_kind, subject_id, document_id);

-- ================================================================
-- Tax memory + reviewable mapping suggestions
-- ================================================================

CREATE TABLE IF NOT EXISTS tax_memory_precedents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  entity_id uuid REFERENCES entities(id) ON DELETE CASCADE,
  group_id uuid REFERENCES entity_groups(id) ON DELETE SET NULL,
  jurisdiction varchar(30) NOT NULL DEFAULT 'UK_FRS102',
  effective_from date NOT NULL,
  effective_to date,
  account_name varchar(255) NOT NULL,
  account_number varchar(50),
  account_type varchar(50) NOT NULL,
  detail_type varchar(100),
  tax_account_type varchar(100) NOT NULL,
  book_treatment varchar(50) NOT NULL,
  timing_category varchar(50),
  source_mapping_id uuid REFERENCES tax_mappings(id) ON DELETE SET NULL,
  source varchar(30) NOT NULL DEFAULT 'approved_mapping',
  created_by_user_id uuid REFERENCES users(id),
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tax_memory_lookup
  ON tax_memory_precedents (tenant_id, jurisdiction, account_name);
CREATE INDEX IF NOT EXISTS idx_tax_memory_scope
  ON tax_memory_precedents (tenant_id, entity_id, group_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_tax_memory_source_mapping
  ON tax_memory_precedents (tenant_id, source_mapping_id);

CREATE TABLE IF NOT EXISTS mapping_suggestions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  batch_id uuid REFERENCES import_batches(id) ON DELETE CASCADE,
  batch_row_id uuid REFERENCES import_batch_rows(id) ON DELETE CASCADE,
  account_id uuid REFERENCES accounts(id) ON DELETE CASCADE,
  entity_id uuid REFERENCES entities(id) ON DELETE CASCADE,
  period date,
  suggested_tax_account_type varchar(100) NOT NULL,
  book_treatment varchar(50) NOT NULL,
  timing_category varchar(50),
  confidence_score decimal(3, 2),
  source varchar(30) NOT NULL DEFAULT 'tax_memory',
  cited_precedent_id uuid REFERENCES tax_memory_precedents(id) ON DELETE SET NULL,
  cited_account_name varchar(255),
  rationale text,
  status varchar(20) NOT NULL DEFAULT 'pending',
  decided_by_user_id uuid REFERENCES users(id),
  decided_at timestamp,
  decision_reason text,
  overridden_from jsonb,
  applied_mapping_id uuid REFERENCES tax_mappings(id) ON DELETE SET NULL,
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mapping_suggestions_batch_row
  ON mapping_suggestions (tenant_id, batch_row_id);
CREATE INDEX IF NOT EXISTS idx_mapping_suggestions_status
  ON mapping_suggestions (tenant_id, status);

-- ================================================================
-- Reviewer feedback events (learning system)
-- ================================================================

CREATE TABLE IF NOT EXISTS reviewer_feedback_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  batch_id uuid REFERENCES import_batches(id) ON DELETE CASCADE,
  feedback_type varchar(20) NOT NULL,
  subject_kind varchar(40) NOT NULL,
  subject_id uuid NOT NULL,
  suggested jsonb,
  applied jsonb,
  reason text,
  created_by_user_id uuid REFERENCES users(id),
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_feedback_tenant_created
  ON reviewer_feedback_events (tenant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_feedback_subject
  ON reviewer_feedback_events (tenant_id, subject_kind, subject_id);

-- ================================================================
-- Governed manual adjustments
-- ================================================================

CREATE TABLE IF NOT EXISTS tax_adjustments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provision_run_id uuid REFERENCES provision_runs(id) ON DELETE CASCADE,
  account_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
  adjustment_type varchar(30) NOT NULL,
  amount decimal(18, 2) NOT NULL,
  description text,
  reason text NOT NULL,
  evidence_document_id uuid REFERENCES source_documents(id) ON DELETE SET NULL,
  created_by_user_id uuid NOT NULL REFERENCES users(id),
  version integer NOT NULL DEFAULT 1,
  supersedes_adjustment_id uuid REFERENCES tax_adjustments(id),
  effective_period date,
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tax_adjustments_run
  ON tax_adjustments (tenant_id, provision_run_id);

-- ================================================================
-- Knowledge graph edges
-- ================================================================

CREATE TABLE IF NOT EXISTS data_lineage_edges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  source_kind varchar(40) NOT NULL,
  source_id uuid NOT NULL,
  target_kind varchar(40) NOT NULL,
  target_id uuid NOT NULL,
  relation varchar(40) NOT NULL,
  metadata jsonb,
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lineage_source
  ON data_lineage_edges (tenant_id, source_kind, source_id);
CREATE INDEX IF NOT EXISTS idx_lineage_target
  ON data_lineage_edges (tenant_id, target_kind, target_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_lineage_edge
  ON data_lineage_edges (tenant_id, source_kind, source_id, target_kind, target_id, relation);

-- ================================================================
-- RLS — strict default-deny, same tenant_isolation_* convention
-- ================================================================

CREATE OR REPLACE FUNCTION enable_intake_rls(_tbl regclass)
RETURNS void AS $$
BEGIN
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', _tbl);
  EXECUTE format('DROP POLICY IF EXISTS tenant_isolation_select ON %s', _tbl);
  EXECUTE format('CREATE POLICY tenant_isolation_select ON %s FOR SELECT USING (tenant_id = app_current_tenant_id())', _tbl);
  EXECUTE format('DROP POLICY IF EXISTS tenant_isolation_insert ON %s', _tbl);
  EXECUTE format('CREATE POLICY tenant_isolation_insert ON %s FOR INSERT WITH CHECK (tenant_id = app_current_tenant_id())', _tbl);
  EXECUTE format('DROP POLICY IF EXISTS tenant_isolation_update ON %s', _tbl);
  EXECUTE format('CREATE POLICY tenant_isolation_update ON %s FOR UPDATE USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id())', _tbl);
END;
$$ LANGUAGE plpgsql;

SELECT enable_intake_rls('import_batches');
SELECT enable_intake_rls('import_batch_rows');
SELECT enable_intake_rls('import_batch_events');
SELECT enable_intake_rls('evidence_links');
SELECT enable_intake_rls('tax_memory_precedents');
SELECT enable_intake_rls('mapping_suggestions');
SELECT enable_intake_rls('reviewer_feedback_events');
SELECT enable_intake_rls('tax_adjustments');
SELECT enable_intake_rls('data_lineage_edges');

DROP FUNCTION IF EXISTS enable_intake_rls(regclass);

-- ================================================================
-- Runtime role privileges (taxpro_app — no DELETE anywhere)
-- ================================================================

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'taxpro_app') THEN
    GRANT SELECT, INSERT, UPDATE ON import_batches TO taxpro_app;
    REVOKE DELETE, TRUNCATE ON import_batches FROM taxpro_app;
    GRANT SELECT, INSERT, UPDATE ON import_batch_rows TO taxpro_app;
    REVOKE DELETE, TRUNCATE ON import_batch_rows FROM taxpro_app;
    GRANT SELECT, INSERT ON import_batch_events TO taxpro_app;
    REVOKE DELETE, TRUNCATE ON import_batch_events FROM taxpro_app;
    GRANT SELECT, INSERT, DELETE ON evidence_links TO taxpro_app;
    REVOKE TRUNCATE ON evidence_links FROM taxpro_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON tax_memory_precedents TO taxpro_app;
    REVOKE TRUNCATE ON tax_memory_precedents FROM taxpro_app;
    GRANT SELECT, INSERT, UPDATE ON mapping_suggestions TO taxpro_app;
    REVOKE DELETE, TRUNCATE ON mapping_suggestions FROM taxpro_app;
    GRANT SELECT, INSERT ON reviewer_feedback_events TO taxpro_app;
    REVOKE DELETE, TRUNCATE ON reviewer_feedback_events FROM taxpro_app;
    GRANT SELECT, INSERT, UPDATE ON tax_adjustments TO taxpro_app;
    REVOKE DELETE, TRUNCATE ON tax_adjustments FROM taxpro_app;
    GRANT SELECT, INSERT ON data_lineage_edges TO taxpro_app;
    REVOKE DELETE, TRUNCATE ON data_lineage_edges FROM taxpro_app;
  END IF;
END $$;

-- ================================================================
-- ROLLBACK
-- ================================================================
-- To revert this migration:
--   1. DROP TRIGGER import_batch_events_append_only ON import_batch_events;
--   2. DROP FUNCTION IF EXISTS reject_import_batch_event_mutation();
--   3. DROP TABLE IF EXISTS import_batch_events, import_batch_rows, import_batches;
--   4. DROP TABLE IF EXISTS evidence_links;
--   5. DROP TABLE IF EXISTS mapping_suggestions, tax_memory_precedents;
--   6. DROP TABLE IF EXISTS reviewer_feedback_events;
--   7. DROP TABLE IF EXISTS tax_adjustments;
--   8. DROP TABLE IF EXISTS data_lineage_edges;
--   9. ALTER TABLE provision_runs DROP COLUMN IF EXISTS rule_version_hash;
