import React, { useState } from 'react';
import { mappings as mappingApi, provision as provApi } from '../api/client';

export const TAX_ACCOUNT_TYPE_OPTIONS: { value: string; label: string; group: string }[] = [
  // ── P1 UK-first: FRS 102 Section 29 timing differences lead; legacy US
  // codes retained below for history (existing mappings still resolve).
  { value: 'TEMP_TIMING_DIFFERENCE', label: 'Timing difference (FRS 102 s29)', group: 'Timing Differences (FRS 102 s29)' },
  { value: 'TEMP_FIXED_ASSET_ALLOWANCE', label: 'Fixed assets — capital allowances vs depreciation', group: 'Timing Differences (FRS 102 s29)' },
  { value: 'TEMP_UNRELIEVED_LOSS', label: 'Unrelieved tax loss carried forward', group: 'Timing Differences (FRS 102 s29)' },
  { value: 'PERM_OTHER', label: 'Permanent difference (UK)', group: 'Permanent Differences' },
  { value: 'NODIFF_OTHER', label: 'No difference', group: 'No Difference' },
  { value: 'PERM_MEALS_ENTERTAINMENT', label: 'Meals & Entertainment (legacy)', group: 'Permanent Differences (legacy US)' },
  { value: 'PERM_PENALTIES_FINES', label: 'Penalties & Fines (legacy)', group: 'Permanent Differences (legacy US)' },
  { value: 'PERM_DIVIDENDS_RECEIVED_DEDUCTION', label: 'Dividends Received Deduction (legacy)', group: 'Permanent Differences (legacy US)' },
  { value: 'PERM_LIFE_INSURANCE', label: 'Life Insurance (legacy)', group: 'Permanent Differences (legacy US)' },
  { value: 'PERM_TAX_EXEMPT_INTEREST', label: 'Tax-Exempt Interest (legacy)', group: 'Permanent Differences (legacy US)' },
  { value: 'PERM_NONDEDUCTIBLE_GOODWILL', label: 'Nondeductible Goodwill (legacy)', group: 'Permanent Differences (legacy US)' },
  { value: 'TEMP_DEPRECIATION', label: 'Depreciation (legacy)', group: 'Temporary Differences (legacy US)' },
  { value: 'TEMP_AMORTIZATION', label: 'Amortisation (legacy)', group: 'Temporary Differences (legacy US)' },
  { value: 'TEMP_ACCELERATED_DEPRECIATION', label: 'Accelerated Depreciation (legacy)', group: 'Temporary Differences (legacy US)' },
  { value: 'TEMP_BONUS_DEPRECIATION', label: 'Bonus Depreciation (legacy US)', group: 'Temporary Differences (legacy US)' },
  { value: 'TEMP_SECTION_179', label: 'Section 179 (legacy US — do not use for UK)', group: 'Temporary Differences (legacy US)' },
  { value: 'TEMP_RESEARCH_CREDIT', label: 'R&D Credit (legacy)', group: 'Temporary Differences (legacy US)' },
  { value: 'TEMP_BAD_DEBT_RESERVE', label: 'Bad Debt Reserve (legacy)', group: 'Temporary Differences (legacy US)' },
  { value: 'TEMP_INVENTORY_RESERVE', label: 'Inventory Reserve (legacy)', group: 'Temporary Differences (legacy US)' },
  { value: 'TEMP_WARRANTY_RESERVE', label: 'Warranty Reserve (legacy)', group: 'Temporary Differences (legacy US)' },
  { value: 'TEMP_DEFERRED_REVENUE', label: 'Deferred Revenue (legacy)', group: 'Temporary Differences (legacy US)' },
  { value: 'TEMP_ACCRUED_LIABILITIES', label: 'Accrued Liabilities (legacy)', group: 'Temporary Differences (legacy US)' },
  { value: 'TEMP_PENSION', label: 'Pension (legacy)', group: 'Temporary Differences (legacy US)' },
  { value: 'TEMP_NOL_CARRYFORWARD', label: 'NOL Carryforward (legacy US — use Unrelieved loss for UK)', group: 'Temporary Differences (legacy US)' },
  { value: 'TEMP_TAX_CREDIT_CARRYFORWARD', label: 'Tax Credit Carryforward (legacy)', group: 'Temporary Differences (legacy US)' },
  { value: 'TEMP_OTHER', label: 'Other Temporary (legacy)', group: 'Temporary Differences (legacy US)' },
  { value: 'NODIFF_CASH', label: 'Cash (legacy)', group: 'No Difference (legacy)' },
  { value: 'NODIFF_AR', label: 'Accounts Receivable (legacy)', group: 'No Difference (legacy)' },
  { value: 'NODIFF_AP', label: 'Accounts Payable (legacy)', group: 'No Difference (legacy)' },
  { value: 'NODIFF_REVENUE', label: 'Revenue (legacy)', group: 'No Difference (legacy)' },
  { value: 'NODIFF_SALARIES', label: 'Salaries (legacy)', group: 'No Difference (legacy)' },
  { value: 'NODIFF_RENT', label: 'Rent (legacy)', group: 'No Difference (legacy)' },
  { value: 'NODIFF_UTILITIES', label: 'Utilities (legacy)', group: 'No Difference (legacy)' },
];

