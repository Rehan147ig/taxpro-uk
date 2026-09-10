import { pgTable, uuid, varchar, timestamp, numeric, jsonb, uniqueIndex } from 'drizzle-orm/pg-core';
import { tenants } from './tenants.js';
import { provisionRuns } from './provision-runs.js';

export const usageEvents = pgTable('usage_events', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  eventType: varchar('event_type', { length: 50 }).notNull(),
  provisionRunId: uuid('provision_run_id').references(() => provisionRuns.id, { onDelete: 'set null' }),
  occurredAt: timestamp('occurred_at').notNull().defaultNow(),
  quantity: numeric('quantity', { precision: 12, scale: 4 }).notNull().default('1'),
  unitPrice: numeric('unit_price', { precision: 12, scale: 2 }).notNull(),
  amount: numeric('amount', { precision: 12, scale: 2 }).notNull(),
  metadata: jsonb('metadata'),
  // ── Sprint 1+2 billing hardening ──
  // Idempotency key prevents duplicate charges on retries / repeated lifecycle calls.
  // Format: `${tenantId}:${provisionRunId}:${eventType}` for billable events.
  idempotencyKey: varchar('idempotency_key', { length: 128 }),
  // Which lifecycle milestone made this run billable (e.g. 'finalize', 'lock').
  sourceLifecycle: varchar('source_lifecycle', { length: 50 }),
  // Entitlement decision at billing time: 'free_trial' | 'included' | 'overage' | 'billable'.
  entitlementDecision: varchar('entitlement_decision', { length: 30 }),
  // ISO currency code snapshot (invoices must never re-rate on currency change).
  currency: varchar('currency', { length: 3 }).notNull().default('GBP'),
}, (t) => [
  // One billable event per (tenant, run, event-type). Retries hit this
  // constraint and become no-ops instead of duplicate charges.
  uniqueIndex('uq_usage_events_tenant_run_event')
    .on(t.tenantId, t.provisionRunId, t.eventType),
  uniqueIndex('uq_usage_events_idempotency_key')
    .on(t.idempotencyKey),
]);
