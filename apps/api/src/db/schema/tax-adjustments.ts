import { pgTable, uuid, varchar, decimal, text, integer, timestamp, date, index, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { tenants } from './tenants.js';
import { users } from './users.js';
import { provisionRuns } from './provision-runs.js';
import { accounts } from './accounts.js';
import { sourceDocuments } from './source-documents.js';

/**
 * Governed manual tax adjustments.
 *
 * Every adjustment requires a reason (text), an actor (user), a timestamp
 * and an optional evidence document link. Adjustments are versioned and
 * supersede one another; they never silently mutate a locked run — the
 * immutable run contract lives in provision_runs.
 */
export const taxAdjustments = pgTable('tax_adjustments', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  provisionRunId: uuid('provision_run_id').references(() => provisionRuns.id, { onDelete: 'cascade' }),
  accountId: uuid('account_id').references(() => accounts.id, { onDelete: 'set null' }),
  adjustmentType: varchar('adjustment_type', { length: 30 }).notNull(), // permanent | temporary | other
  amount: decimal('amount', { precision: 18, scale: 2 }).notNull(),
  description: text('description'),
  reason: text('reason').notNull(),
  evidenceDocumentId: uuid('evidence_document_id').references(() => sourceDocuments.id, { onDelete: 'set null' }),
  createdByUserId: uuid('created_by_user_id').notNull().references(() => users.id),
  version: integer('version').notNull().default(1),
  supersedesAdjustmentId: uuid('supersedes_adjustment_id').references((): AnyPgColumn => taxAdjustments.id),
  status: varchar('status', { length: 30 }).notNull().default('pending'),
  decidedByUserId: uuid('decided_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  decidedAt: timestamp('decided_at'),
  decisionReason: text('decision_reason'),
  effectivePeriod: date('effective_period'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (table) => ({
  runIdx: index('idx_tax_adjustments_run').on(table.tenantId, table.provisionRunId),
  statusIdx: index('idx_tax_adjustments_status').on(table.tenantId, table.status),
}));
