import { pgTable, uuid, text, numeric, date, boolean, timestamp, index } from 'drizzle-orm/pg-core';
import { tenants } from './tenants.js';
import { entities } from './entities.js';
import { importBatches } from './import-batches.js';

/**
 * Fixed Asset Register items (Feature 5).
 *
 * Detailed asset schedules per entity, fed into the engine's CAA 2001
 * capital-allowance pools. pool_type uses the intake vocabulary; the mapping
 * onto the engine's UkAllowancePool lives in
 * modules/intake/asset-register.ts (POOL_TO_ENGINE_INPUT).
 *
 * Tenant isolation: RLS USING (tenant_id = app_current_tenant_id()),
 * every query goes through withTenantContext. Deletes are soft
 * (is_active = false) — the runtime role has no DELETE/TRUNCATE.
 */
export const assetRegisterItems = pgTable('asset_register_items', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  entityId: uuid('entity_id').notNull().references(() => entities.id, { onDelete: 'cascade' }),
  importBatchId: uuid('import_batch_id').references(() => importBatches.id, { onDelete: 'set null' }),
  accountExternalId: text('account_external_id'),
  assetDescription: text('asset_description').notNull(),
  cost: numeric('cost', { precision: 15, scale: 2 }).notNull(),
  poolType: text('pool_type').notNull(),
  placedInServiceDate: date('placed_in_service_date').notNull(),
  disposalDate: date('disposal_date'),
  disposalProceeds: numeric('disposal_proceeds', { precision: 15, scale: 2 }),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  entityActiveIdx: index('idx_asset_register_entity_active').on(table.tenantId, table.entityId, table.isActive),
}));
