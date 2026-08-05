import { pgTable, uuid, varchar, jsonb, timestamp, index } from 'drizzle-orm/pg-core';
import { tenants } from './tenants.js';
import { aiRuns } from './ai-runs.js';

/**
 * Agent events — the structured outbox agents use to communicate.
 *
 * Agents never call each other directly and never write accounting data.
 * They emit typed events here; consumers subscribe by event_type. The table
 * is append-only (trigger + grants), tenant-scoped (RLS).
 */
export const agentEvents = pgTable('agent_events', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  runId: uuid('run_id').references(() => aiRuns.id, { onDelete: 'set null' }),
  sourceAgent: varchar('source_agent', { length: 100 }).notNull(),
  eventType: varchar('event_type', { length: 100 }).notNull(),
  payload: jsonb('payload'),
  correlationId: varchar('correlation_id', { length: 128 }),
  occurredAt: timestamp('occurred_at').notNull().defaultNow(),
}, (table) => ({
  tenantTypeIdx: index('idx_agent_events_tenant_type').on(table.tenantId, table.eventType, table.occurredAt),
  runIdx: index('idx_agent_events_run').on(table.runId),
}));

export type AgentEventSelect = typeof agentEvents.$inferSelect;
