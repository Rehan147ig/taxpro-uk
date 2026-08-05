-- ================================================================
-- 0018 — intake DELETE policies.
--
-- enable_intake_rls() (0017) created SELECT/INSERT/UPDATE policies but no
-- DELETE policy, so RLS default-deny made every DELETE silently remove
-- zero rows. taxpro_app was explicitly granted DELETE on exactly two
-- intake tables (evidence_links, tax_memory_precedents); restore DELETE
-- under tenant isolation for those. Every other intake table keeps the
-- default-deny DELETE posture (append-only events, governed records).
-- ================================================================

DROP POLICY IF EXISTS tenant_isolation_delete ON evidence_links;
CREATE POLICY tenant_isolation_delete ON evidence_links
  FOR DELETE
  USING (tenant_id = app_current_tenant_id());

DROP POLICY IF EXISTS tenant_isolation_delete ON tax_memory_precedents;
CREATE POLICY tenant_isolation_delete ON tax_memory_precedents
  FOR DELETE
  USING (tenant_id = app_current_tenant_id());

-- ================================================================
-- ROLLBACK
-- ================================================================
-- To revert:
--   DROP POLICY IF EXISTS tenant_isolation_delete ON evidence_links;
--   DROP POLICY IF EXISTS tenant_isolation_delete ON tax_memory_precedents;
