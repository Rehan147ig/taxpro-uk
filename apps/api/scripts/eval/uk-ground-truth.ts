/**
 * UK FRS 102 ground truth schema.
 *
 * There is no instant API for UK Companies House structured data in a
 * compatible format. These fixtures are manually curated from filed accounts.
 *
 * Source: filed statutory accounts on the UK Companies House find-and-update
 * service at https://find-and-update.company-information.service.gov.uk/
 */

export interface UkReconItem {
  label: string;
  amount: number;
  type: 'permanent' | 'timing' | 'other';
}

export interface UkTaxFootnote {
  companyName: string;
  companiesHouseNumber: string;
  accountingPeriodEnd: string;
  pretaxProfit: number;
  totalTaxCharge: number;
  currentTaxCharge: number;
  deferredTaxCharge: number;
  disclosedEffectiveRate: number;
  statutoryRate: number;
  reconciliationItems: UkReconItem[];
  deferredTaxAssetClosing: number;
  deferredTaxLiabilityClosing: number;
  probableRecoveryNoted: boolean;
  sourceDocumentUrl: string;
  /** Accounting standard: 'FRS 102', 'FRS 101', 'IFRS', etc. */
  standard: 'FRS 102' | 'FRS 101' | 'IFRS';
  /** How deferred tax was sourced: 'recon_timing' from ETR reconciliation timing
   *  items, or 'balance_sheet_fallback' from disclosed Note 14 balance-sheet
   *  balances when no ETR timing items exist. */
  deferredTaxBalanceSource?: 'recon_timing' | 'balance_sheet_fallback';
  /** Note number/refs in the filed document, e.g. 'Note 8 (income tax), Note 14 (deferred tax)'. */
  noteRef?: string;
  /** Manual transcription adjustments made against the filed figures (none = as-filed). */
  manualAdjustments?: string[];
}

const PLACEHOLDER_MARKERS = ['TODO', null, 0, ''];

export function validateFixture(f: UkTaxFootnote): string[] {
  const missing: string[] = [];

  if (!f.companyName || PLACEHOLDER_MARKERS.includes(f.companyName)) {
    missing.push('companyName');
  }
  if (!f.companiesHouseNumber || PLACEHOLDER_MARKERS.includes(f.companiesHouseNumber)) {
    missing.push('companiesHouseNumber');
  }
  if (!f.accountingPeriodEnd || PLACEHOLDER_MARKERS.includes(f.accountingPeriodEnd)) {
    missing.push('accountingPeriodEnd');
  }
  if (f.pretaxProfit === 0 || PLACEHOLDER_MARKERS.includes(f.pretaxProfit)) {
    missing.push('pretaxProfit');
  }
  if (f.totalTaxCharge === 0 && f.pretaxProfit !== 0) {
    missing.push('totalTaxCharge');
  }
  if (!f.sourceDocumentUrl || PLACEHOLDER_MARKERS.includes(f.sourceDocumentUrl)) {
    missing.push('sourceDocumentUrl');
  }

  return missing;
}
