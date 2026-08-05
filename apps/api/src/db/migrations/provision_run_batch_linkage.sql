-- ================================================================
-- 0021 — Provision Run ↔ Import Batch Linkage.
--
-- Every calculation run can now point at the intake batch whose
-- committed rows it calculated over. Nullable so legacy/one-off
-- provision runs (no intake batch) keep working unchanged.
--
-- Enforced in code:
--   • run creation auto-links the active (committed, non-superseded)
--     intake batch for the entity/accounting period when the caller
--     does not supply one explicitly;
--   • locked runs (status = 'locked') refuse import-batch changes
--     (409 Conflict).
-- All additive. No breaking changes.
-- ================================================================

ALTER TABLE provision_runs
  ADD COLUMN IF NOT EXISTS import_batch_id uuid
    REFERENCES import_batches(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_provision_runs_import_batch
  ON provision_runs (tenant_id, import_batch_id);

-- ================================================================
-- ROLLBACK
-- ================================================================
-- To revert:
--   1. DROP INDEX IF EXISTS idx_provision_runs_import_batch;
--   2. ALTER TABLE provision_runs DROP COLUMN IF EXISTS import_batch_id;
