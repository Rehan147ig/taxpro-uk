/**
 * Statutory export validators — pure, zero-dependency harness.
 *
 * Moved verbatim from apps/api (modules/export/ct600-validation.ts and
 * ixbrl-validation.ts) so the deterministic engine package — and any
 * third-party consumer — can validate generated returns without spinning up
 * the backend. No XML parser, no native binaries: standard regex and string
 * inspection only, so this builds instantly in browsers and edge runtimes.
 * Exact math via integer pennies (no floating-point drift).
 * One deliberate strictness addition over the moved logic: monetary facts
 * must resolve to an iso4217:GBP unit (the old code only checked that the
 * unit resolves at all).
 *
 * Rule basis (CT600):
 * - Marginal relief: CTA 2010 s.18D / HMRC CTM03925 — MR = F × (U − A) × (N ÷ A);
 *   for the returns this app produces A = N (no exempt distributions in the model),
 *   so MR = F × (U − A) with F = 3/200 and U = £250,000 (FY2023+).
 * - Small profits rate 19% on profits ≤ £50,000; main rate 25% on profits ≥ £250,000
 *   (FY2023+). FY2022 and earlier: flat 19% (HMRC CTM03905 / CTM03910).
 * - Box arithmetic: CT600 (2016+) box layout — Box 15 = Box 12 + Box 13 − Box 14,
 *   Box 19 = Box 15 − Box 16 − Box 17, Box 22 = Box 19 − Box 20.
 *
 * Honesty: this validates conformance with HMRC guidance rules, not an HMRC
 * submission. Periods straddling 1 April 2023 (or ending after 31 March 2027)
 * cannot be rate-checked from the return alone and are skipped with a reason.
 * The iXBRL half is a structural/well-formedness conformance check, not XSD
 * validation against the taxonomy itself.
 */

// ── CT600 ────────────────────────────────────────────────────────────────────

export interface Ct600ValidationBox {
  box: number;
  value: string | number;
}

export interface Ct600ValidationInput {
  company: { companiesHouseNumber?: string };
  boxes: Ct600ValidationBox[];
}

export interface Ct600Violation {
  ruleId: string;
  message: string;
  box?: number;
}

export interface Ct600ValidationResult {
  valid: boolean;
  rulesRun: number;
  violations: Ct600Violation[];
  skipped: Array<{ ruleId: string; reason: string }>;
  basis: string;
}

const CT600_BASIS =
  'HMRC CT600 guidance: box layout CT600 (2016+); marginal relief per CTA 2010 s.18D / CTM03925 ' +
  '(F = 3/200, U = £250,000, N = A); small profits rate 19% and main rate 25% with limits ' +
  '£50k/£250k per CTM03905/CTM03910 (FY2023+); flat 19% for FY2022 and earlier.';

interface Ct600Rule {
  ruleId: string;
  skip?: (r: Ct600ValidationInput) => string | undefined;
  check: (r: Ct600ValidationInput) => Ct600Violation | undefined;
}

const boxOf = (r: Ct600ValidationInput, n: number): number => Number(r.boxes.find(b => b.box === n)?.value ?? 0);
const boxStr = (r: Ct600ValidationInput, n: number): string => String(r.boxes.find(b => b.box === n)?.value ?? '');
const penny = (n: number): number => Math.round(n * 100);
const near = (a: number, b: number, tol = 1): boolean => Math.abs(a - b) <= tol;

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
const isIso = (s: string): boolean => ISO_RE.test(s) && !Number.isNaN(Date.parse(s));

const LOWER_P = 5_000_000; // £50,000 lower limit, pennies
const UPPER_P = 25_000_000; // £250,000 upper limit, pennies
const MR_FRACTION = 0.015; // 3/200 per CTA 2010 s.18D / CTM03925 (FY2023+)
const RATE_MAIN = 0.25;
const RATE_SMALL = 0.19;

type Ct600Regime = 'flat2022' | 'current' | 'straddle' | 'future' | 'unknown';

