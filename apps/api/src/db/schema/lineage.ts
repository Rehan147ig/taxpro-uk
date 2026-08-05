import { pgTable, uuid, varchar, text, jsonb, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { tenants } from './tenants.js';

/**
 * Knowledge graph foundation — typed, tenant-scoped edges between domain
 * records. Written by the intake flows; the lineage read API traverses both
 * these edges and the existing foreign keys so every trace is derivable.
 */
export const dataLineageEdges = pgTable('data_lineage_edges', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  sourceKind: varchar('source_kind', { length: 40 }).notNull(),
  sourceId: uuid('source_id').notNull(),
  targetKind: varchar('target_kind', { length: 40 }).notNull(),
  targetId: uuid('target_id').notNull(),
  relation: varchar('relation', { length: 40 }).notNull(),
  metadata: jsonb('metadata'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (table) => ({
  sourceIdx: index('idx_lineage_source').on(table.tenantId, table.sourceKind, table.sourceId),
  targetIdx: index('idx_lineage_target').on(table.tenantId, table.targetKind, table.targetId),
  unq: uniqueIndex('uq_lineage_edge')
    .on(table.tenantId, table.sourceKind, table.sourceId, table.targetKind, table.targetId, table.relation),
}));

export function edge(
  sourceKind: string,
  sourceId: string,
  targetKind: string,
  targetId: string,
  relation: string,
  metadata?: Record<string, unknown>,
) {
  return { sourceKind, sourceId, targetKind, targetId, relation, metadata };
}
