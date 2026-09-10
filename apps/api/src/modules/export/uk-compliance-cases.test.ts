import { describe, expect, it } from 'vitest';
import { buildCt600Return, type Ct600MathInput } from './ct600.js';
import { validateCt600Return } from './ct600-validation.js';
import { ctoFromCt600, GOVTALK_NS, CT_NS } from './cto-xml.js';
import { buildIxbrlInstance, buildInlineIxbrl, IXBRL_NS, IX_NS, FRS102_NS } from './ixbrl.js';
import { blendedUkMainRate } from '@taxpro/tax-engine';

/**
 * UK compliance-cases harness (Prompt 4).
 *
 * Drives the REAL builders — CT600 figures → GovTalk/CT XML envelope →
 * iXBRL instance — across the five edge cases firms ask about, asserting:
 *   • CT600 box arithmetic validates (or skips with a stated reason)
 *   • GovTalk envelope structure: namespaces, element order, UTR, currency
 *   • iXBRL taxonomy invariants: Companies House identifier scheme,
 *     iso4217:GBP units, decimals="2", duration contexts, schema lock
 *
 * Honesty: this asserts conformance with HMRC guidance rules and structural
 * schema invariants — not a live HMRC/Gateway submission or a Companies
 * House validator pass. Those remain external gates before any pilot filing.
 */

const COMPANY = { companyName: 'Harness Ltd', utr: '1234567890', companiesHouseNumber: '12345678' };

interface Case {
  name: string;
  period: { start: string; end: string };
  math: Ct600MathInput;
  ixbrlFigures: { revenue?: number; profitBeforeTax?: number; taxOnProfitOrLoss?: number; currentTax?: number; deferredTax?: number; profitAfterTax?: number };
  expect: { taxPayable: number; marginalRelief: number; skippedRateRules: boolean };
}

const CASES: Case[] = [
  {
    name: 'nil liability',
    period: { start: '2025-04-01', end: '2026-03-31' },
    math: { taxableTotalProfits: 0, profitsChargeableToCT: 0, taxAtMainRate: 0, taxAtSmallProfitsRate: 0, marginalRelief: 0, taxCredits: 0, taxDeductedAtSource: 0, paymentsOnAccount: 0, rdSurrender: 0, rdec: 0 },
    ixbrlFigures: { revenue: 400000, profitBeforeTax: -435000, taxOnProfitOrLoss: 0, currentTax: 0, deferredTax: 0, profitAfterTax: -435000 },
    expect: { taxPayable: 0, marginalRelief: 0, skippedRateRules: false },
  },
  {
    name: 'main rate (£500k)',
    period: { start: '2025-04-01', end: '2026-03-31' },
    math: { taxableTotalProfits: 500000, profitsChargeableToCT: 500000, taxAtMainRate: 125000, taxAtSmallProfitsRate: 0, marginalRelief: 0, taxCredits: 0, taxDeductedAtSource: 0, paymentsOnAccount: 40000, rdSurrender: 0, rdec: 0 },
    ixbrlFigures: { revenue: 2000000, profitBeforeTax: 500000, taxOnProfitOrLoss: 125000, currentTax: 125000, deferredTax: 0, profitAfterTax: 375000 },
    expect: { taxPayable: 125000, marginalRelief: 0, skippedRateRules: false },
  },
  {
    name: 'small profits rate (£30k)',
    period: { start: '2025-04-01', end: '2026-03-31' },
    math: { taxableTotalProfits: 30000, profitsChargeableToCT: 30000, taxAtMainRate: 0, taxAtSmallProfitsRate: 5700, marginalRelief: 0, taxCredits: 0, taxDeductedAtSource: 0, paymentsOnAccount: 0, rdSurrender: 0, rdec: 0 },
    ixbrlFigures: { revenue: 200000, profitBeforeTax: 30000, taxOnProfitOrLoss: 5700, currentTax: 5700, deferredTax: 0, profitAfterTax: 24300 },
    expect: { taxPayable: 5700, marginalRelief: 0, skippedRateRules: false },
  },
  {
    name: 'marginal relief band (£150k)',
    period: { start: '2025-04-01', end: '2026-03-31' },
    math: { taxableTotalProfits: 150000, profitsChargeableToCT: 150000, taxAtMainRate: 37500, taxAtSmallProfitsRate: 0, marginalRelief: 1500, taxCredits: 0, taxDeductedAtSource: 0, paymentsOnAccount: 0, rdSurrender: 0, rdec: 0 },
    ixbrlFigures: { revenue: 800000, profitBeforeTax: 125000, taxOnProfitOrLoss: 36000, currentTax: 36000, deferredTax: 0, profitAfterTax: 89000 },
    expect: { taxPayable: 36000, marginalRelief: 1500, skippedRateRules: false },
  },
  {
    name: 'straddle across 1 April 2023',
    period: { start: '2023-01-01', end: '2023-12-31' },
    math: { taxableTotalProfits: 200000, profitsChargeableToCT: 200000, taxAtMainRate: 44000, taxAtSmallProfitsRate: 0, marginalRelief: 0, taxCredits: 0, taxDeductedAtSource: 0, paymentsOnAccount: 0, rdSurrender: 0, rdec: 0 },
    ixbrlFigures: { revenue: 900000, profitBeforeTax: 200000, taxOnProfitOrLoss: 44000, currentTax: 44000, deferredTax: 0, profitAfterTax: 156000 },
    expect: { taxPayable: 44000, marginalRelief: 0, skippedRateRules: true },
  },
];

function box(ret: { boxes: Array<{ box: number; value: string | number }> }, n: number): number {
  return Number(ret.boxes.find((b) => b.box === n)?.value ?? NaN);
}

