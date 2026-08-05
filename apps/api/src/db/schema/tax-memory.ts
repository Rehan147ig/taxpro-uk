import { pgTable, uuid, varchar, text, jsonb, integer, decimal, timestamp, date, index } from 'drizzle-orm/pg-core';
import { tenants } from './tenants.js';
import { entities } from './entities.js';
import { entityGroups } from './entity-groups.js';
import { taxMappings } from './tax-mappings.js';
import { importBatches, importBatchRows } from './import-batches.js';
import { users } from './users.js';
import { accounts } from './accounts.js';

/**
 * Tax memory — durable, explainable precedent store.
 *
 * Approved account-to-tax mappings, scoped by tenant, entity/group,
 * jurisdiction and effective period. Suggestions are scored deterministically
 * from this store (see modules/intake/memory.ts); a precedent is never applied
 * silently — it is surfaced as a pending mapping_suggestion that a reviewer
 * accepts, rejects or overrides.
 */
export const taxMemoryPrecedents = pgTable('tax_memory_precedents', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  entityId: uuid('entity_id').references(() => entities.id, { onDelete: 'cascade' }),
  groupId: uuid('group_id').references(() => entityGroups.id, { onDelete: 'set null' }),
  jurisdiction: varchar('jurisdiction', { length: 30 }).notNull().default('UK_FRS102'),
  effectiveFrom: date('effective_from').notNull(),
  effectiveTo: date('effective_to'),
  accountName: varchar('account_name', { length: 255 }).notNull(),
  accountNumber: varchar('account_number', { length: 50 }),
  accountType: varchar('account_type', { length: 50 }).notNull(),
  detailType: varchar('detail_type', { length: 100 }),
  taxAccountType: varchar('tax_account_type', { length: 100 }).notNull(),
  bookTreatment: varchar('book_treatment', { length: 50 }).notNull(),
  timingCategory: varchar('timing_category', { length: 50 }),
  sourceMappingId: uuid('source_mapping_id').references(() => taxMappings.id, { onDelete: 'set null' }),
  source: varchar('source', { length: 30 }).notNull().default('approved_mapping'),
  createdByUserId: uuid('created_by_user_id').references(() => users.id),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (table) => ({
  lookupIdx: index('idx_tax_memory_lookup')
    .on(table.tenantId, table.jurisdiction, table.accountName),
  scopeIdx: index('idx_tax_memory_scope')
    .on(table.tenantId, table.entityId, table.groupId),
  unq: {
    name: 'uq_tax_memory_source_mapping',
    unique: true,
    columns: [table.tenantId, table.sourceMappingId],
  },
}));

export const SUGGESTION_SOURCES = ['tax_memory', 'precedent', 'ai', 'rules', 'fallback'] as const;
export type SuggestionSource = (typeof SUGGESTION_SOURCES)[number];

export const SUGGESTION_STATUSES = ['pending', 'accepted', 'rejected', 'overridden', 'applied'] as const;
export type SuggestionStatus = (typeof SUGGESTION_STATUSES)[number];

export const mappingSuggestions = pgTable('mapping_suggestions', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  batchId: uuid('batch_id').references(() => importBatches.id, { onDelete: 'cascade' }),
  batchRowId: uuid('batch_row_id').references(() => importBatchRows.id, { onDelete: 'cascade' }),
  accountId: uuid('account_id').references(() => accounts.id, { onDelete: 'cascade' }),
  entityId: uuid('entity_id').references(() => entities.id, { onDelete: 'cascade' }),
  period: date('period'),
  suggestedTaxAccountType: varchar('suggested_tax_account_type', { length: 100 }).notNull(),
  bookTreatment: varchar('book_treatment', { length: 50 }).notNull(),
  timingCategory: varchar('timing_category', { length: 50 }),
  confidenceScore: decimal('confidence_score', { precision: 3, scale: 2 }),
  source: varchar('source', { length: 30 }).notNull().default('tax_memory'),
  citedPrecedentId: uuid('cited_precedent_id').references(() => taxMemoryPrecedents.id, { onDelete: 'set null' }),
  citedAccountName: varchar('cited_account_name', { length: 255 }),
  rationale: text('rationale'),
  status: varchar('status', { length: 20 }).notNull().default('pending'),
  decidedByUserId: uuid('decided_by_user_id').references(() => users.id),
  decidedAt: timestamp('decided_at'),
  decisionReason: text('decision_reason'),
  overriddenFrom: jsonb('overridden_from'),
  appliedMappingId: uuid('applied_mapping_id').references(() => taxMappings.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (table) => ({
  batchRowIdx: index('idx_mapping_suggestions_batch_row').on(table.tenantId, table.batchRowId),
  statusIdx: index('idx_mapping_suggestions_status').on(table.tenantId, table.status),
}));

export type MappingSuggestionSelect = typeof mappingSuggestions.$inferSelect;
