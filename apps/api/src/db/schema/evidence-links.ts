import { pgTable, uuid, varchar, text, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { tenants } from './tenants.js';
import { sourceDocuments } from './source-documents.js';
import { users } from './users.js';

export const EVIDENCE_ROLES = ['source', 'supporting', 'confirmation', 'correction'] as const;
export type EvidenceRole = (typeof EVIDENCE_ROLES)[number];

/**
 * Evidence graph edge: a versioned source document attached to any governed
 * subject (import batch, batch row, mapping, proposal, adjustment, run,
 * review item, account). Downloads go through the documents module; the
 * document itself is immutable and checksummed.
 */
export const evidenceLinks = pgTable('evidence_links', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  subjectKind: varchar('subject_kind', { length: 40 }).notNull(),
  subjectId: uuid('subject_id').notNull(),
  documentId: uuid('document_id').notNull().references(() => sourceDocuments.id, { onDelete: 'cascade' }),
  evidenceRole: varchar('evidence_role', { length: 20 }).notNull().default('supporting'),
  note: text('note'),
  createdByUserId: uuid('created_by_user_id').references(() => users.id),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (table) => ({
  subjectIdx: index('idx_evidence_links_subject').on(table.tenantId, table.subjectKind, table.subjectId),
  unq: uniqueIndex('uq_evidence_links_subject_document')
    .on(table.tenantId, table.subjectKind, table.subjectId, table.documentId),
}));
