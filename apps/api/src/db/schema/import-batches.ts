import { pgTable, uuid, varchar, text, jsonb, integer, timestamp, date, index, uniqueIndex, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { tenants } from './tenants.js';
import { entities } from './entities.js';
import { accountingPeriods } from './accounting-periods.js';
import { sourceDocuments } from './source-documents.js';
import { users } from './users.js';

export const IMPORT_BATCH_STATUSES = [
  'draft', 'validating', 'ready_for_review', 'committed', 'failed', 'superseded',
] as const;
export type ImportBatchStatus = (typeof IMPORT_BATCH_STATUSES)[number];

export const IMPORT_SOURCE_TYPES = ['csv', 'netsuite', 'xero', 'warehouse', 'api'] as const;
export type ImportSourceType = (typeof IMPORT_SOURCE_TYPES)[number];

export const importBatches = pgTable('import_batches', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  entityId: uuid('entity_id').notNull().references(() => entities.id, { onDelete: 'cascade' }),
  accountingPeriodId: uuid('accounting_period_id').notNull().references(() => accountingPeriods.id, { onDelete: 'cascade' }),
  sourceDocumentId: uuid('source_document_id').references(() => sourceDocuments.id, { onDelete: 'set null' }),
  sourceType: varchar('source_type', { length: 20 }).notNull(),
  sourceSystem: varchar('source_system', { length: 100 }),
  sourceReference: varchar('source_reference', { length: 255 }),
  originalFilename: varchar('original_filename', { length: 255 }).notNull(),
  checksum: varchar('checksum', { length: 64 }).notNull(),
  storageKey: varchar('storage_key', { length: 255 }),
  parserVersion: varchar('parser_version', { length: 80 }),
  rowCount: integer('row_count').notNull().default(0),
  status: varchar('status', { length: 30 }).notNull().default('draft'),
  validationSummary: jsonb('validation_summary'),
  controlTotals: jsonb('control_totals'),
  headers: jsonb('headers'),
  createdByUserId: uuid('created_by_user_id').references(() => users.id),
  reviewedByUserId: uuid('reviewed_by_user_id').references(() => users.id),
  committedAt: timestamp('committed_at'),
  failedAt: timestamp('failed_at'),
  failureReason: text('failure_reason'),
  supersededByBatchId: uuid('superseded_by_batch_id').references((): AnyPgColumn => importBatches.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (table) => ({
  idempotencyKey: uniqueIndex('uq_import_batches_idempotency')
    .on(table.tenantId, table.entityId, table.accountingPeriodId, table.sourceType, table.sourceSystem, table.checksum),
  queueIdx: index('idx_import_batches_tenant_status')
    .on(table.tenantId, table.status, table.createdAt),
}));

export const importBatchRows = pgTable('import_batch_rows', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  batchId: uuid('batch_id').notNull().references(() => importBatches.id, { onDelete: 'cascade' }),
  rowNumber: integer('row_number').notNull(),
  raw: jsonb('raw').notNull(),
  normalized: jsonb('normalized'),
  validation: jsonb('validation'),
  status: varchar('status', { length: 20 }).notNull().default('ok'),
  accountId: uuid('account_id'),
  committedTrialBalanceId: uuid('committed_trial_balance_id'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (table) => ({
  batchIdx: index('idx_import_batch_rows_batch').on(table.batchId, table.rowNumber),
  batchStatusIdx: index('idx_import_batch_rows_batch_status').on(table.batchId, table.status),
}));

export const importBatchEvents = pgTable('import_batch_events', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  batchId: uuid('batch_id').notNull().references(() => importBatches.id, { onDelete: 'cascade' }),
  eventType: varchar('event_type', { length: 60 }).notNull(),
  actorType: varchar('actor_type', { length: 20 }).notNull().default('user'),
  actorUserId: uuid('actor_user_id').references(() => users.id),
  reason: text('reason'),
  beforeState: jsonb('before_state'),
  afterState: jsonb('after_state'),
  metadata: jsonb('metadata'),
  occurredAt: timestamp('occurred_at').notNull().defaultNow(),
}, (table) => ({
  batchIdx: index('idx_import_batch_events_batch').on(table.batchId, table.occurredAt),
}));
