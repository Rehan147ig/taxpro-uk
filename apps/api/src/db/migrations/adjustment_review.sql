-- ================================================================
-- 0020 — Adjustment review lifecycle (learning system).
--
-- tax_adjustments gains a governed review lifecycle: pending →
-- approved | rejected, with actor + timestamp + reason. Decisions are
-- ALSO mirrored into reviewer_feedback_events (append-only) so the
-- learning system has an immutable signal stream. Additive only.
-- ================================================================

ALTER TABLE tax_adjustments
  ADD COLUMN IF NOT EXISTS status varchar(30) NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS decided_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS decided_at timestamp,
  ADD COLUMN IF NOT EXISTS decision_reason text;

CREATE INDEX IF NOT EXISTS idx_tax_adjustments_status
  ON tax_adjustments (tenant_id, status);

-- ================================================================
-- ROLLBACK
-- ================================================================
-- To revert:
--   1. DROP INDEX IF EXISTS idx_tax_adjustments_status;
--   2. ALTER TABLE tax_adjustments DROP COLUMN IF EXISTS status,
--      DROP COLUMN IF EXISTS decided_by_user_id,
--      DROP COLUMN IF EXISTS decided_at,
--      DROP COLUMN IF EXISTS decision_reason;
