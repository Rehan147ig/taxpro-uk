/**
 * Persistent plan catalogue (Sprint 2).
 *
 * Plans live in `billing_plans` so tenants can have different run limits,
 * entities, seats, and feature flags. This module is the code-side mirror
 * of the seeded catalogue in `billing_sprint1_2.sql` — used when a tenant
 * has no subscription row yet (auto-provisioned as pilot/trialing) and for
 * display copy. The database is the source of truth for allowance checks.
 */

export type PlanCode = 'pilot' | 'professional' | 'firm';

export interface PlanDefinition {
  code: PlanCode;
  name: string;
  description: string;
  includedRunsPerMonth: number;
  overagePricePerRun: number;
  maxEntities: number | null;
  maxSeats: number | null;
  features: Record<string, unknown>;
}

export const PLANS: Record<PlanCode, PlanDefinition> = {
  pilot: {
    code: 'pilot',
    name: 'Pilot',
    description: 'One supported run with guided onboarding and a defined success review.',
    includedRunsPerMonth: 1,
    overagePricePerRun: 50,
    maxEntities: 2,
    maxSeats: 3,
    features: { support: 'guided_onboarding', review_workflow: true },
  },
  professional: {
    code: 'professional',
    name: 'Professional',
    description:
      'Annual workspace with included runs, reviewer workflow, evidence package, standard integrations.',
    includedRunsPerMonth: 10,
    overagePricePerRun: 50,
    maxEntities: 10,
    maxSeats: 10,
    features: { review_workflow: true, evidence_package: true, integrations: 'standard' },
  },
  firm: {
    code: 'firm',
    name: 'Firm / Group',
    description:
      'High volume, portfolio controls, SSO, advanced roles, integrations, implementation, premium support.',
    includedRunsPerMonth: 100,
    overagePricePerRun: 45,
    maxEntities: 100,
    maxSeats: 100,
    features: { sso: true, portfolio_controls: true, premium_support: true },
  },
};

export const DEFAULT_PLAN_CODE: PlanCode = 'pilot';

export function getPlan(code: string | null | undefined): PlanDefinition {
  if (code === 'professional' || code === 'firm' || code === 'pilot') return PLANS[code];
  return PLANS[DEFAULT_PLAN_CODE];
}