function regimeOf(r: Ct600ValidationInput): Ct600Regime {
  const start = boxStr(r, 3);
  const end = boxStr(r, 4);
  if (!isIso(start) || !isIso(end)) return 'unknown';
  if (end < '2023-04-01') return 'flat2022';
  if (start >= '2023-04-01' && end < '2027-04-01') return 'current';
  if (start < '2023-04-01') return 'straddle';
  return 'future';
}

const REGIME_SKIP_REASON: Record<Exclude<Ct600Regime, 'current' | 'flat2022'>, string> = {
  straddle: 'period straddles 1 April 2023 — rate apportionment not verifiable from the return alone',
  future: 'period ends after 31 March 2027 — FY2028+ rates not locked',
  unknown: 'period dates not ISO',
};

function regimeSkip(...allowed: Ct600Regime[]): (r: Ct600ValidationInput) => string | undefined {
  return (r) => {
    const regime = regimeOf(r);
    if (allowed.includes(regime)) return undefined;
    if (regime === 'current' || regime === 'flat2022') {
      return `rule only applies in the ${regime === 'current' ? 'FY2023+ rate regime' : 'flat 19% (FY2022 and earlier) regime'} — this return uses the ${regime === 'current' ? 'flat 19%' : 'FY2023+'} regime`;
    }
    return REGIME_SKIP_REASON[regime];
  };
}

