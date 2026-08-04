import bcrypt from 'bcryptjs';
import { migrationDb as db } from '../config/db.js';
import { tenants } from './schema/tenants.js';
import { users } from './schema/users.js';
import { entities } from './schema/entities.js';
import { entityGroups } from './schema/entity-groups.js';
import { accountingPeriods } from './schema/accounting-periods.js';
import { taxPeriods } from './schema/tax-periods.js';
import { sourceDocuments } from './schema/source-documents.js';
import { accounts } from './schema/accounts.js';
import { taxMappings } from './schema/tax-mappings.js';
import { mappingProposals } from './schema/mapping-proposals.js';
import { ukRules } from './schema/uk-rules.js';
import { reviewItems } from './schema/review-items.js';
import { trialBalance } from './schema/trial-balance.js';
import { and, eq } from 'drizzle-orm';

const DEMO_PERIOD = '2026-01-01';
const DEMO_PERIOD_END = '2026-12-31';

/**
 * Demo chart of accounts for the UK demo tenant (FRS 102, GBP).
 */
const demoAccounts = [
  {
    externalId: '4000',
    accountNumber: '4000',
    name: 'Sales revenue',
    type: 'Income',
    detailType: 'Income',
    balance: '-4800000',
    mapping: { taxAccountType: 'NODIFF_REVENUE', bookTreatment: 'no_diff' },
  },
  {
    externalId: '5000',
    accountNumber: '5000',
    name: 'Salaries and wages',
    type: 'Expense',
    detailType: 'Expense',
    balance: '1600000',
    mapping: { taxAccountType: 'NODIFF_SALARIES', bookTreatment: 'no_diff' },
  },
  {
    externalId: '5100',
    accountNumber: '5100',
    name: 'Office rent',
    type: 'Expense',
    detailType: 'Expense',
    balance: '240000',
    mapping: { taxAccountType: 'NODIFF_RENT', bookTreatment: 'no_diff' },
  },
  {
    externalId: '5200',
    accountNumber: '5200',
    name: 'Book depreciation expense',
    type: 'Expense',
    detailType: 'Fixed Asset',
    balance: '520000',
    mapping: { taxAccountType: 'TEMP_DEPRECIATION', bookTreatment: 'temporary', timingCategory: 'taxable_temporary' },
  },
  {
    externalId: '5300',
    accountNumber: '5300',
    name: 'Bad debt reserve',
    type: 'Expense',
    detailType: 'Expense',
    balance: '120000',
    mapping: { taxAccountType: 'TEMP_BAD_DEBT_RESERVE', bookTreatment: 'temporary', timingCategory: 'deductible_temporary' },
  },
  {
    externalId: '5400',
    accountNumber: '5400',
    name: 'Research and development',
    type: 'Expense',
    detailType: 'Expense',
    balance: '650000',
    mapping: { taxAccountType: 'TEMP_RESEARCH_CREDIT', bookTreatment: 'temporary', timingCategory: 'deductible_temporary' },
  },
  {
    externalId: '5500',
    accountNumber: '5500',
    name: 'Non-deductible entertaining',
    type: 'Expense',
    detailType: 'Expense',
    balance: '85000',
    mapping: { taxAccountType: 'PERM_MEALS_ENTERTAINMENT', bookTreatment: 'permanent' },
  },
  {
    externalId: '5600',
    accountNumber: '5600',
    name: 'Penalties and fines',
    type: 'Expense',
    detailType: 'Expense',
    balance: '25000',
    mapping: { taxAccountType: 'PERM_PENALTIES_FINES', bookTreatment: 'permanent' },
  },
  // Low-confidence AI mapping to trigger review item
  {
    externalId: '5700',
    accountNumber: '5700',
    name: 'Software subscription costs',
    type: 'Expense',
    detailType: 'Expense',
    balance: '95000',
    mapping: { taxAccountType: 'TEMP_DEFERRED_REVENUE', bookTreatment: 'temporary', timingCategory: 'deductible_temporary' },
  },
  // Unmapped account (no mapping entry created below) to trigger missing_mapping review
  {
    externalId: '5800',
    accountNumber: '5800',
    name: 'Cloud infrastructure hosting',
    type: 'Expense',
    detailType: 'Expense',
    balance: '180000',
    mapping: null, // no mapping created
  },
] as const;

async function seedTenant(tenantId: string | undefined, name: string) {
  return db.insert(tenants).values({
    ...(tenantId ? { id: tenantId } : {}),
    name,
    slug: 'acme-demo',
    taxRate: '0.25',
    stateTaxRate: '0',
    fiscalYearEnd: '2026-12-31',
  }).onConflictDoUpdate({
    target: tenants.slug,
    set: {
      name,
      taxRate: '0.25',
      stateTaxRate: '0',
      updatedAt: new Date(),
    },
  }).returning();
}

