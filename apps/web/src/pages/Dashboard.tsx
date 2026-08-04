import React, { useEffect, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { provision, connections as connApi, mappings as mappingApi, apiClient } from '../api/client';

const gbp = (n: number) => new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP', minimumFractionDigits: 0 }).format(n);

export default function Dashboard() {
  const [stats, setStats] = useState({ connections: 0, mappings: 0, provisions: 0 });
  const [runStatus, setRunStatus] = useState({ needsReview: 0, awaitingApproval: 0, finalized: 0, locked: 0, total: 0 });
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [seeding, setSeeding] = useState(false);
  const [seedResult, setSeedResult] = useState<string | null>(null);
  const [seedError, setSeedError] = useState<string | null>(null);

  useEffect(() => {
    loadStats();
  }, []);

  function loadStats() {
    setLoading(true);
    setLoadError(null);
    Promise.all([
      connApi.list().then(c => c.length),
      mappingApi.list().then(m => m.length),
      provision.results().then(p => p.length),
      provision.runs().then(runs => {
        const rs = { needsReview: 0, awaitingApproval: 0, finalized: 0, locked: 0, total: runs.length };
        for (const r of runs) {
          if (r.status === 'locked') rs.locked++;
          else if (r.approvalStatus === 'pending_partner_review') rs.awaitingApproval++;
          else if (r.status === 'needs_review' || r.status === 'calculated' || r.status === 'workpapers_generated') rs.needsReview++;
          if (r.status === 'finalized') rs.finalized++;
        }
        return rs;
      }),
    ])
      .then(([conns, maps, provs, rs]) => {
        setStats({ connections: conns, mappings: maps, provisions: provs });
        setRunStatus(rs);
      })
      .catch((err: any) => setLoadError(err.message || 'Failed to load dashboard data'))
      .finally(() => setLoading(false));
  }

  async function loadDemoData() {
    setSeeding(true);
    setSeedError(null);
    setSeedResult(null);
    try {
      const res = await apiClient<{ message: string; summary: { totalIncome: number; totalExpenses: number; pbt: number } }>('/demo/seed', { method: 'POST' });
      setSeedResult(`Loaded! PBT: ${gbp(res.summary.pbt)}. ${res.message}`);
      loadStats();
    } catch (err: any) {
      setSeedError(err.message || 'Failed to load demo data');
    } finally {
      setSeeding(false);
    }
  }

  const cards = [
    { label: 'ERP Connections', value: stats.connections, indicator: 'bg-[#3B82F6]' },
    { label: 'Accounts Mapped', value: stats.mappings, indicator: 'bg-[#10B981]' },
    { label: 'Provision Runs', value: stats.provisions, indicator: 'bg-[#8B5CF6]' },
  ];

  const statusCards = [
    { label: 'Needs Review', value: runStatus.needsReview, to: '/review', badge: 'bg-amber-50 text-amber-700 border-amber-200' },
    { label: 'Awaiting Partner Approval', value: runStatus.awaitingApproval, to: '/review', badge: 'bg-indigo-50 text-indigo-700 border-indigo-200' },
    { label: 'Finalized', value: runStatus.finalized, to: '/review', badge: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
    { label: 'Locked', value: runStatus.locked, to: '/review', badge: 'bg-slate-100 text-slate-800 border-slate-300' },
  ];

  return (
    <div className="space-y-6 font-sans">
      <div className="flex items-center justify-between pb-2 border-b border-gray-200">
        <div>
          <h2 className="text-2xl font-serif font-semibold text-[#0A192F] tracking-tight">Executive Dashboard</h2>
          <p className="text-xs text-gray-500 mt-1 font-sans">
            UK FRS 102 corporate tax provision workbench
          </p>
        </div>
        <button
          onClick={loadDemoData}
          disabled={seeding}
          className="px-4 py-2 bg-[#0A192F] text-white rounded-button text-sm font-medium hover:bg-[#112240] disabled:opacity-50 transition-colors shadow-sm"
        >
          {seeding ? 'Loading demo data...' : 'Load Demo Data (Greggs plc)'}
        </button>
      </div>

      {seedResult && (
        <div className="bg-[#E8F7F0] border border-[#10B981] text-[#0A192F] rounded-card p-4 text-xs font-medium">{seedResult}</div>
      )}
      {seedError && (
        <div className="bg-amber-50 border border-amber-200 text-amber-800 rounded-card p-4 text-xs font-medium">{seedError}</div>
      )}
      {loadError && (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded-card p-4 text-xs font-medium">{loadError}</div>
      )}

      <div className="grid grid-cols-3 gap-5">
        {cards.map((card) => (
          <div key={card.label} className="bg-white rounded-card border border-gray-200 p-6 shadow-sm">
            <div className={`w-2.5 h-2.5 rounded-full ${card.indicator} mb-3`} />
            <p className="text-3xl font-serif font-semibold text-[#0A192F] tracking-tight">{loading ? '...' : card.value}</p>
            <p className="text-xs font-medium text-gray-500 mt-1">{card.label}</p>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-4 gap-4">
        {statusCards.map((card) => (
          <Link
            key={card.label}
            to={card.to}
            className="bg-white rounded-card border border-gray-200 p-4 hover:border-[#0A192F] transition-all shadow-sm block"
          >
            <span className={`inline-block px-2.5 py-1 rounded-button text-xs font-semibold border ${card.badge} mb-2`}>
              {loading ? '...' : card.value}
            </span>
            <p className="text-xs font-medium text-[#0A192F]">{card.label}</p>
          </Link>
        ))}
      </div>

      {runStatus.total === 0 && !loading && (
        <div className="bg-white rounded-card border border-gray-200 p-8 text-center shadow-sm">
          <p className="text-sm text-gray-500 mb-3">No provision runs generated yet.</p>
          <Link to="/provision" className="inline-block px-4 py-2 bg-[#0A192F] text-white rounded-button text-xs font-medium hover:bg-[#112240] transition-colors">
            Run First Provision →
          </Link>
        </div>
      )}

      <div className="bg-white rounded-card border border-gray-200 p-6 shadow-sm">
        <h3 className="text-lg font-serif font-semibold text-[#0A192F] mb-4 tracking-tight">Provision Workflow Checklist</h3>
        <ol className="list-decimal list-inside text-xs text-gray-600 space-y-2.5">
          <li className={stats.connections > 0 ? 'line-through text-[#10B981] font-medium' : ''}>
            Connect an ERP (NetSuite/Xero) or upload a trial balance CSV
          </li>
          <li className={stats.mappings > 0 ? 'line-through text-[#10B981] font-medium' : ''}>
            Run AI auto-mapping and approve proposed classifications
          </li>
          <li className={stats.provisions > 0 ? 'line-through text-[#10B981] font-medium' : ''}>
            Execute UK FRS 102 tax engine calculation
          </li>
          <li className={runStatus.locked > 0 ? 'line-through text-[#10B981] font-medium' : ''}>
            Partner sign-off, lock provision run, and export workpapers
          </li>
        </ol>
      </div>
    </div>
  );
}