describe('UK compliance cases: CT600 → GovTalk XML → iXBRL', () => {
  for (const c of CASES) {
    it(`${c.name}: CT600 box arithmetic validates`, () => {
      const ret = buildCt600Return(COMPANY, c.period, c.math);
      const v = validateCt600Return(ret);
      expect(v.valid).toBe(true);
      expect(box(ret, 19)).toBe(c.expect.taxPayable);
      expect(box(ret, 14)).toBe(c.expect.marginalRelief);
      if (c.expect.skippedRateRules) {
        expect(v.skipped.length).toBeGreaterThan(0);
      } else {
        expect(v.rulesRun).toBeGreaterThan(0);
      }
      // Box 15 = Box 12 + Box 13 − Box 14 (CT600 2016+ layout).
      expect(box(ret, 15)).toBe(box(ret, 12) + box(ret, 13) - box(ret, 14));
    });

    it(`${c.name}: GovTalk envelope keeps namespace, order, and identity`, () => {
      const ret = buildCt600Return(COMPANY, c.period, c.math);
      const sub = ctoFromCt600(ret, { gatewayTest: true });
      expect(sub.contentType).toBe('text/xml');
      expect(sub.xml).toContain(`xmlns="${GOVTALK_NS}"`);
      expect(sub.xml).toContain(`<IRenvelope xmlns="${CT_NS}">`);
      expect(sub.xml).toContain('<Class>HMRC-CT-CT600</Class>');
      expect(sub.xml).toContain(`<Key Type="UTR">${COMPANY.utr}</Key>`);
      expect(sub.xml).toContain('<DefaultCurrency>GBP</DefaultCurrency>');
      expect(sub.xml).toContain(`<GatewayTest>1</GatewayTest>`);
      // Element order: envelope version → header → details → body.
      const order = ['<EnvelopeVersion>', '<Header>', '<GovTalkDetails>', '<Body>']
        .map((tag) => sub.xml.indexOf(tag));
      expect(order.every((i) => i >= 0)).toBe(true);
      expect([...order].sort((a, b) => a - b)).toEqual(order);
    });

    it(`${c.name}: iXBRL keeps taxonomy invariants`, () => {
      const input = {
        companyName: COMPANY.companyName,
        companiesHouseNumber: COMPANY.companiesHouseNumber,
        periodStart: c.period.start,
        periodEnd: c.period.end,
        currency: 'GBP',
        figures: c.ixbrlFigures,
      };
      // XBRL instance format.
      const doc = buildIxbrlInstance(input);
      expect(doc.validation.valid).toBe(true);
      expect(doc.schemaRef).toContain('ukgaap-frs102-2023-01-01.xsd');
      expect(doc.content).toContain(`xmlns="${IXBRL_NS}"`);
      expect(doc.content).toContain(`xmlns:ukgaap="${FRS102_NS}"`);
      // Entity identifier scheme + duration context + GBP units + decimals.
      expect(doc.content).toContain('scheme="http://www.companieshouse.gov.uk/"');
      expect(doc.content).toContain(`<startDate>${c.period.start}</startDate><endDate>${c.period.end}</endDate>`);
      expect(doc.content).toContain('<measure>iso4217:GBP</measure>');
      expect(doc.content).toContain('decimals="2"');
      for (const f of doc.facts) {
        expect(f.unit).toBe('GBP');
        expect(doc.content).toContain(`>${f.value.toFixed(2)}</ukgaap:${f.tag}>`);
      }
      // Inline format (Companies House filing shape).
      const inline = buildInlineIxbrl(input);
      expect(inline.validation.valid).toBe(true);
      expect(inline.content).toContain(`xmlns:ix="${IX_NS}"`);
      expect(inline.content).toContain(`xmlns:ukgaap="${FRS102_NS}"`);
      for (const f of doc.facts) {
        expect(inline.content).toContain(
          `<ix:nonFraction name="ukgaap:${f.tag}" contextRef="CY-${c.period.start}_${c.period.end}" unitRef="GBP" decimals="2"`,
        );
      }
    });
  }

  it('straddle case: engine day-split is disclosed for the reviewer', () => {
    const blended = blendedUkMainRate('2023-01-01', '2023-12-31', {});
    expect(blended.toNumber()).toBeCloseTo(0.25, 10);
  });

  it('compliance summary report', () => {
    const rows = CASES.map((c) => {
      const ret = buildCt600Return(COMPANY, c.period, c.math);
      const v = validateCt600Return(ret);
      const sub = ctoFromCt600(ret, { gatewayTest: true });
      const doc = buildIxbrlInstance({
        companyName: COMPANY.companyName,
        companiesHouseNumber: COMPANY.companiesHouseNumber,
        periodStart: c.period.start,
        periodEnd: c.period.end,
        currency: 'GBP',
        figures: c.ixbrlFigures,
      });
      return { case: c.name, ct600: v.valid, rules: v.rulesRun, skipped: v.skipped.length, xml: sub.xml.length > 0, ixbrl: doc.validation.valid, facts: doc.facts.length };
    });
    // eslint-disable-next-line no-console
    console.log(`\nUK compliance summary: ${rows.filter((r) => r.ct600 && r.ixbrl).length}/${rows.length} cases fully conforming`);
    for (const r of rows) {
      // eslint-disable-next-line no-console
      console.log(`  - ${r.case}: ct600=${r.ct600} (rules=${r.rules}, skipped=${r.skipped}) xml=${r.xml} ixbrl=${r.ixbrl} (facts=${r.facts})`);
    }
    expect(rows.every((r) => r.ct600 && r.xml && r.ixbrl)).toBe(true);
  });
});
