import React, { useEffect, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { provision as provApi, quotaDetailsFromError, type QuotaDetails } from '../api/client';
import { webProvisionRunCounter } from '../observability';
import { RunStatusBadge } from '../components/RunStatusBadge';
import QuotaWall from '../components/QuotaWall';

export default function ProvisionPage() {
  const [period, setPeriod] = useState('2024-01-01');
  const [endPeriod, setEndPeriod] = useState('');
  const [entityId, setEntityId] = useState('');
  const [entities, setEntities] = useState<{ id: string; name: string; type: string; currency: string | null; taxJurisdiction: string | null }[]>([]);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState<'workpaper' | 'package' | null>(null);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState('');
  const [entitiesError, setEntitiesError] = useState<string | null>(null);
  const [quota, setQuota] = useState<QuotaDetails | null>(null);

  useEffect(() => {
    provApi.entities().then(setEntities).catch((err: any) => setEntitiesError(err.message || 'Failed to load entities'));
  }, []);

  const selectedEntity = entities.find((e) => e.id === entityId) ?? null;
  const isUsEntity = selectedEntity?.taxJurisdiction?.toUpperCase().startsWith('US') ?? false;
  const currency = selectedEntity?.currency || 'GBP';

  const handleRun = async () => {
    setLoading(true);
    setError('');
    setResult(null);
    setQuota(null);
    try {
      const data = await provApi.run({ period, endPeriod: endPeriod || undefined, entityId: entityId || undefined });
      setResult(data);
      webProvisionRunCounter.add(1, { outcome: 'success' });
    } catch (err: any) {
      // 402 quota wall opens the upgrade modal (with usage + plan details);
      // every other failure keeps the existing inline banner behavior.
      const details = quotaDetailsFromError(err);
      if (details) setQuota(details);
      else setError(err.message);
      webProvisionRunCounter.add(1, { outcome: 'error' });
    } finally {
      setLoading(false);
    }
  };

  const fmt = (n: number) =>
    new Intl.NumberFormat(currency === 'GBP' ? 'en-GB' : 'en-US', { style: 'currency', currency, minimumFractionDigits: 0 }).format(n);

  const handleExport = async (type: 'workpaper' | 'package') => {
    if (!result?.id) return;
    setExporting(type);
    try {
      const blob = type === 'package' ? await provApi.exportPackage(result.id) : await provApi.exportResult(result.id);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = type === 'package'
        ? `taxpro-package-${period}.zip`
        : `taxpro-provision-${period}.xlsx`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (err: any) {
      setError(err.message || 'Export failed');
    } finally {
      setExporting(null);
    }
  };

  return (
    <div className="space-y-6 font-sans">
      <div className="flex justify-between items-center pb-2 border-b border-gray-200">
        <div>
          <h2 className="text-2xl font-serif font-semibold text-[#0A192F] tracking-tight">Corporate Tax Provision Engine</h2>
          <p className="text-xs text-gray-500 mt-1">Deterministic calculation for current, deferred tax, and ETR walk</p>
        </div>
        <div className="flex gap-2 items-center flex-wrap">
          <select
            value={entityId}
            onChange={(e) => setEntityId(e.target.value)}
            className="px-3 py-2 border border-gray-300 rounded-button text-xs bg-white text-[#0A192F] focus:ring-2 focus:ring-[#0A192F]"
          >
            <option value="">All Corporate Entities</option>
            {entities.map(e => (
              <option key={e.id} value={e.id}>{e.name}</option>
            ))}
          </select>
          {entitiesError && <span className="text-red-600 text-xs font-medium">{entitiesError}</span>}
          <input
            type="month"
            value={period.slice(0, 7)}
            onChange={(e) => setPeriod(e.target.value + '-01')}
            className="px-3 py-2 border border-gray-300 rounded-button text-xs text-[#0A192F] focus:ring-2 focus:ring-[#0A192F]"
          />
          <span className="text-gray-400 text-xs font-medium">to</span>
          <input
            type="month"
            value={endPeriod ? endPeriod.slice(0, 7) : ''}
            onChange={(e) => setEndPeriod(e.target.value ? e.target.value + '-01' : '')}
            className="px-3 py-2 border border-gray-300 rounded-button text-xs text-[#0A192F] focus:ring-2 focus:ring-[#0A192F]"
            placeholder="End period"
          />
          <button
            onClick={handleRun}
            disabled={loading}
            className="bg-[#0A192F] text-white px-4 py-2 rounded-button text-xs font-medium hover:bg-[#112240] disabled:opacity-50 transition-colors shadow-sm"
          >
            {loading ? 'Calculating Math...' : 'Run Provision Engine'}
          </button>
        </div>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded-card p-4 text-xs font-medium">
          {error}
        </div>
      )}

      {quota && <QuotaWall quota={quota} onClose={() => setQuota(null)} />}

      {result && (
        <div className="space-y-6">
          <div className="flex justify-between items-center gap-2 bg-white border border-gray-200 rounded-card p-4 shadow-sm">
            <div className="flex items-center gap-3">
              {result.status && <RunStatusBadge status={result.status} />}
              {result.provisionRunId && (
                <Link to="/runs/$runId" params={{ runId: result.provisionRunId }} className="text-xs text-[#0A192F] font-semibold hover:underline">
                  Open Audit Workspace →
                </Link>
              )}
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => handleExport('workpaper')}
                disabled={exporting !== null}
                className="bg-white border border-gray-300 text-[#0A192F] px-3.5 py-2 rounded-button text-xs font-medium hover:bg-gray-50 disabled:opacity-50 transition-colors"
              >
                {exporting === 'workpaper' ? 'Exporting...' : 'Export Workpapers (.xlsx)'}
              </button>
              <button
                onClick={() => handleExport('package')}
                disabled={exporting !== null}
                className="bg-[#0A192F] text-white px-3.5 py-2 rounded-button text-xs font-medium hover:bg-[#112240] disabled:opacity-50 transition-colors shadow-sm"
              >
                {exporting === 'package' ? 'Exporting...' : 'Export Audit ZIP Package'}
              </button>
            </div>
          </div>

          {/* Summary Cards */}
          <div className="grid grid-cols-4 gap-4">
            <div className="bg-white rounded-card border border-gray-200 p-5 shadow-sm">
              <p className="text-[11px] font-semibold text-gray-500 uppercase tracking-wider mb-1">Pretax Book Income</p>
              <p className="text-2xl font-serif font-semibold text-[#0A192F] tracking-tight">{fmt(result.summary.bookIncome)}</p>
            </div>
            <div className="bg-white rounded-card border border-gray-200 p-5 shadow-sm">
              <p className="text-[11px] font-semibold text-gray-500 uppercase tracking-wider mb-1">Total Provision Expense</p>
              <p className="text-2xl font-serif font-semibold text-[#0A192F] tracking-tight">{fmt(result.summary.totalTaxExpense)}</p>
            </div>
            <div className="bg-white rounded-card border border-gray-200 p-5 shadow-sm">
              <p className="text-[11px] font-semibold text-gray-500 uppercase tracking-wider mb-1">Effective Tax Rate (ETR)</p>
              <p className="text-2xl font-serif font-semibold text-[#0A192F] tracking-tight">{(result.summary.effectiveTaxRate * 100).toFixed(2)}%</p>
            </div>
            <div className="bg-white rounded-card border border-gray-200 p-5 shadow-sm">
              <p className="text-[11px] font-semibold text-gray-500 uppercase tracking-wider mb-1">Net Current Tax Payable</p>
              <p className="text-2xl font-serif font-semibold text-[#0A192F] tracking-tight">{fmt(result.summary.taxPayable)}</p>
            </div>
          </div>

          {/* Current Tax Details */}
          <div className="bg-white rounded-card border border-gray-200 p-6 shadow-sm">
            <h3 className="text-lg font-serif font-semibold text-[#0A192F] mb-4 tracking-tight">Current Tax Provision Summary</h3>
            <div className="grid grid-cols-2 gap-4 text-xs font-sans">
              <div><span className="text-gray-500 font-medium">Pretax Book Income:</span> <span className="font-mono text-[#0A192F]">{fmt(result.currentTax.bookIncome)}</span></div>
              <div><span className="text-gray-500 font-medium">Permanent Differences:</span> <span className="font-mono text-[#0A192F]">{fmt(result.currentTax.totalPermanentAdjustments)}</span></div>
              <div><span className="text-gray-500 font-medium">Calculated Taxable Income:</span> <span className="font-mono text-[#0A192F]">{fmt(result.currentTax.taxableIncome)}</span></div>
              <div><span className="text-gray-500 font-medium">{isUsEntity ? 'Federal Tax (21% Rate)' : 'Corporation Tax (25% main rate)'}:</span> <span className="font-mono text-[#0A192F]">{fmt(result.currentTax.federalTax)}</span></div>
              {isUsEntity && (
                <div><span className="text-gray-500 font-medium">State Income Tax:</span> <span className="font-mono text-[#0A192F]">{fmt(result.currentTax.stateTax)}</span></div>
              )}
              <div><span className="text-gray-500 font-medium">Net Income Tax Payable:</span> <span className="font-mono text-[#0A192F] font-semibold">{fmt(result.currentTax.taxPayable)}</span></div>
            </div>
          </div>

          {/* Deferred Tax */}
          <div className="bg-white rounded-card border border-gray-200 p-6 shadow-sm">
            <h3 className="text-lg font-serif font-semibold text-[#0A192F] mb-4 tracking-tight">Deferred Tax Asset & Liability Rollforward</h3>
            <div className="grid grid-cols-2 gap-4 text-xs font-sans">
              <div><span className="text-gray-500 font-medium">Opening DTA Balance:</span> <span className="font-mono text-[#0A192F]">{fmt(result.deferredTax.totalOpeningDTA)}</span></div>
              <div><span className="text-gray-500 font-medium">Opening DTL Balance:</span> <span className="font-mono text-[#0A192F]">{fmt(result.deferredTax.totalOpeningDTL)}</span></div>
              <div><span className="text-gray-500 font-medium">Closing DTA Balance:</span> <span className="font-mono text-[#0A192F]">{fmt(result.deferredTax.totalClosingDTA)}</span></div>
              <div><span className="text-gray-500 font-medium">Closing DTL Balance:</span> <span className="font-mono text-[#0A192F]">{fmt(result.deferredTax.totalClosingDTL)}</span></div>
              <div className="col-span-2 pt-2 border-t border-gray-100">
                <span className="text-gray-500 font-medium">Net Deferred Tax Expense:</span>{' '}
                <span className={`font-mono font-semibold ${result.deferredTax.netDeferredTaxExpense > 0 ? 'text-red-700' : 'text-[#10B981]'}`}>
                  {fmt(result.deferredTax.netDeferredTaxExpense)}
                </span>
              </div>
            </div>
          </div>

          {/* ETR Reconciliation */}
          <div className="bg-white rounded-card border border-gray-200 p-6 shadow-sm">
            <h3 className="text-lg font-serif font-semibold text-[#0A192F] mb-4 tracking-tight">Effective Tax Rate (ETR) Statutory Walk</h3>
            <table className="w-full text-xs font-sans">
              <thead>
                <tr className="bg-[#F8F9FA] border-b border-gray-200">
                  <th className="text-left py-2.5 px-3 font-semibold text-[#0A192F]">Reconciliation Item</th>
                  <th className="text-right py-2.5 px-3 font-semibold text-[#0A192F]">Tax Impact</th>
                  <th className="text-right py-2.5 px-3 font-semibold text-[#0A192F]">Rate Impact %</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {result.etr.lines.map((line: any, i: number) => (
                  <tr key={i} className="hover:bg-[#F8F9FA]">
                    <td className="py-2.5 px-3 text-[#0A192F]">{line.description}</td>
                    <td className="text-right py-2.5 px-3 font-mono">{fmt(line.taxImpact)}</td>
                    <td className="text-right py-2.5 px-3 font-mono">{(line.rateImpact * 100).toFixed(2)}%</td>
                  </tr>
                ))}
                <tr className="font-semibold bg-[#F8F9FA] border-t border-gray-200">
                  <td className="py-3 px-3 text-[#0A192F]">Effective Tax Rate (ETR)</td>
                  <td className="text-right py-3 px-3 font-mono">{fmt(result.etr.totalTaxExpense)}</td>
                  <td className="text-right py-3 px-3 font-mono text-[#0A192F]">{(result.etr.effectiveTaxRate * 100).toFixed(2)}%</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