const ct600Rules: Ct600Rule[] = [
  {
    ruleId: 'UTR_FORMAT',
    check: (r) =>
      /^\d{10}$/.test(boxStr(r, 1))
        ? undefined
        : { ruleId: 'UTR_FORMAT', message: `UTR '${boxStr(r, 1)}' must be exactly 10 digits (HMRC CT600 Box 1).`, box: 1 },
  },
  {
    ruleId: 'COMPANY_NUMBER_FORMAT',
    check: (r) => {
      const ch = r.company.companiesHouseNumber;
      if (ch === undefined || ch === '') return undefined;
      return /^(?:[A-Z]{2}\d{6}|\d{8})$/.test(ch)
        ? undefined
        : { ruleId: 'COMPANY_NUMBER_FORMAT', message: `Companies House number '${ch}' must be 2 letters + 6 digits (e.g. SC123456) or 8 digits.` };
    },
  },
  {
    ruleId: 'PERIOD_ISO',
    check: (r) =>
      isIso(boxStr(r, 3)) && isIso(boxStr(r, 4))
        ? undefined
        : { ruleId: 'PERIOD_ISO', message: `Accounting period must be ISO dates (YYYY-MM-DD): ${boxStr(r, 3)} to ${boxStr(r, 4)}.`, box: 3 },
  },
  {
    ruleId: 'PERIOD_ORDER',
    skip: (r) => (isIso(boxStr(r, 3)) && isIso(boxStr(r, 4)) ? undefined : 'period dates not ISO'),
    check: (r) =>
      boxStr(r, 3) < boxStr(r, 4)
        ? undefined
        : { ruleId: 'PERIOD_ORDER', message: `Period start ${boxStr(r, 3)} must be before period end ${boxStr(r, 4)}.`, box: 4 },
  },
  {
    ruleId: 'PERIOD_LENGTH',
    skip: (r) => (isIso(boxStr(r, 3)) && isIso(boxStr(r, 4)) ? undefined : 'period dates not ISO'),
    check: (r) => {
      const days = (Date.parse(boxStr(r, 4)) - Date.parse(boxStr(r, 3))) / 86_400_000;
      if (days < 1 || days > 549) {
        return { ruleId: 'PERIOD_LENGTH', message: `Accounting period of ${days} days must be between 1 and 549 days (18 months).`, box: 4 };
      }
      return undefined;
    },
  },
  {
    ruleId: 'BOX5_EQ_BOX10',
    check: (r) =>
      boxOf(r, 5) === boxOf(r, 10)
        ? undefined
        : { ruleId: 'BOX5_EQ_BOX10', message: `Box 5 (${boxOf(r, 5)}) must equal Box 10 (${boxOf(r, 10)}) — profits chargeable to CT are the taxable total profits for the modelled company.`, box: 5 },
  },
  {
    ruleId: 'BOX11_EQ_BOX5',
    check: (r) =>
      boxOf(r, 11) === boxOf(r, 5)
        ? undefined
        : { ruleId: 'BOX11_EQ_BOX5', message: `Box 11 (${boxOf(r, 11)}) must equal Box 5 (${boxOf(r, 5)}).`, box: 11 },
  },
  {
    ruleId: 'BOX15_IDENTITY',
    check: (r) => {
      const expected = Math.max(0, penny(boxOf(r, 12)) + penny(boxOf(r, 13)) - penny(boxOf(r, 14)));
      return near(penny(boxOf(r, 15)), expected)
        ? undefined
        : { ruleId: 'BOX15_IDENTITY', message: `Box 15 must equal max(0, Box 12 + Box 13 − Box 14) = ${expected / 100}; got ${boxOf(r, 15)}.`, box: 15 };
    },
  },
  {
    ruleId: 'BOX19_IDENTITY',
    check: (r) => {
      const expected = Math.max(0, penny(boxOf(r, 15)) - penny(boxOf(r, 16)) - penny(boxOf(r, 17)));
      return near(penny(boxOf(r, 19)), expected)
        ? undefined
        : { ruleId: 'BOX19_IDENTITY', message: `Box 19 must equal max(0, Box 15 − Box 16 − Box 17) = ${expected / 100}; got ${boxOf(r, 19)}.`, box: 19 };
    },
  },
  {
    ruleId: 'BOX22_IDENTITY',
    check: (r) => {
      const expected = Math.max(0, penny(boxOf(r, 19)) - penny(boxOf(r, 20)));
      return near(penny(boxOf(r, 22)), expected)
        ? undefined
        : { ruleId: 'BOX22_IDENTITY', message: `Box 22 must equal max(0, Box 19 − Box 20) = ${expected / 100}; got ${boxOf(r, 22)}.`, box: 22 };
    },
  },
  {
    ruleId: 'NON_NEGATIVE',
    check: (r) => {
      const amountBoxes = [5, 10, 11, 12, 13, 14, 15, 16, 17, 19, 20, 22, 27, 28];
      for (const n of amountBoxes) {
        if (boxOf(r, n) < 0) {
          return { ruleId: 'NON_NEGATIVE', message: `Box ${n} must not be negative; got ${boxOf(r, n)}.`, box: n };
        }
      }
      return undefined;
    },
  },
  {
    ruleId: 'BAND_SELECTION',
    check: (r) =>
      boxOf(r, 12) > 0 && boxOf(r, 13) > 0
        ? { ruleId: 'BAND_SELECTION', message: 'Both Box 12 (main rate) and Box 13 (small profits rate) are populated — a single-band company must use exactly one.', box: 12 }
        : undefined,
  },
  {
    ruleId: 'SMALL_RATE_ALIGNMENT',
    skip: regimeSkip('current'),
    check: (r) => {
      const a = penny(boxOf(r, 5));
      if (a > LOWER_P) return undefined;
      const expected = Math.round(a * RATE_SMALL);
      const mismatches: string[] = [];
      if (!near(penny(boxOf(r, 13)), expected)) mismatches.push(`Box 13 must be ${expected / 100} (${boxOf(r, 5)} × 19%)`);
      if (boxOf(r, 12) !== 0) mismatches.push(`Box 12 must be 0 below the £50,000 lower limit (got ${boxOf(r, 12)})`);
      if (boxOf(r, 14) !== 0) mismatches.push(`Box 14 must be 0 below the £50,000 lower limit (got ${boxOf(r, 14)})`);
      return mismatches.length
        ? { ruleId: 'SMALL_RATE_ALIGNMENT', message: mismatches.join('; '), box: 13 }
        : undefined;
    },
  },
  {
    ruleId: 'MAIN_RATE_ALIGNMENT',
    skip: regimeSkip('current'),
    check: (r) => {
      const a = penny(boxOf(r, 5));
      if (a < UPPER_P) return undefined;
      const expected = Math.round(a * RATE_MAIN);
      const mismatches: string[] = [];
      if (!near(penny(boxOf(r, 12)), expected)) mismatches.push(`Box 12 must be ${expected / 100} (${boxOf(r, 5)} × 25%)`);
      if (boxOf(r, 13) !== 0) mismatches.push(`Box 13 must be 0 above the £250,000 upper limit (got ${boxOf(r, 13)})`);
      if (boxOf(r, 14) !== 0) mismatches.push(`Box 14 must be 0 above the £250,000 upper limit (got ${boxOf(r, 14)})`);
      return mismatches.length
        ? { ruleId: 'MAIN_RATE_ALIGNMENT', message: mismatches.join('; '), box: 12 }
        : undefined;
    },
  },
  {
    ruleId: 'MARGINAL_RELIEF_ALIGNMENT',
    skip: regimeSkip('current'),
    check: (r) => {
      const a = penny(boxOf(r, 5));
      if (a <= LOWER_P || a >= UPPER_P) return undefined;
      const mainCharge = Math.round(a * RATE_MAIN);
      const relief = Math.round((UPPER_P - a) * MR_FRACTION); // F × (U − A) with N = A
      const mismatches: string[] = [];
      if (!near(penny(boxOf(r, 12)), mainCharge)) mismatches.push(`Box 12 must be ${mainCharge / 100} (${boxOf(r, 5)} × 25%)`);
      if (!near(penny(boxOf(r, 14)), relief)) mismatches.push(`Box 14 marginal relief must be ${relief / 100} (3/200 × (£250,000 − ${boxOf(r, 5)}))`);
      if (boxOf(r, 13) !== 0) mismatches.push(`Box 13 must be 0 in the marginal relief band (got ${boxOf(r, 13)})`);
      return mismatches.length
        ? { ruleId: 'MARGINAL_RELIEF_ALIGNMENT', message: mismatches.join('; '), box: 14 }
        : undefined;
    },
  },
  {
    ruleId: 'FLAT_RATE_ALIGNMENT',
    skip: regimeSkip('flat2022'),
    check: (r) => {
      const a = penny(boxOf(r, 5));
      const expected = Math.round(a * RATE_SMALL);
      const mismatches: string[] = [];
      if (!near(penny(boxOf(r, 12)), expected)) mismatches.push(`Box 12 must be ${expected / 100} (${boxOf(r, 5)} × 19% flat rate, FY2022 or earlier)`);
      if (boxOf(r, 13) !== 0) mismatches.push(`Box 13 must be 0 before FY2023 (got ${boxOf(r, 13)})`);
      if (boxOf(r, 14) !== 0) mismatches.push(`Box 14 must be 0 before FY2023 (got ${boxOf(r, 14)})`);
      return mismatches.length
        ? { ruleId: 'FLAT_RATE_ALIGNMENT', message: mismatches.join('; '), box: 12 }
        : undefined;
    },
  },
];

