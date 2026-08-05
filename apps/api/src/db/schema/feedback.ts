import { pgTable, uuid, varchar, text, jsonb, timestamp, index } from 'drizzle-orm/pg-core';
import { tenants } from './tenants.js';
import { users } from './users.js';
import { importBatches } from './import-batches.js';

export const FEEDBACK_TYPES = ['accepted', 'rejected', 'overridden', 'corrected'] as const;
export type FeedbackType = (typeof FEEDBACK_TYPES)[number];

/**
 * Reviewer feedback event log — the learning system's raw material.
 *
 * Every accepted / rejected / overridden recommendation is recorded here
 * with the suggested vs applied snapshots and the reviewer's reason. The
 * deterministic precedent scorer (modules/intake/memory.ts) reads this log
 * to refine future suggestions and to compute learning metrics.
 */
export const reviewerFeedbackEvents = pgTable('reviewer_feedback_events', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  batchId: uuid('batch_id').references(() => importBatches.id, { onDelete: 'cascade' }),
  feedbackType: varchar('feedback_type', { length: 20 }).notNull(),
  subjectKind: varchar('subject_kind', { length: 40 }).notNull(),
  subjectId: uuid('subject_id').notNull(),
  suggested: jsonb('suggested'),
  applied: jsonb('applied'),
  reason: text('reason'),
  createdByUserId: uuid('created_by_user_id').references(() => users.id),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (table) => ({
  tenantIdx: index('idx_feedback_tenant_created').on(table.tenantId, table.createdAt),
  subjectIdx: index('idx_feedback_subject').on(table.tenantId, table.subjectKind, table.subjectId),
}));
