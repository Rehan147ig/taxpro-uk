import { pgTable, uuid, varchar, jsonb, timestamp, uniqueIndex, index } from 'drizzle-orm/pg-core';
import { tenants } from './tenants.js';
import { users } from './users.js';

/**
 * Remembered XLSX column maps (Feature 1 — XLSX ingest).
 *
 * Keyed by (tenant_id, client_fingerprint) so the same client's workbook
 * layout is reused next period without re-mapping.
 *
 * client_fingerprint = sha256 of JSON { sortedHeaders, sheetName } — see
 * modules/intake/xlsx.ts `buildClientFingerprint`. Deterministic, no PII.
 *
 * Tenant isolation: RLS USING (tenant_id = app_current_tenant_id()),
 * every query goes through withTenantContext.
 */
export const intakeColumnMaps = pgTable('intake_column_maps', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  clientFingerprint: varchar('client_fingerprint', { length: 64 }).notNull(),
  sheetName: varchar('sheet_name', { length: 255 }).notNull(),
  headers: jsonb('headers').notNull(),
  columnMap: jsonb('column_map').notNull(),
  createdByUserId: uuid('created_by_user_id').references(() => users.id),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (table) => ({
  tenantFingerprintUq: uniqueIndex('uq_intake_column_maps_tenant_fingerprint')
    .on(table.tenantId, table.clientFingerprint),
  tenantIdx: index('idx_intake_column_maps_tenant').on(table.tenantId),
}));
