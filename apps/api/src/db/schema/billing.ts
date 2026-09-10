import { pgTable, uuid, varchar, timestamp, numeric, jsonb, boolean, integer, uniqueIndex } from 'drizzle-orm/pg-core';
import { tenants } from './tenants.js';

// ── Sprint 2: plans / subscriptions / billing accounts ──
// Plans are persistent (not env-only) so tenants can have different run
// limits, entities, seats, and feature flags. Invoices and entitlement
// guards read from tenant_subscriptions, never from frontend flags.

export const billingPlans = pgTable('billing_plans', {
  id: uuid('id').defaultRandom().primaryKey(),
  code: varchar('code', { length: 30 }).notNull().unique(),
  name: varchar('name', { length: 100 }).notNull(),
  description: varchar('description', { length: 500 }),
  includedRunsPerMonth: integer('included_runs_per_month').notNull().default(1),
  overagePricePerRun: numeric('overage_price_per_run', { precision: 12, scale: 2 }).notNull().default('50'),
  maxEntities: integer('max_entities'),
  maxSeats: integer('max_seats'),
  features: jsonb('features'),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

export type BillingPlan = typeof billingPlans.$inferSelect;

export const tenantSubscriptions = pgTable('tenant_subscriptions', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }).unique(),
  planId: uuid('plan_id').references(() => billingPlans.id, { onDelete: 'restrict' }),
  // trialing | active | past_due | cancelled | expired
  status: varchar('status', { length: 30 }).notNull().default('trialing'),
  billingInterval: varchar('billing_interval', { length: 20 }).notNull().default('monthly'),
  // Snapshot of the allowance at subscription time (plan changes don't rewrite history).
  includedRunsPerMonth: integer('included_runs_per_month').notNull().default(1),
  currentPeriodStart: timestamp('current_period_start').notNull().defaultNow(),
  currentPeriodEnd: timestamp('current_period_end'),
  trialEndsAt: timestamp('trial_ends_at'),
  cancelledAt: timestamp('cancelled_at'),
  // Reserved for Sprint 3 (Stripe/etc). Kept nullable so Sprint 1+2 works without a provider.
  providerCustomerId: varchar('provider_customer_id', { length: 128 }),
  providerSubscriptionId: varchar('provider_subscription_id', { length: 128 }),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

export type TenantSubscription = typeof tenantSubscriptions.$inferSelect;

export const billingAccounts = pgTable('billing_accounts', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }).unique(),
  billingEmail: varchar('billing_email', { length: 255 }),
  contactName: varchar('contact_name', { length: 255 }),
  vatNumber: varchar('vat_number', { length: 50 }),
  address: jsonb('address'),
  currency: varchar('currency', { length: 3 }).notNull().default('GBP'),
  providerCustomerId: varchar('provider_customer_id', { length: 128 }),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

export type BillingAccount = typeof billingAccounts.$inferSelect;

// Optional per-tenant feature overrides (e.g. extra pilot runs, SSO enablement).
// The entitlement guard checks this table after the plan/subscription check.
export const tenantEntitlements = pgTable('tenant_entitlements', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  featureKey: varchar('feature_key', { length: 80 }).notNull(),
  allowed: boolean('allowed').notNull().default(true),
  limitValue: integer('limit_value'),
  expiresAt: timestamp('expires_at'),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
}, (t) => [
  uniqueIndex('uq_tenant_entitlements_tenant_feature').on(t.tenantId, t.featureKey),
]);

export type TenantEntitlement = typeof tenantEntitlements.$inferSelect;
