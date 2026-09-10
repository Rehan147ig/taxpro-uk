/**
 * Phase E — Multi-scenario UK synthetic demo tenant.
 *
 * Three realistic UK entities exercising the tax paths firms care about:
 *   apex-marginal-relief — CTA 2010 s.18D marginal relief (£50k–£250k band)
 *   biotech-rd-loss      — trading loss + RDEC + deferred tax asset (s29)
 *   cotswold-capex       — CAA 2001 capital allowances vs book depreciation
 *
 * All figures are balanced trial balances (Σ = 0) and calculate cleanly in
 * @taxpro/tax-engine — see scenarios.test.ts for the pinned expectations.
 * Amounts are strings (decimal-safe). Credits are negative, debits positive.
 */

export interface ScenarioAccount {
  externalId: string;
  accountNumber: string;
  name: string;
  type: 'Income' | 'Expense' | 'Asset' | 'Liability' | 'Equity';
  detailType: string;
  balance: string;
  placedInServiceDate?: string;
  mapping: {
    taxAccountType: string;
    bookTreatment: 'permanent' | 'temporary' | 'no_diff';
    timingCategory?: string;
    confidenceScore: string;
    aiExplanation: string;
  } | null;
  /** Pending AI proposal (no active mapping) — demonstrates the review workflow. */
  proposal?: {
    targetTaxClassification: string;
    bookTreatment: string;
    timingCategory?: string;
    confidenceScore: string;
    reason: string;
  };
}

export interface DemoScenario {
  id: 'apex-marginal-relief' | 'biotech-rd-loss' | 'cotswold-capex';
  entityExternalId: string;
  entityName: string;
  narrative: string;
  highlights: string[];
  /** Human-readable expected outcome shown by the demo UI after seeding. */
  expectedOutcome: string;
  period: string;
  periodEnd: string;
  fiscalYear: number;
  associatedCompanies?: number;
  /** RDEC-style supported credit amount (prepared, claimed via CT600 — not auto-computed). */
  supportedRdecCredit?: string;
  accounts: ScenarioAccount[];
}

export const SCENARIO_PERIOD = '2026-01-01';
export const SCENARIO_PERIOD_END = '2026-12-31';

