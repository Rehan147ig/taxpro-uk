import { pgTable, uuid, varchar, text, bigint, integer, boolean, timestamp } from 'drizzle-orm/pg-core';
import { tenants } from './tenants.js';
import { entities } from './entities.js';
import { accountingPeriods } from './accounting-periods.js';
import { taxPeriods } from './tax-periods.js';
import { users } from './users.js';

export const sourceDocuments = pgTable('source_documents', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  entityId: uuid('entity_id').references(() => entities.id, { onDelete: 'set null' }),
  accountingPeriodId: uuid('accounting_period_id').references(() => accountingPeriods.id, { onDelete: 'set null' }),
  taxPeriodId: uuid('tax_period_id').references(() => taxPeriods.id, { onDelete: 'set null' }),
  documentType: varchar('document_type', { length: 60 }).notNull(),
  filename: varchar('filename', { length: 255 }).notNull(),
  mimeType: varchar('mime_type', { length: 120 }).notNull(),
  sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
  storageKey: varchar('storage_key', { length: 255 }).notNull(),
  sha256: varchar('sha256', { length: 64 }).notNull(),
  provenance: varchar('provenance', { length: 60 }).notNull().default('manual_upload'),
  sourceSystem: varchar('source_system', { length: 60 }),
  extractionStatus: varchar('extraction_status', { length: 30 }).notNull().default('not_required'),
  extractionVersion: varchar('extraction_version', { length: 40 }),
  parserVersion: varchar('parser_version', { length: 80 }),
  ocrVersion: varchar('ocr_version', { length: 80 }),
  version: integer('version').notNull().default(1),
  parentDocumentId: uuid('parent_document_id'),
  isCurrent: boolean('is_current').notNull().default(true),
  uploadedByUserId: uuid('uploaded_by_user_id').references(() => users.id),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (table) => ({
  unq: {
    name: 'uq_source_documents_tenant_storage_key',
    unique: true,
    columns: [table.tenantId, table.storageKey],
  },
}));