export function validateCt600Rules(input: Ct600ValidationInput): Ct600ValidationResult {
  const violations: Ct600Violation[] = [];
  const skipped: Array<{ ruleId: string; reason: string }> = [];
  let rulesRun = 0;

  for (const rule of ct600Rules) {
    const skipReason = rule.skip?.(input);
    if (skipReason) {
      skipped.push({ ruleId: rule.ruleId, reason: skipReason });
      continue;
    }
    rulesRun++;
    const violation = rule.check(input);
    if (violation) violations.push(violation);
  }

  return { valid: violations.length === 0, rulesRun, violations, skipped, basis: CT600_BASIS };
}

// ── iXBRL ────────────────────────────────────────────────────────────────────

export const FRS102_SCHEMA_LOCK = 'ukgaap-frs102-2023-01-01.xsd';

export interface IxbrlValidationInput {
  format: 'instance' | 'inline';
  periodStart?: string;
  periodEnd?: string;
  facts?: Array<{ tag: string; value: number; context: string; unit: string }>;
  content: string;
  schemaRef: string;
}

export interface IxbrlValidationResult {
  valid: boolean;
  checksRun: number;
  violations: string[];
}

export interface IxbrlStructureOptions {
  format?: 'instance' | 'inline';
  periodStart?: string;
  periodEnd?: string;
  schemaRef?: string;
}