const taxAccountTypeGroups = [...new Set(TAX_ACCOUNT_TYPE_OPTIONS.map(o => o.group))];

interface TrialBalanceTableProps {
  rows: any[];
  runStatus?: string;
  runId?: string;
  onChanged?: () => void;
}

export default function TrialBalanceTable({ rows, runStatus, runId, onChanged }: TrialBalanceTableProps) {
  const [expandedAccount, setExpandedAccount] = useState<string | null>(null);
  const locked = runStatus === 'locked';

  const updateInlineMapping = async (accountId: string, field: string, value: string) => {
    const row = rows.find(t => t.accountId === accountId);
    if (!row) return;

    const newMapping = {
      taxAccountType: field === 'taxAccountType' ? value : (row.taxAccountType || 'Unknown'),
      bookTreatment: field === 'bookTreatment' ? value : (row.bookTreatment || 'permanent'),
      timingCategory: field === 'timingCategory' ? value : row.timingCategory,
    };

    try {
      await mappingApi.override(accountId, newMapping);
      if (row.reviewItemId && row.reviewItemStatus === 'open' && runId) {
        await provApi.resolveItem(runId, row.reviewItemId, { resolution: 'approved', resolutionNote: 'Inline override' });
      }
      onChanged?.();
    } catch (err: any) {
      alert('Failed to update mapping: ' + err.message);
    }
  };

  if (rows.length === 0) {
    return <p className="text-gray-500 text-sm text-center mt-8">No trial-balance detail for this run.</p>;
  }

  return (
    <div className="bg-white rounded border border-gray-200 overflow-x-auto h-full">
      <table className="w-full text-xs text-left whitespace-nowrap">
        <thead className="bg-gray-100 sticky top-0 border-b border-gray-200 shadow-sm z-10">
          <tr>
            <th className="px-3 py-2 font-medium text-gray-600">Account</th>
            <th className="px-3 py-2 font-medium text-gray-600 text-right">Balance</th>
            <th className="px-3 py-2 font-medium text-gray-600">Tax Category</th>
            <th className="px-3 py-2 font-medium text-gray-600">Treatment</th>
            <th className="px-3 py-2 font-medium text-gray-600">Provenance</th>
            <th className="px-3 py-2 font-medium text-gray-600">Review</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {rows.map((row: any) => (
            <React.Fragment key={row.accountId}>
              <tr className={`hover:bg-gray-50 ${row.reviewItemStatus === 'open' ? 'bg-yellow-50' : ''} ${expandedAccount === row.accountId ? 'bg-brand-50' : ''}`}>
                <td className="px-3 py-2">
                  <button
                    onClick={() => setExpandedAccount(expandedAccount === row.accountId ? null : row.accountId)}
                    className="text-gray-400 hover:text-gray-600 mr-1 text-xs"
                  >
                    {expandedAccount === row.accountId ? '▼' : '▶'}
                  </button>
                  <span className="font-mono text-gray-500 mr-2">{row.accountNumber}</span>
                  <span className="font-medium">{row.accountName}</span>
                </td>
                <td className="px-3 py-2 text-right font-mono">
                  {Number(row.balance).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </td>
                <td className="px-3 py-2">
                  {!locked ? (
                    <select
                      value={row.taxAccountType || ''}
                      onChange={(e) => updateInlineMapping(row.accountId, 'taxAccountType', e.target.value)}
                      className="text-xs border-gray-300 rounded py-1 pl-2 pr-6 focus:ring-brand-500 focus:border-brand-500"
                    >
                      <option value="">-- Unmapped --</option>
                      {taxAccountTypeGroups.map(group => (
                        <optgroup key={group} label={group}>
                          {TAX_ACCOUNT_TYPE_OPTIONS.filter(o => o.group === group).map(opt => (
                            <option key={opt.value} value={opt.value}>{opt.label}</option>
                          ))}
                        </optgroup>
                      ))}
                    </select>
                  ) : (
                    <span>{row.taxAccountType}</span>
                  )}
                </td>
                <td className="px-3 py-2">
                  {!locked ? (
                    <select
                      value={row.bookTreatment || ''}
                      onChange={(e) => updateInlineMapping(row.accountId, 'bookTreatment', e.target.value)}
                      className="text-xs border-gray-300 rounded py-1 pl-2 pr-6 focus:ring-brand-500 focus:border-brand-500"
                    >
                      <option value="no_diff">No Diff</option>
                      <option value="permanent">Permanent</option>
                      <option value="temporary">Temporary</option>
                    </select>
                  ) : (
                    <span>{row.bookTreatment}</span>
                  )}
                </td>
                <td className="px-3 py-2">
                  <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium ${row.suggestedByAi ? 'bg-purple-100 text-purple-700' : 'bg-gray-100 text-gray-600'}`}>
                    {row.suggestedByAi ? 'AI' : 'Manual'}
                  </span>
                  {typeof row.confidenceScore === 'number' && (
                    <span className={`ml-1 text-[10px] ${row.confidenceScore >= 0.75 ? 'text-green-600' : 'text-yellow-600'}`}>
                      {Math.round(row.confidenceScore * 100)}%
                    </span>
                  )}
                </td>
                <td className="px-3 py-2">
                  {row.reviewItemStatus === 'open' && (
                    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-yellow-100 text-yellow-800">Review</span>
                  )}
                  {row.reviewItemStatus === 'resolved' && (
                    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-green-100 text-green-800">Approved</span>
                  )}
                </td>
              </tr>
              {expandedAccount === row.accountId && (
                <tr className="bg-brand-50/50">
                  <td colSpan={6} className="px-6 py-3">
                    <div className="text-xs text-gray-600 space-y-1">
                      <p><span className="font-medium text-gray-500">Source:</span> {row.type || 'GL Account'}</p>
                      <p><span className="font-medium text-gray-500">Confidence Score:</span> {typeof row.confidenceScore === 'number' ? `${Math.round(row.confidenceScore * 100)}%` : 'N/A'}</p>
                      <p><span className="font-medium text-gray-500">Classification Source:</span> {row.suggestedByAi ? 'AI-suggested (subagent_mapping_agent)' : 'Manual override'}</p>
                      <p><span className="font-medium text-gray-500">Mapping Version:</span> {row.mappingVersion ?? 'v1'}</p>
                      {row.reviewItemId && (
                        <p><span className="font-medium text-gray-500">Review Status:</span> {row.reviewItemStatus} {row.reviewItemSeverity ? `(Severity: ${row.reviewItemSeverity})` : ''}</p>
                      )}
                    </div>
                  </td>
                </tr>
              )}
            </React.Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}