async function main() {
  const [tenant] = await seedTenant(undefined, 'Acme Demo Corp (UK)');

  const passwordHash = await bcrypt.hash('TaxProDemo123!', 12);
  await db.insert(users).values({
    tenantId: tenant.id,
    email: 'demo@taxpro.ai',
    passwordHash,
    role: 'admin',
  }).onConflictDoUpdate({
    target: users.email,
    set: { tenantId: tenant.id, passwordHash, role: 'admin' },
  });

  // Partner (same tenant) for the two-person sign-off workflow: a partner must
  // never be the person who submitted the run.
  await db.insert(users).values({
    tenantId: tenant.id,
    email: 'partner@taxpro.ai',
    passwordHash,
    role: 'admin',
  }).onConflictDoUpdate({
    target: users.email,
    set: { tenantId: tenant.id, passwordHash, role: 'admin' },
  });

  const [ukEntity] = await db.insert(entities).values({
    tenantId: tenant.id,
    externalId: 'ACME-UK',
    name: 'Acme UK Ltd',
    type: 'domestic',
    currency: 'GBP',
    isConsolidated: true,
    taxJurisdiction: 'UK_FRS102',
  }).onConflictDoUpdate({
    target: [entities.tenantId, entities.externalId],
    set: { name: 'Acme UK Ltd', taxJurisdiction: 'UK_FRS102', currency: 'GBP', updatedAt: new Date() },
  }).returning();

  const entitiesToSeed = [ukEntity];

  // ── Phase B domain model: entity group, periods, rules, proposals, documents, review items ──
  // Entity groups, mapping proposals and review items have no natural unique
  // constraint, so idempotency is enforced by looking up existing rows first.
  const [existingGroup] = await db.select({ id: entityGroups.id }).from(entityGroups)
    .where(and(eq(entityGroups.tenantId, tenant.id), eq(entityGroups.name, 'Acme Group (UK)')))
    .limit(1);

  const [ukGroup] = existingGroup
    ? [existingGroup]
    : await db.insert(entityGroups).values({
        tenantId: tenant.id,
        name: 'Acme Group (UK)',
        description: 'Demo UK group: Acme UK Ltd consolidated for corporation tax',
      }).returning();

  if (ukGroup) {
    await db.update(entities).set({ groupId: ukGroup.id, updatedAt: new Date() })
      .where(eq(entities.id, ukEntity.id));
  }

  const [ukAccountingPeriod] = await db.insert(accountingPeriods).values({
    tenantId: tenant.id,
    entityId: ukEntity.id,
    name: 'FY2026 (12 months)',
    startDate: '2026-01-01',
    endDate: '2026-12-31',
    periodType: 'annual',
    status: 'open',
  }).onConflictDoNothing().returning();

  const [ukTaxPeriod] = await db.insert(taxPeriods).values({
    tenantId: tenant.id,
    entityId: ukEntity.id,
    accountingPeriodId: ukAccountingPeriod?.id ?? null,
    startDate: '2026-01-01',
    endDate: '2026-12-31',
    durationMonths: 12,
    isStandardDuration: true,
    status: 'open',
  }).onConflictDoNothing().returning();

  // Approved UK rules registry: what calculations must snapshot as "used".
  // Demo entries only — real rules must come through the review/approval flow.
  const demoRules = [
    {
      ruleKey: 'CTA2010_S10_PERIOD_STANDARD',
      effectiveFrom: '2026-01-01',
      sourceUrl: 'https://www.legislation.gov.uk/ukpga/2010/4/section/10',
      testFixtureRef: 'uk-rules/period-standard.test.ts',
      changeRationale: 'Corporation tax accounting periods: standard period is 12 months (CTA 2010 s.10)',
    },
    {
      ruleKey: 'FRCFRS102_DEPRECIATION_TEMPORARY',
      effectiveFrom: '2026-01-01',
      sourceUrl: 'https://www.frc.org.uk',
      testFixtureRef: 'uk-rules/depreciation-temporary.test.ts',
      changeRationale: 'FRS 102 depreciation gives a temporary book/tax difference; deferred tax applies',
    },
    {
      ruleKey: 'CTA2009_ENTERTAINING_PERMANENT',
      effectiveFrom: '2026-01-01',
      sourceUrl: 'https://www.legislation.gov.uk/ukpga/2009/4',
      testFixtureRef: 'uk-rules/entertaining-permanent.test.ts',
      changeRationale: 'Business entertaining disallowed: permanent difference for ETR reconciliation',
    },
  ] as const;

  for (const rule of demoRules) {
    await db.insert(ukRules).values({
      tenantId: tenant.id,
      ruleKey: rule.ruleKey,
      jurisdiction: 'UK_FRS102',
      effectiveFrom: rule.effectiveFrom,
      sourceUrl: rule.sourceUrl,
      sourceSnapshotHash: 'demo-2026-01-01',
      author: 'TaxPro Demo Seed',
      approvalState: 'approved',
      version: 1,
      testFixtureRef: rule.testFixtureRef,
      changeRationale: rule.changeRationale,
      approvedAt: new Date(),
    }).onConflictDoUpdate({
      target: [ukRules.tenantId, ukRules.ruleKey, ukRules.version],
      set: { approvalState: 'approved', updatedAt: new Date() },
    });
  }

  // Demo source-document metadata (artefact store). No real bytes are
  // written; the storage key documents provenance for the demo tenant.
  if (ukTaxPeriod) {
    await db.insert(sourceDocuments).values({
      tenantId: tenant.id,
      entityId: ukEntity.id,
      accountingPeriodId: ukAccountingPeriod?.id ?? null,
      taxPeriodId: ukTaxPeriod.id,
      documentType: 'trial_balance',
      filename: 'acme-uk-fy2026-trial-balance.csv',
      mimeType: 'text/csv',
      sizeBytes: 12345,
      storageKey: `demo://${tenant.id}/trial_balance/acme-uk-fy2026.csv`,
      sha256: '0000000000000000000000000000000000000000000000000000000000000000',
      provenance: 'demo_seed',
      extractionStatus: 'not_required',
      version: 1,
      isCurrent: true,
      uploadedByUserId: undefined,
    }).onConflictDoNothing();
  }

  // Demo review items on the entity (no provision run yet) — evidence flow,
  // owner assignment and waiver are all demonstrable from the UI.
  const demoReviewItems = [
    {
      itemType: 'low_confidence_mapping',
      severity: 'medium',
      status: 'open',
      title: 'Software subscription costs mapping needs review',
      description: 'Low-confidence AI mapping on account 5700 (TEMP_DEFERRED_REVENUE). Confirm it is not a fixed asset.',
      entityId: ukEntity.id,
      sourceRef: 'account:5700',
      evidenceRequested: 'Supplier contract or invoice for the software subscription.',
    },
    {
      itemType: 'missing_mapping',
      severity: 'high',
      status: 'open',
      title: 'Cloud infrastructure hosting has no mapping',
      description: 'Account 5800 has no tax mapping. Classify to proceed with the provision.',
      entityId: ukEntity.id,
      sourceRef: 'account:5800',
      evidenceRequested: '12-month hosting invoice breakdown (VAT, term).',
    },
  ] as const;

  for (const item of demoReviewItems) {
    const [existingItem] = await db.select({ id: reviewItems.id }).from(reviewItems)
      .where(and(
        eq(reviewItems.tenantId, tenant.id),
        eq(reviewItems.entityId, ukEntity.id),
        eq(reviewItems.title, item.title),
      ))
      .limit(1);
    if (existingItem) continue;
    await db.insert(reviewItems).values({
      tenantId: tenant.id,
      itemType: item.itemType,
      severity: item.severity,
      status: item.status,
      title: item.title,
      description: item.description,
      entityId: item.entityId,
      sourceRef: item.sourceRef,
      evidenceRequested: item.evidenceRequested,
    }).onConflictDoNothing();
  }

  let accountCount = 0;
  for (const demoAccount of demoAccounts) {
    const [account] = await db.insert(accounts).values({
      tenantId: tenant.id,
      externalId: demoAccount.externalId,
      accountNumber: demoAccount.accountNumber,
      name: demoAccount.name,
      type: demoAccount.type,
      detailType: demoAccount.detailType,
      isSummary: false,
    }).onConflictDoUpdate({
      target: [accounts.tenantId, accounts.externalId],
      set: {
        accountNumber: demoAccount.accountNumber,
        name: demoAccount.name,
        type: demoAccount.type,
        detailType: demoAccount.detailType,
        updatedAt: new Date(),
      },
    }).returning();

    // Skip mapping for unmapped demo account (triggers missing_mapping review item)
    if (demoAccount.mapping === null) {
      for (const entity of entitiesToSeed) {
        await db.insert(trialBalance).values({
          tenantId: tenant.id,
          entityId: entity.id,
          accountId: account.id,
          period: DEMO_PERIOD,
          periodEnd: DEMO_PERIOD_END,
          fiscalYear: 2026,
          fiscalPeriod: 0,
          debit: Number(demoAccount.balance) > 0 ? demoAccount.balance : '0',
          credit: Number(demoAccount.balance) < 0 ? String(Math.abs(Number(demoAccount.balance))) : '0',
          balance: demoAccount.balance,
          source: 'demo',
        }).onConflictDoUpdate({
          target: [trialBalance.tenantId, trialBalance.entityId, trialBalance.accountId, trialBalance.period, trialBalance.source],
          set: { balance: demoAccount.balance },
        });
      }
      accountCount++;
      continue;
    }

    // Low confidence for software subscription (triggers low_confidence_mapping review item)
    const confidenceScore = demoAccount.externalId === '5700' ? '0.65' : '0.95';

    await db.insert(taxMappings).values({
      tenantId: tenant.id,
      accountId: account.id,
      taxAccountType: demoAccount.mapping.taxAccountType,
      bookTreatment: demoAccount.mapping.bookTreatment,
      timingCategory: 'timingCategory' in demoAccount.mapping ? demoAccount.mapping.timingCategory : undefined,
      confidenceScore,
      suggestedByAi: true,
      aiExplanation: `Demo mapping for ${demoAccount.name}`,
      version: 1,
      isActive: true,
    }).onConflictDoUpdate({
      target: [taxMappings.tenantId, taxMappings.accountId, taxMappings.version],
      set: {
        taxAccountType: demoAccount.mapping.taxAccountType,
        bookTreatment: demoAccount.mapping.bookTreatment,
        timingCategory: 'timingCategory' in demoAccount.mapping ? demoAccount.mapping.timingCategory : undefined,
        confidenceScore: '0.95',
        suggestedByAi: true,
        aiExplanation: `Demo mapping for ${demoAccount.name}`,
        isActive: true,
        updatedAt: new Date(),
      },
    });

    for (const entity of entitiesToSeed) {
      await db.insert(trialBalance).values({
        tenantId: tenant.id,
        entityId: entity.id,
        accountId: account.id,
        period: DEMO_PERIOD,
        periodEnd: DEMO_PERIOD_END,
        fiscalYear: 2026,
        fiscalPeriod: 0,
        debit: Number(demoAccount.balance) > 0 ? demoAccount.balance : '0',
        credit: Number(demoAccount.balance) < 0 ? String(Math.abs(Number(demoAccount.balance))) : '0',
        balance: demoAccount.balance,
        source: 'demo',
      }).onConflictDoUpdate({
        target: [trialBalance.tenantId, trialBalance.entityId, trialBalance.accountId, trialBalance.period, trialBalance.source],
        set: {
          debit: Number(demoAccount.balance) > 0 ? demoAccount.balance : '0',
          credit: Number(demoAccount.balance) < 0 ? String(Math.abs(Number(demoAccount.balance))) : '0',
          balance: demoAccount.balance,
        },
      });
    }

    accountCount++;
  }

  // Pending mapping proposal (carry-forward style) to exercise the
  // proposal → human-decision flow without a live run. Runs after the
  // account loop so account 5800 exists; the target classification is
  // MANUAL_REVIEW so approval of this proposal must be a human decision.
  const [hostingAccount] = await db.select({ id: accounts.id, externalId: accounts.externalId })
    .from(accounts)
    .where(and(eq(accounts.tenantId, tenant.id), eq(accounts.externalId, '5800')))
    .limit(1);

  if (hostingAccount) {
    const [existingProposal] = await db.select({ id: mappingProposals.id }).from(mappingProposals)
      .where(and(
        eq(mappingProposals.tenantId, tenant.id),
        eq(mappingProposals.accountId, hostingAccount.id),
        eq(mappingProposals.version, 1),
      ))
      .limit(1);
    if (!existingProposal) {
      await db.insert(mappingProposals).values({
        tenantId: tenant.id,
        entityId: ukEntity.id,
        accountId: hostingAccount.id,
        sourceAccountExternalId: hostingAccount.externalId,
        sourceAccountName: 'Cloud infrastructure hosting',
        targetTaxClassification: 'MANUAL_REVIEW',
        bookTreatment: 'manual_review',
        proposalSource: 'rules',
        status: 'pending',
        version: 1,
        decisionReason: 'Cloud hosting is generally deductible; confirm 12-month VAT-adjusted cost split before approving.',
      }).onConflictDoNothing();
    }
  }

  console.log(`[Seed] Demo tenant ready: demo@taxpro.ai / TaxProDemo123! (partner: partner@taxpro.ai)`);
  console.log(`[Seed] UK entity: ${ukEntity.externalId} (${ukEntity.name}, GBP, UK_FRS102)`);
  console.log(`[Seed] Created ${accountCount} accounts and trial-balance rows for ${DEMO_PERIOD}.`);
  console.log(`[Seed] Phase B domain: entity group, FY2026 accounting/tax periods, 3 approved UK rules, 1 mapping proposal, 1 trial-balance doc, 2 review items.`);
}

main().catch((err) => {
  console.error('[Seed] Failed:', err);
  process.exit(1);
});
