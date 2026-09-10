import React from 'react';

// Context-sensitive UK tax glossary. Native `title` tooltip: zero layout
// shift, no JS, screen-reader friendly. Dotted underline signals "defined term".

const TERMS: Record<string, { label: string; definition: string }> = {
  'marginal-relief': {
    label: 'CTA 2010 s.18D Marginal Relief',
    definition:
      'Taper between the 19% small-profits rate (£50k) and the 25% main rate (£250k). Limits divide by the number of associated companies. TaxPro shows it as an explicit ETR line.',
  },
  's29-timing': {
    label: 'FRS 102 Section 29 Timing Differences',
    definition:
      'Book vs tax carrying amounts that reverse over time (e.g. depreciation vs capital allowances). Recognise deferred tax at substantively-enacted rates; never discount (s29.17); DTAs only when recovery is probable (s29.14).',
  },
  'hmrc-bands': {
    label: 'HMRC Tax Band Alignment',
    definition:
      'Profits ≤ £50k at 19%, £50k–£250k marginal relief, above £250k at 25%. Short periods apportion the limits by time; straddling periods disclose the fiscal-year day split.',
  },
};

export type UkTermKey = keyof typeof TERMS;

export default function UkTerm({ term }: { term: UkTermKey }) {
  const t = TERMS[term];
  return (
    <span
      title={t.definition}
      className="underline decoration-dotted decoration-gray-400 underline-offset-2 cursor-help text-inherit"
    >
      {t.label}
    </span>
  );
}