const IXBRL_ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
const ixbrlIsIso = (s: string): boolean => IXBRL_ISO_RE.test(s) && !Number.isNaN(Date.parse(s));

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Full structural validation. Period checks run only when both period dates
 * are supplied; callers that always pass them (the API forwarder) get the
 * exact historical check counts.
 */
export function validateIxbrlDocument(doc: IxbrlValidationInput): IxbrlValidationResult {
  const violations: string[] = [];
  const checksRun: string[] = [];
  const c = doc.content;
  const ok = (id: string, cond: boolean, message: string) => {
    checksRun.push(id);
    if (!cond) violations.push(message);
  };

  if (doc.format === 'instance') {
    ok('root', /^<\?xml/.test(c), 'instance document must start with an XML declaration');
    ok('root', c.includes('<xbrl xmlns="http://www.xbrl.org/2003/instance"'), 'instance root <xbrl> with the XBRL 2003 instance namespace is missing');
    ok('root', c.includes('xmlns:ukgaap="http://www.hmrc.gov.uk/ukgaap/frs102/taxonomy"'), 'ukgaap namespace declaration missing');
    ok('root', c.includes('xmlns:iso4217='), 'iso4217 namespace declaration missing');
  } else {
    ok('root', c.includes('<html'), 'inline document must have an <html> root');
    ok('root', c.includes('xmlns:ix="http://www.xbrl.org/2008/inlineXBRL"'), 'iXBRL ix namespace declaration missing');
    ok('root', c.includes('xmlns:ukgaap="http://www.hmrc.gov.uk/ukgaap/frs102/taxonomy"'), 'ukgaap namespace declaration missing');
    ok('root', c.includes('<ix:header>'), 'ix:header block missing');
  }

  ok('schemaRef', doc.schemaRef.includes(FRS102_SCHEMA_LOCK), `schemaRef must lock the ${FRS102_SCHEMA_LOCK} taxonomy version`);
  if (doc.format === 'instance') {
    ok('schemaRef', c.includes(`schemaRef="${doc.schemaRef}"`), 'instance content must declare the schemaRef matching the document metadata');
  }

  const contextIds = new Set(
    doc.format === 'instance'
      ? [...c.matchAll(/<context id="([^"]+)">/g)].map(m => m[1])
      : [...c.matchAll(/<ix:context id="([^"]+)">/g)].map(m => m[1]),
  );
  const unitIds = new Set(
    doc.format === 'instance'
      ? [...c.matchAll(/<unit id="([^"]+)">/g)].map(m => m[1])
      : [...c.matchAll(/<ix:unit id="([^"]+)">/g)].map(m => m[1]),
  );

  ok('contexts', contextIds.size > 0, 'no contexts defined');
  ok('contexts', contextIds.size === (doc.format === 'instance'
    ? [...c.matchAll(/<context id="/g)].length
    : [...c.matchAll(/<ix:context id="/g)].length), 'context ids must be unique');
  ok('units', unitIds.size > 0, 'no units defined');
  ok('units', unitIds.size === (doc.format === 'instance'
    ? [...c.matchAll(/<unit id="/g)].length
    : [...c.matchAll(/<ix:unit id="/g)].length), 'unit ids must be unique');

  const factOpenTags = doc.format === 'instance'
    ? [...c.matchAll(/<ukgaap:[A-Za-z]+\s[^>]*>/g)].map(m => m[0])
    : [...c.matchAll(/<ix:nonFraction\s[^>]*>/g)].map(m => m[0]);

  ok('facts', factOpenTags.length > 0, 'no tagged facts found in the document');
  const unitBody = (unitRef: string): string | null => {
    const pattern = doc.format === 'instance' ? 'unit' : 'ix:unit';
    const m = new RegExp(`<${pattern} id="${escapeRegExp(unitRef)}"[^>]*>([\\s\\S]*?)<\\/${pattern}>`).exec(c);
    return m ? m[1] : null;
  };
  for (const tag of factOpenTags) {
    const contextRef = /contextRef="([^"]+)"/.exec(tag)?.[1];
    const unitRef = /unitRef="([^"]+)"/.exec(tag)?.[1];
    const decimals = /decimals="([^"]+)"/.exec(tag)?.[1];
    if (!contextRef || !contextIds.has(contextRef)) {
      violations.push(`fact ${tag.slice(0, 80)} references undefined context '${contextRef}'`);
    }
    if (!unitRef || !unitIds.has(unitRef)) {
      violations.push(`fact ${tag.slice(0, 80)} references undefined unit '${unitRef}'`);
    } else {
      // UK returns are GBP-denominated: a resolving unit must still carry the
      // iso4217:GBP measure (this is the one strictness addition over the
      // moved API logic, which only checked that the unit resolves).
      const body = unitBody(unitRef);
      if (body !== null && !body.includes('iso4217:GBP')) {
        violations.push(`fact ${tag.slice(0, 80)} uses unit '${unitRef}' which is not iso4217:GBP`);
      }
    }
    if (decimals !== '2') {
      violations.push(`fact ${tag.slice(0, 80)} must declare decimals="2"`);
    }
  }

  const values = doc.format === 'instance'
    ? [...c.matchAll(/<ukgaap:[A-Za-z]+[^>]*>([^<]+)<\/ukgaap:/g)].map(m => m[1])
    : [...c.matchAll(/<ix:nonFraction[^>]*>([^<]+)<\/ix:nonFraction>/g)].map(m => m[1]);
  for (const v of values) {
    if (!/^-?\d+\.\d{2}$/.test(v.trim())) {
      violations.push(`numeric fact value '${v.trim()}' must be a finite number with 2 decimal places`);
    }
  }

  if (doc.periodStart !== undefined && doc.periodEnd !== undefined) {
    ok('dates', ixbrlIsIso(doc.periodStart) && ixbrlIsIso(doc.periodEnd), `document period must be ISO dates (YYYY-MM-DD): ${doc.periodStart} to ${doc.periodEnd}`);
    if (doc.format === 'instance') {
      const m = /<startDate>([^<]+)<\/startDate><endDate>([^<]+)<\/endDate>/.exec(c);
      ok('dates', !!m && m[1] === doc.periodStart && m[2] === doc.periodEnd,
        `context period (${m ? `${m[1]} to ${m[2]}` : 'none'}) must match the document period (${doc.periodStart} to ${doc.periodEnd})`);
    } else {
      const m = /<ix:start>([^<]+)<\/ix:start><ix:end>([^<]+)<\/ix:end>/.exec(c);
      ok('dates', !!m && m[1] === doc.periodStart && m[2] === doc.periodEnd,
        `context period (${m ? `${m[1]} to ${m[2]}` : 'none'}) must match the document period (${doc.periodStart} to ${doc.periodEnd})`);
    }
  }

  ok('entity', doc.format === 'instance'
    ? c.includes('<identifier scheme="http://www.companieshouse.gov.uk/">')
    : c.includes('<ix:identifier scheme="http://www.companieshouse.gov.uk/">'),
    'company identifier with the Companies House scheme missing');

  return { valid: violations.length === 0, checksRun: checksRun.length, violations };
}

/**
 * Standalone entry point for third-party consumers: pass raw XML, get the
 * full structural verdict. Format is auto-detected from the content
 * (`<html` → inline, otherwise instance); period checks run only when both
 * dates are supplied; schemaRef defaults to the FRS 102 taxonomy lock.
 */
export function validateIxbrlStructure(
  xmlContent: string,
  options: IxbrlStructureOptions = {},
): IxbrlValidationResult {
  const format = options.format ?? (xmlContent.includes('<html') ? 'inline' : 'instance');
  return validateIxbrlDocument({
    format,
    ...(options.periodStart !== undefined ? { periodStart: options.periodStart } : {}),
    ...(options.periodEnd !== undefined ? { periodEnd: options.periodEnd } : {}),
    content: xmlContent,
    schemaRef: options.schemaRef ?? FRS102_SCHEMA_LOCK,
  });
}