export const SCENARIOS: Record<DemoScenario['id'], DemoScenario> = {
  'apex-marginal-relief': {
    id: 'apex-marginal-relief',
    entityExternalId: 'APEX-MFG',
    entityName: 'Apex Manufacturing Ltd',
    narrative:
      'Mid-size manufacturer with £150k taxable profits: inside the CTA 2010 s.18D marginal-relief band (£50k–£250k, 1 associated company). Book profit £125k matches the HMRC worked-example scale.',
    highlights: [
      'Marginal relief line in the ETR reconciliation (£1,500)',
      '£36,000 corporation tax at an effective ~28.8% of book profit',
      'Missing-mapping, low-confidence, and pending-proposal review mechanics',
    ],
    expectedOutcome:
      'Taxable profits £150,000 → marginal relief £1,500 → CT charge £36,000. DTA £750 on the £3,000 reversing bad-debt movement.',
    period: SCENARIO_PERIOD,
    periodEnd: SCENARIO_PERIOD_END,
    fiscalYear: 2026,
    associatedCompanies: 1,
    accounts: [
      { externalId: '1010', accountNumber: '1010', name: 'Cash at bank', type: 'Asset', detailType: 'Bank', balance: '125000', mapping: { taxAccountType: 'NODIFF_OTHER', bookTreatment: 'no_diff', confidenceScore: '0.95', aiExplanation: 'Cash — no book-tax difference' } },
      { externalId: '2000', accountNumber: '2000', name: 'Bad debt provision', type: 'Expense', detailType: 'Expense', balance: '20000', mapping: { taxAccountType: 'TEMP_BAD_DEBT_RESERVE', bookTreatment: 'temporary', timingCategory: 'deductible_temporary', confidenceScore: '0.90', aiExplanation: 'Bad debt reserve is booked before it becomes tax-deductible' } },
      { externalId: '4000', accountNumber: '4000', name: 'Sales revenue', type: 'Income', detailType: 'Income', balance: '-800000', mapping: { taxAccountType: 'NODIFF_REVENUE', bookTreatment: 'no_diff', confidenceScore: '0.98', aiExplanation: 'Revenue — recognised the same for book and tax' } },
      { externalId: '5000', accountNumber: '5000', name: 'Cost of sales — materials', type: 'Expense', detailType: 'COGS', balance: '250000', mapping: { taxAccountType: 'NODIFF_OTHER', bookTreatment: 'no_diff', confidenceScore: '0.95', aiExplanation: 'Materials — deductible in the same period' } },
      { externalId: '6000', accountNumber: '6000', name: 'Salaries and wages', type: 'Expense', detailType: 'Expense', balance: '200000', mapping: { taxAccountType: 'NODIFF_SALARIES', bookTreatment: 'no_diff', confidenceScore: '0.95', aiExplanation: 'Salaries — deductible in the same period' } },
      { externalId: '6100', accountNumber: '6100', name: 'Factory rent', type: 'Expense', detailType: 'Expense', balance: '120000', mapping: { taxAccountType: 'NODIFF_RENT', bookTreatment: 'no_diff', confidenceScore: '0.95', aiExplanation: 'Rent — deductible in the same period' } },
      { externalId: '6200', accountNumber: '6200', name: 'Utilities', type: 'Expense', detailType: 'Expense', balance: '30000', mapping: { taxAccountType: 'NODIFF_OTHER', bookTreatment: 'no_diff', confidenceScore: '0.65', aiExplanation: 'Utilities — low confidence, please confirm no capital element' } },
      { externalId: '6300', accountNumber: '6300', name: 'Client entertaining', type: 'Expense', detailType: 'Expense', balance: '15000', mapping: { taxAccountType: 'PERM_OTHER', bookTreatment: 'permanent', confidenceScore: '0.92', aiExplanation: 'Entertaining is non-deductible for tax' } },
      { externalId: '6400', accountNumber: '6400', name: 'HMRC penalties', type: 'Expense', detailType: 'Expense', balance: '10000', mapping: { taxAccountType: 'PERM_OTHER', bookTreatment: 'permanent', confidenceScore: '0.92', aiExplanation: 'Penalties are non-deductible for tax' } },
      {
        externalId: '7000', accountNumber: '7000', name: 'Software subscriptions', type: 'Expense', detailType: 'Expense', balance: '25000', mapping: null,
        proposal: { targetTaxClassification: 'NODIFF_OTHER', bookTreatment: 'no_diff', confidenceScore: '0.6200', reason: 'SaaS subscriptions look deductible; confirm no capitalised implementation costs before approving.' },
      },
      { externalId: '7100', accountNumber: '7100', name: 'Freight and carriage', type: 'Expense', detailType: 'Expense', balance: '5000', mapping: null },
    ],
  },

  'biotech-rd-loss': {
    id: 'biotech-rd-loss',
    entityExternalId: 'BIOTECH-INN',
    entityName: 'BioTech Innovations Ltd',
    narrative:
      'VC-backed R&D company with a £435k trading loss. A loss alone creates no DTA: only evidenced reversing timing differences (£55k — R&D capitalisation timing and warranty utilisation) recognise a deferred tax asset under FRS 102 Section 29, and the reviewer must still confirm probable recovery. A £60k RDEC-style credit is prepared as a supported amount for the CT600.',
    highlights: [
      'Nil current-year corporation tax (loss-making)',
      'DTA £13,750 at 25% on £55k of reversing deductible timing differences — not on the headline loss',
      'RDEC-style £60k supported credit carried (claimed via CT600, not auto-computed)',
    ],
    expectedOutcome:
      'Taxable profits £0 → CT charge £0. DTA £13,750 recognised (probable recovery for reviewer to confirm). RDEC-style credit £60,000 prepared as a supported amount.',
    period: SCENARIO_PERIOD,
    periodEnd: SCENARIO_PERIOD_END,
    fiscalYear: 2026,
    supportedRdecCredit: '60000',
    accounts: [
      { externalId: '2000', accountNumber: '2000', name: 'Warranty provision', type: 'Expense', detailType: 'Expense', balance: '50000', mapping: { taxAccountType: 'TEMP_WARRANTY_RESERVE', bookTreatment: 'temporary', timingCategory: 'deductible_temporary', confidenceScore: '0.90', aiExplanation: 'Warranty provision deductible only when utilised' } },
      { externalId: '3000', accountNumber: '3000', name: 'Venture loan', type: 'Liability', detailType: 'LongTermDebt', balance: '-435000', mapping: { taxAccountType: 'NODIFF_OTHER', bookTreatment: 'no_diff', confidenceScore: '0.95', aiExplanation: 'Loan principal — no book-tax difference' } },
      { externalId: '4000', accountNumber: '4000', name: 'Contract income', type: 'Income', detailType: 'Income', balance: '-400000', mapping: { taxAccountType: 'NODIFF_REVENUE', bookTreatment: 'no_diff', confidenceScore: '0.98', aiExplanation: 'Revenue — recognised the same for book and tax' } },
      { externalId: '6000', accountNumber: '6000', name: 'Salaries — scientists', type: 'Expense', detailType: 'Expense', balance: '350000', mapping: { taxAccountType: 'NODIFF_SALARIES', bookTreatment: 'no_diff', confidenceScore: '0.95', aiExplanation: 'Salaries — deductible in the same period' } },
      { externalId: '6100', accountNumber: '6100', name: 'R&D consumables', type: 'Expense', detailType: 'Expense', balance: '300000', mapping: { taxAccountType: 'TEMP_TIMING_DIFFERENCE', bookTreatment: 'temporary', timingCategory: 'deductible_temporary', confidenceScore: '0.88', aiExplanation: 'R&D timing: capitalised for tax vs expensed for book; relief claimed separately via RDEC' } },
      { externalId: '6200', accountNumber: '6200', name: 'Laboratory rent', type: 'Expense', detailType: 'Expense', balance: '80000', mapping: { taxAccountType: 'NODIFF_RENT', bookTreatment: 'no_diff', confidenceScore: '0.95', aiExplanation: 'Rent — deductible in the same period' } },
      { externalId: '6300', accountNumber: '6300', name: 'Utilities', type: 'Expense', detailType: 'Expense', balance: '20000', mapping: { taxAccountType: 'NODIFF_OTHER', bookTreatment: 'no_diff', confidenceScore: '0.66', aiExplanation: 'Utilities — low confidence, please confirm no capital element' } },
      { externalId: '6400', accountNumber: '6400', name: 'Entertaining', type: 'Expense', detailType: 'Expense', balance: '5000', mapping: { taxAccountType: 'PERM_OTHER', bookTreatment: 'permanent', confidenceScore: '0.92', aiExplanation: 'Entertaining is non-deductible for tax' } },
      {
        externalId: '7000', accountNumber: '7000', name: 'Patent agent fees', type: 'Expense', detailType: 'Expense', balance: '18000', mapping: null,
        proposal: { targetTaxClassification: 'NODIFF_OTHER', bookTreatment: 'no_diff', confidenceScore: '0.6400', reason: 'Patent fees look revenue-deductible; confirm none were capitalised as IP before approving.' },
      },
      { externalId: '7100', accountNumber: '7100', name: 'Clinical trial costs', type: 'Expense', detailType: 'Expense', balance: '12000', mapping: null },
    ],
  },

  'cotswold-capex': {
    id: 'cotswold-capex',
    entityExternalId: 'COTSWOLD-LOG',
    entityName: 'Cotswold Logistics Ltd',
    narrative:
      'Asset-heavy haulier: £520k of fixed-asset charges relieved through CAA 2001 pools (main-pool WDA 18% by default) against straight-line book depreciation. One asset register line ships without dates to demonstrate the no-metadata review item.',
    highlights: [
      'Book-vs-tax timing differences via the UK pool-rate path (£93,600)',
      'DTL £23,400 at 25% under FRS 102 Section 29',
      'Missing placed-in-service date raises a review item instead of guessing relief',
    ],
    expectedOutcome:
      'Taxable profits £305,000 → CT charge £76,250 at the 25% main rate. DTL £23,400 on £93,600 of capital-allowance timing differences.',
    period: SCENARIO_PERIOD,
    periodEnd: SCENARIO_PERIOD_END,
    fiscalYear: 2026,
    accounts: [
      { externalId: '1010', accountNumber: '1010', name: 'Cash at bank', type: 'Asset', detailType: 'Bank', balance: '285000', mapping: { taxAccountType: 'NODIFF_OTHER', bookTreatment: 'no_diff', confidenceScore: '0.95', aiExplanation: 'Cash — no book-tax difference' } },
      { externalId: '1500', accountNumber: '1500', name: 'HGV fleet — book depreciation', type: 'Expense', detailType: 'FixedAsset', balance: '400000', placedInServiceDate: '2025-04-15', mapping: { taxAccountType: 'TEMP_FIXED_ASSET_ALLOWANCE', bookTreatment: 'temporary', timingCategory: 'taxable_temporary', confidenceScore: '0.90', aiExplanation: 'Fleet depreciation differs from capital allowances — timing difference' } },
      { externalId: '1510', accountNumber: '1510', name: 'Warehouse racking', type: 'Expense', detailType: 'FixedAsset', balance: '120000', mapping: { taxAccountType: 'TEMP_FIXED_ASSET_ALLOWANCE', bookTreatment: 'temporary', timingCategory: 'taxable_temporary', confidenceScore: '0.90', aiExplanation: 'Racking differs from capital allowances — timing difference; dates required' } },
      { externalId: '4000', accountNumber: '4000', name: 'Freight revenue', type: 'Income', detailType: 'Income', balance: '-2000000', mapping: { taxAccountType: 'NODIFF_REVENUE', bookTreatment: 'no_diff', confidenceScore: '0.98', aiExplanation: 'Revenue — recognised the same for book and tax' } },
      { externalId: '5000', accountNumber: '5000', name: 'Driver wages', type: 'Expense', detailType: 'Expense', balance: '800000', mapping: { taxAccountType: 'NODIFF_SALARIES', bookTreatment: 'no_diff', confidenceScore: '0.95', aiExplanation: 'Salaries — deductible in the same period' } },
      { externalId: '5100', accountNumber: '5100', name: 'Fuel and tolls', type: 'Expense', detailType: 'Expense', balance: '250000', mapping: { taxAccountType: 'NODIFF_OTHER', bookTreatment: 'no_diff', confidenceScore: '0.95', aiExplanation: 'Fuel — deductible in the same period' } },
      { externalId: '5200', accountNumber: '5200', name: 'Depot rent', type: 'Expense', detailType: 'Expense', balance: '100000', mapping: { taxAccountType: 'NODIFF_RENT', bookTreatment: 'no_diff', confidenceScore: '0.95', aiExplanation: 'Rent — deductible in the same period' } },
      { externalId: '5300', accountNumber: '5300', name: 'Client entertaining', type: 'Expense', detailType: 'Expense', balance: '20000', mapping: { taxAccountType: 'PERM_OTHER', bookTreatment: 'permanent', confidenceScore: '0.92', aiExplanation: 'Entertaining is non-deductible for tax' } },
      {
        externalId: '7000', accountNumber: '7000', name: 'Telematics subscriptions', type: 'Expense', detailType: 'Expense', balance: '16000', mapping: null,
        proposal: { targetTaxClassification: 'NODIFF_OTHER', bookTreatment: 'no_diff', confidenceScore: '0.6800', reason: 'Telematics SaaS looks deductible; confirm contract term before approving.' },
      },
      { externalId: '7100', accountNumber: '7100', name: 'Pallet pooling charges', type: 'Expense', detailType: 'Expense', balance: '9000', mapping: null },
    ],
  },
};

export const SCENARIO_IDS = Object.keys(SCENARIOS) as DemoScenario['id'][];

export function isScenarioId(value: unknown): value is DemoScenario['id'] {
  return typeof value === 'string' && (Object.keys(SCENARIOS) as string[]).includes(value);
}
