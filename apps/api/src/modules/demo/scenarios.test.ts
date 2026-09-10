import { describe, expect, it } from 'vitest';
import Decimal from 'decimal.js';
import {
  computeBookTaxDifferences,
  createEngine,
  etrAdjustmentsForMarginalRelief,
  Jurisdiction,
} from '@taxpro/tax-engine';
import type { Account, BookTaxDifference, TaxAccountType, TaxMapping, TrialBalanceLine } from '@taxpro/tax-engine';
import { SCENARIOS, type DemoScenario } from './scenarios.js';

/**
 * Phase E scenario proof (no database): every demo trial balance is balanced
 * (Σ = 0) and calculates cleanly through the UK FRS 102 S29 engine with the
 * pinned commercial outcomes from the scenario catalogue.
 */
function toEngineInput(scenario: DemoScenario) {
  const trialBalance: TrialBalanceLine[] = scenario.accounts.map((a, i) => ({
    entityId: `demo-${scenario.id}`,
    accountId: `acct-${i}`,
    period: scenario.period,
    balance: new Decimal(a.balance),
    ...(a.placedInServiceDate ? { placedInServiceDate: a.placedInServiceDate } : {}),
  }));
  const accounts: Account[] = scenario.accounts.map((a, i) => ({
    id: `acct-${i}`,
    accountNumber: a.accountNumber,
    name: a.name,
    type: a.type,
  }));
  const mappings = new Map<string, TaxMapping>();
  scenario.accounts.forEach((a, i) => {
    if (!a.mapping) return;
    mappings.set(`acct-${i}`, {
      accountId: `acct-${i}`,
      taxAccountType: a.mapping.taxAccountType as TaxAccountType,
      bookTreatment: a.mapping.bookTreatment,
      timingCategory: a.mapping.timingCategory as TaxMapping['timingCategory'],
      confidenceScore: new Decimal(a.mapping.confidenceScore),
    });
  });
  return { trialBalance, accounts, mappings };
}

function bookIncomeOf(scenario: DemoScenario): Decimal {
  let income = new Decimal(0);
  let expense = new Decimal(0);
  for (const a of scenario.accounts) {
    if (a.type === 'Income') income = income.plus(new Decimal(a.balance).abs());
    if (a.type === 'Expense') expense = expense.plus(new Decimal(a.balance).abs());
  }
  return income.minus(expense);
}

