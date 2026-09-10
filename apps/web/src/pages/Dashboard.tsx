import React, { useEffect, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { provision, connections as connApi, mappings as mappingApi, apiClient, billing, demo } from '../api/client';
import UkTerm from '../components/UkTerm';

const gbp = (n: number) => new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP', minimumFractionDigits: 0 }).format(n);

interface EntitlementState {
  planName: string;
  includedRunsPerMonth: number;
  remainingRuns: number;
  decision: string;
  message: string;
  upgradeRequired: boolean;
}

export default function Dashboard() {
  const [stats, setStats] = useState({ connections: 0, mappings: 0, provisions: 0 });
  const [runStatus, setRunStatus] = useState({ needsReview: 0, awaitingApproval: 0, finalized: 0, locked: 0, total: 0 });
  const [entitlement, setEntitlement] = useState<EntitlementState | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [seeding, setSeeding] = useState(false);
  const [seedResult, setSeedResult] = useState<string | null>(null);
  const [seedError, setSeedError] = useState<string | null>(null);

  useEffect(() => {
    loadStats();
    // Entitlement surfacing only — enforcement lives server-side. Silent on
    // failure so a down billing API never breaks the dashboard.
    billing.subscription()
      .then((res: any) => {
        const e = res?.entitlement;
        const s = res?.subscription;
        if (!e) return;
        setEntitlement({
          planName: String(s?.planName ?? e.planName ?? 'Pilot'),
          includedRunsPerMonth: Number(s?.includedRunsPerMonth ?? e.includedRunsPerMonth ?? 1),
          remainingRuns: Number(e.remainingRuns ?? 0),
          decision: String(e.decision ?? ''),
          message: String(e.message ?? ''),
          upgradeRequired: Boolean(e.upgradeRequired),
        });
      })
      .catch(() => null);
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

  async function loadScenario(scenario: string) {
    setSeeding(true);
    setSeedError(null);
    setSeedResult(null);
    try {
      const res = await demo.switchScenario(scenario);
      setSeedResult(res.alreadyLoaded ? `${res.entity.name} is already loaded.` : `${res.entity.name} loaded. ${res.expectedOutcome}`);
      loadStats();
    } catch (err: any) {
      setSeedError(err.message || 'Failed to load scenario');
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

      {entitlement && (
        <div className={`rounded-card border p-4 text-xs font-medium shadow-sm ${entitlement.upgradeRequired ? 'bg-amber-50 border-amber-200 text-amber-800' : 'bg-[#E8F7F0] border-[#10B981] text-[#0A192F]'}`}>
          <span className="font-semibold">{entitlement.planName} plan</span>
          {' — '}{entitlement.decision === 'free_trial'
            ? 'your first run this month is free.'
            : `${entitlement.remainingRuns} of ${entitlement.includedRunsPerMonth} included runs remaining this month.`}
          {entitlement.upgradeRequired && (
            <span className="ml-2">Further runs bill as overage — contact sales to add capacity.</span>
          )}
        </div>
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
          <p className="text-sm text-gray-500 mb-1">No provision runs generated yet.</p>
          <p className="text-xs text-gray-400 mb-4">Start with a balanced UK scenario — each one calculates cleanly end to end:</p>
          <div className="flex flex-wrap gap-2 justify-center">
            <Link to="/provision" className="inline-block px-4 py-2 bg-[#0A192F] text-white rounded-button text-xs font-medium hover:bg-[#112240] transition-colors">
              Run First Provision →
            </Link>
            <button onClick={() => loadScenario('apex-marginal-relief')} disabled={seeding} className="px-4 py-2 border border-gray-300 rounded-button text-xs font-medium hover:bg-gray-50 disabled:opacity-50 transition-colors">
              Load Marginal Relief Scenario
            </button>
            <button onClick={() => loadScenario('biotech-rd-loss')} disabled={seeding} className="px-4 py-2 border border-gray-300 rounded-button text-xs font-medium hover:bg-gray-50 disabled:opacity-50 transition-colors">
              Load R&D Loss Scenario
            </button>
            <button onClick={() => loadScenario('cotswold-capex')} disabled={seeding} className="px-4 py-2 border border-gray-300 rounded-button text-xs font-medium hover:bg-gray-50 disabled:opacity-50 transition-colors">
              Load Capital Allowances Scenario
            </button>
          </div>
        </div>
      )}

      <div className="bg-white rounded-card border border-gray-200 p-6 shadow-sm">
        <div className="flex items-baseline justify-between mb-4">
          <h3 className="text-lg font-serif font-semibold text-[#0A192F] tracking-tight">Provision Workflow Checklist</h3>
          <span className="text-[11px] text-gray-500 font-sans">
            {[stats.connections > 0 || stats.provisions > 0, stats.mappings > 0, stats.provisions > 0, runStatus.locked > 0, runStatus.locked > 0].filter(Boolean).length} of 5 complete
          </span>
        </div>
        <ol className="space-y-3">
          <TourStep
            done={stats.connections > 0 || stats.provisions > 0}
            title="1. Ingest Data"
            to="/connections"
            cta="Connect or upload →"
          >
            Upload a CSV trial balance or connect Xero/QBO. Or load a demo scenario above.
          </TourStep>
          <TourStep
            done={stats.mappings > 0}
            title="2. Review AI Classifications"
            to="/mapping"
            cta="Review mappings →"
          >
            Approve or reject suggested tax treatments. Unmapped and low-confidence accounts land in the review queue.
          </TourStep>
          <TourStep
            done={stats.provisions > 0}
            title="3. Run Workbench Provision"
            to="/workbench"
            cta="Open Workbench →"
          >
            Deterministic FRS 102 math — <UkTerm term="s29-timing" />, <UkTerm term="marginal-relief" />, <UkTerm term="hmrc-bands" />. Resolve every flagged review item.
          </TourStep>
          <TourStep
            done={runStatus.locked > 0}
            title="4. Partner Sign-Off & Lock"
            to="/review"
            cta="Open review queue →"
          >
            Maker-checker segregation: the partner who approves can never be the preparer who submitted. Lock freezes the run.
          </TourStep>
          <TourStep
            done={runStatus.locked > 0}
            title="5. Export Workpapers"
            to="/review"
            cta="Export from a locked run →"
          >
            Download the deterministic ZIP package and journal entries from any locked run. Push journals to Xero as DRAFT.
          </TourStep>
        </ol>
      </div>
    </div>
  );
}

function TourStep({ done, title, to, cta, children }: { done: boolean; title: string; to: string; cta: string; children: React.ReactNode }) {
  return (
    <li className="flex gap-3 items-start">
      <span className={`mt-0.5 inline-flex w-5 h-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold ${done ? 'bg-[#10B981] text-white' : 'bg-gray-100 text-gray-500 border border-gray-200'}`}>
        {done ? '✓' : '·'}
      </span>
      <div className="min-w-0">
        <p className="text-xs font-semibold text-[#0A192F]">
          {title}{' '}
          <Link to={to} className="font-medium text-[#1E2D4A] hover:underline ml-1">{cta}</Link>
        </p>
        <p className={`text-xs text-gray-600 mt-0.5 ${done ? 'line-through text-[#10B981]' : ''}`}>{children}</p>
      </div>
    </li>
  );
}
