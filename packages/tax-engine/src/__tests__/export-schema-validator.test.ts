import { describe, expect, it } from 'vitest';
import {
  validateCt600Rules,
  validateIxbrlStructure,
  type Ct600ValidationInput,
} from '../uk-frs102-s29/export-schema-validator.js';

function ct600(profits: number, opts: { box12?: number; box13?: number; box14?: number; utr?: string } = {}): Ct600ValidationInput {
  const box12 = opts.box12 ?? 0;
  const box13 = opts.box13 ?? 0;
  const box14 = opts.box14 ?? 0;
  const box15 = Math.max(0, box12 + box13 - box14);
  const boxes: Array<{ box: number; value: string | number }> = [
    { box: 1, value: opts.utr ?? '1234567890' },
    { box: 3, value: '2023-04-01' },
    { box: 4, value: '2024-03-31' },
    { box: 5, value: profits },
    { box: 10, value: profits },
    { box: 11, value: profits },
    { box: 12, value: box12 },
    { box: 13, value: box13 },
    { box: 14, value: box14 },
    { box: 15, value: box15 },
    { box: 16, value: 0 },
    { box: 17, value: 0 },
    { box: 19, value: box15 },
    { box: 20, value: 0 },
    { box: 22, value: box15 },
  ];
  return { company: { companiesHouseNumber: '12345678' }, boxes };
}

const INLINE_DOC = (body: string) => `<html xmlns:ix="http://www.xbrl.org/2008/inlineXBRL" xmlns:ukgaap="http://www.hmrc.gov.uk/ukgaap/frs102/taxonomy">
<ix:header><ix:context id="ctx1"><ix:start>2023-04-01</ix:start><ix:end>2024-03-31</ix:end></ix:context><ix:unit id="GBP"><ix:measure>iso4217:GBP</ix:measure></ix:unit><ix:identifier scheme="http://www.companieshouse.gov.uk/">12345678</ix:identifier></ix:header>
<body><table>${body}</table></body></html>`;

const GOOD_FACT = `<tr><td>Revenue</td><td><ix:nonFraction name="ukgaap:Revenue" contextRef="ctx1" unitRef="GBP" decimals="2">48000.00</ix:nonFraction></td></tr>`;

describe('validateCt600Rules — golden returns', () => {
  it('passes a small-profits return at 19%', () => {
    const res = validateCt600Rules(ct600(30000, { box13: 5700 }));
    expect(res.valid).toBe(true);
    expect(res.violations).toEqual([]);
  });

  it('passes a marginal-relief return with the exact 3/200 fraction in Box 14', () => {
    // (250,000 − 100,000) × 0.015 = 2,250 relief; Box 12 at 25% = 25,000.
    const res = validateCt600Rules(ct600(100000, { box12: 25000, box14: 2250 }));
    expect(res.valid).toBe(true);
    expect(res.violations).toEqual([]);
  });

  it('passes a main-rate return at 25%', () => {
    const res = validateCt600Rules(ct600(300000, { box12: 75000 }));
    expect(res.valid).toBe(true);
    expect(res.violations).toEqual([]);
  });
});

describe('validateCt600Rules — violations', () => {
  it('trips BOX15_IDENTITY on box arithmetic mismatch', () => {
    const input = ct600(30000, { box13: 5700 });
    input.boxes = input.boxes.map((b) => (b.box === 15 ? { ...b, value: 5701 } : b));
    const res = validateCt600Rules(input);
    expect(res.valid).toBe(false);
    expect(res.violations.map((v) => v.ruleId)).toContain('BOX15_IDENTITY');
  });

  it('trips UTR_FORMAT on 9-digit and alphanumeric UTRs', () => {
    for (const utr of ['123456789', '12345ABCDE']) {
      const res = validateCt600Rules(ct600(30000, { box13: 5700, utr }));
      expect(res.valid).toBe(false);
      expect(res.violations.map((v) => v.ruleId)).toContain('UTR_FORMAT');
    }
  });
});

describe('validateIxbrlStructure — standalone harness', () => {
  const opts = { periodStart: '2023-04-01', periodEnd: '2024-03-31' } as const;

  it('passes a valid inline document through every structural check', () => {
    const res = validateIxbrlStructure(INLINE_DOC(GOOD_FACT), { ...opts });
    expect(res.violations).toEqual([]);
    expect(res.valid).toBe(true);
    expect(res.checksRun).toBeGreaterThan(10);
  });

  it('trips an explicit violation when decimals="2" is missing', () => {
    const bad = GOOD_FACT.replace(' decimals="2"', '');
    const res = validateIxbrlStructure(INLINE_DOC(bad), { ...opts });
    expect(res.valid).toBe(false);
    expect(res.violations.some((v) => v.includes('decimals="2"'))).toBe(true);
  });

  it('trips an explicit violation on wrong-currency units', () => {
    const usd = INLINE_DOC(GOOD_FACT)
      .replace('<ix:unit id="GBP"><ix:measure>iso4217:GBP</ix:measure></ix:unit>', '<ix:unit id="USD"><ix:measure>iso4217:USD</ix:measure></ix:unit>')
      .replace('unitRef="GBP"', 'unitRef="USD"');
    const res = validateIxbrlStructure(usd, { ...opts });
    expect(res.valid).toBe(false);
    expect(res.violations.some((v) => v.includes('iso4217:GBP'))).toBe(true);
  });

  it('auto-detects inline vs instance format from the content', () => {
    const inline = validateIxbrlStructure(INLINE_DOC(GOOD_FACT), { ...opts });
    expect(inline.valid).toBe(true);
    const garbage = validateIxbrlStructure('not xml at all', { ...opts });
    expect(garbage.valid).toBe(false);
  });
});