describe('Phase E demo scenarios calculate cleanly (UK FRS 102 S29)', () => {
  const engine = createEngine(Jurisdiction.UK_FRS102_S29);

  for (const scenario of Object.values(SCENARIOS)) {
    it(`${scenario.id}: trial balance is balanced`, () => {
      const total = scenario.accounts.reduce((s, a) => s.plus(new Decimal(a.balance)), new Decimal(0));
      expect(total.toNumber()).toBe(0);
    });

    it(`${scenario.id}: timing differences are finite and deterministic`, () => {
      const { trialBalance, accounts, mappings } = toEngineInput(scenario);
      const diffs = computeBookTaxDifferences(trialBalance, accounts, mappings, scenario.period, 1, {
        jurisdiction: 'UK_FRS102_S29',
      });
      for (const d of diffs) {
        expect(d.difference.isFinite()).toBe(true);
        expect(d.taxBalance.isFinite()).toBe(true);
      }
    });
  }

  it('apex-marginal-relief: £150k taxable → £1,500 relief → £36,000 charge', () => {
    const scenario = SCENARIOS['apex-marginal-relief'];
    expect(bookIncomeOf(scenario).toNumber()).toBe(125_000);

    const { trialBalance, accounts, mappings } = toEngineInput(scenario);
    computeBookTaxDifferences(trialBalance, accounts, mappings, scenario.period, 1, {
      jurisdiction: 'UK_FRS102_S29',
    });
    // Permanent adjustments mirror the provision builder: book amounts added back.
    const permAdjustments = scenario.accounts
      .filter((a) => a.mapping?.bookTreatment === 'permanent')
      .map((a) => ({ amount: new Decimal(a.balance).abs(), label: a.name }));

    const current = engine.calculateCurrentTax({
      bookIncome: bookIncomeOf(scenario),
      permanentDifferences: permAdjustments,
      taxRate: new Decimal('0.25'),
      taxCredits: new Decimal(0),
      estimatedPayments: new Decimal(0),
      nolUtilization: new Decimal(0),
      asOfDate: scenario.period,
    });
    expect(current.taxableIncome.toNumber()).toBe(150_000);
    expect(current.marginalRelief?.toNumber()).toBe(1_500);
    expect(current.totalTaxAfterCredits.toNumber()).toBe(36_000);
    expect(current.taxPayable.toNumber()).toBe(36_000);

    const apexInput = toEngineInput(scenario);
    const apexDiffs = computeBookTaxDifferences(
      apexInput.trialBalance, apexInput.accounts, apexInput.mappings, scenario.period, 1,
      { jurisdiction: 'UK_FRS102_S29' },
    );
    const apexDeferred = engine.calculateDeferredTax(apexDiffs, {}, {}, {}, undefined, scenario.period);
    expect(apexDeferred.totalClosingDTA.toNumber()).toBe(750);

    const etr = engine.calculateETR({
      bookIncome: current.bookIncome,
      federalTaxRate: new Decimal('0.25'),
      federalTax: current.federalTax,
      stateTax: new Decimal(0),
      permanentDifferences: permAdjustments,
      taxCredits: new Decimal(0),
      otherAdjustments: etrAdjustmentsForMarginalRelief(current),
      jurisdiction: Jurisdiction.UK_FRS102_S29,
    });
    expect(etr.lines.some((l) => /marginal relief/i.test(l.description))).toBe(true);
    expect(etr.lines.some((l) => /state income taxes/i.test(l.description))).toBe(false);
  });

  it('biotech-rd-loss: nil charge with a £13,750 DTA', () => {
    const scenario = SCENARIOS['biotech-rd-loss'];
    expect(bookIncomeOf(scenario).toNumber()).toBe(-435_000);

    const current = engine.calculateCurrentTax({
      bookIncome: bookIncomeOf(scenario),
      permanentDifferences: [{ amount: new Decimal(5_000), label: 'Entertaining' }],
      taxRate: new Decimal('0.25'),
      taxCredits: new Decimal(60_000),
      estimatedPayments: new Decimal(0),
      nolUtilization: new Decimal(0),
      asOfDate: scenario.period,
    });
    expect(current.taxableIncome.toNumber()).toBe(0);
    expect(current.totalTaxAfterCredits.toNumber()).toBe(0);
    expect(current.taxPayable.toNumber()).toBe(0);

    const { trialBalance, accounts, mappings } = toEngineInput(scenario);
    const diffs = computeBookTaxDifferences(trialBalance, accounts, mappings, scenario.period, 1, {
      jurisdiction: 'UK_FRS102_S29',
    });
    const deferred = engine.calculateDeferredTax(diffs, {}, {}, {}, undefined, scenario.period);
    expect(deferred.totalClosingDTA.toNumber()).toBe(13_750);
    expect(deferred.totalClosingDTL.toNumber()).toBe(0);
  });

  it('cotswold-capex: £305k taxable → £76,250 charge with a £23,400 DTL', () => {
    const scenario = SCENARIOS['cotswold-capex'];
    expect(bookIncomeOf(scenario).toNumber()).toBe(285_000);

    const { trialBalance, accounts, mappings } = toEngineInput(scenario);
    const diffs = computeBookTaxDifferences(trialBalance, accounts, mappings, scenario.period, 1, {
      jurisdiction: 'UK_FRS102_S29',
    });
    const timingTotal = diffs
      .filter((d: BookTaxDifference) => d.diffType === 'temporary')
      .reduce((s, d) => s.plus(d.difference.abs()), new Decimal(0));
    expect(timingTotal.toNumber()).toBe(93_600);

    // The racking line ships without dates: evidence required, never guessed.
    const racking = diffs.find((d: BookTaxDifference) => d.accountId === 'acct-2');
    expect(racking?.depreciationAgeSource).toBe('no_metadata');

    const current = engine.calculateCurrentTax({
      bookIncome: bookIncomeOf(scenario),
      permanentDifferences: [{ amount: new Decimal(20_000), label: 'Entertaining' }],
      taxRate: new Decimal('0.25'),
      taxCredits: new Decimal(0),
      estimatedPayments: new Decimal(0),
      nolUtilization: new Decimal(0),
      asOfDate: scenario.period,
    });
    expect(current.taxableIncome.toNumber()).toBe(305_000);
    expect(current.marginalRelief?.toNumber() ?? 0).toBe(0);
    expect(current.totalTaxAfterCredits.toNumber()).toBe(76_250);

    const deferred = engine.calculateDeferredTax(diffs, {}, {}, {}, undefined, scenario.period);
    expect(deferred.totalClosingDTL.toNumber()).toBe(23_400);
  });
});
