import React, { useEffect, useState } from 'react';
import { proposals as proposalsApi, rules as rulesApi, provision } from '../api/client';

export default function GovernancePage() {
  const [proposals, setProposals] = useState<any[]>([]);
  const [rules, setRules] = useState<any[]>([]);
  const [entities, setEntities] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deciding, setDeciding] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [carrying, setCarrying] = useState(false);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const [p, r, e] = await Promise.all([proposalsApi.list(), rulesApi.list(), provision.entities()]);
      setProposals(p);
      setRules(r);
      setEntities(e);
    } catch (err: any) {
      setError(err.message || 'Failed to load governance data');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const decide = async (id: string, decision: 'approved' | 'rejected') => {
    if (!reason.trim()) {
      setError('A decision reason is required for the audit trail.');
      return;
    }
    setDeciding(id);
    setError(null);
    try {
      const result = await proposalsApi.decide(id, { decision, reason: reason.trim() });
      if (result.applied) {
        setError(null);
      }
      setReason('');
      await load();
    } catch (err: any) {
      setError(err.message || 'Decision failed');
    } finally {
      setDeciding(null);
    }
  };

  const carryForward = async () => {
    const entityId = entities[0]?.id;
    if (!entityId) {
      setError('No entity available for carry-forward.');
      return;
    }
    setCarrying(true);
    setError(null);
    try {
      const result = await proposalsApi.carryForward(entityId);
      setError(result.note || null);
      await load();
    } catch (err: any) {
      setError(err.message || 'Carry-forward failed');
    } finally {
      setCarrying(false);
    }
  };

  const approveRule = async (id: string) => {
    setError(null);
    try {
      await rulesApi.approve(id);
      await load();
    } catch (err: any) {
      setError(err.message || 'Rule approval failed');
    }
  };

  const StatusBadge = ({ state }: { state: string }) => {
    const color = state === 'approved' ? 'bg-[#E8F7F0] text-[#10B981] border-[#10B981]/30'
      : state === 'pending' ? 'bg-amber-50 text-amber-800 border-amber-200'
        : state === 'rolled_back' ? 'bg-red-50 text-red-700 border-red-200'
          : state === 'superseded' ? 'bg-gray-100 text-gray-500 border-gray-200'
            : 'bg-blue-50 text-blue-700 border-blue-200';
    return <span className={`px-1.5 py-0.5 rounded-button text-[10px] font-semibold border ${color}`}>{state}</span>;
  };

  return (
    <div className="space-y-6 font-sans">
      <div className="flex justify-between items-center pb-2 border-b border-gray-200">
        <div>
          <h2 className="text-2xl font-serif font-semibold text-[#0A192F] tracking-tight">Mappings & Rule Governance</h2>
          <p className="text-xs text-gray-500 mt-1">
            AI only proposes; humans decide. Rules are approved before any run records them as used
          </p>
        </div>
        <div className="flex gap-2">
          <button onClick={carryForward} disabled={carrying}
            className="text-xs text-[#0A192F] font-semibold hover:underline bg-white border border-gray-200 px-3 py-1.5 rounded-button shadow-sm disabled:opacity-50">
            {carrying ? 'Carrying…' : 'Carry Forward (proposals only)'}
          </button>
          <button onClick={load} className="text-xs text-[#0A192F] font-semibold hover:underline bg-white border border-gray-200 px-3 py-1.5 rounded-button shadow-sm">Refresh</button>
        </div>
      </div>

      {error && <div className="bg-red-50 border border-red-200 text-red-700 rounded-card p-4 text-xs font-medium">{error}</div>}
      {loading && <p className="text-xs text-gray-500">Loading governance data…</p>}

      <div>
        <h3 className="text-base font-serif font-semibold text-[#0A192F] mb-3 tracking-tight">Mapping Proposals</h3>
        <div className="bg-white rounded-card border border-gray-200 overflow-hidden shadow-sm">
          <table className="w-full text-xs">
            <thead className="bg-[#F8F9FA] border-b border-gray-200">
              <tr>
                <th className="text-left px-3 py-2.5 font-semibold text-[#0A192F]">Source account</th>
                <th className="text-left px-3 py-2.5 font-semibold text-[#0A192F]">Target classification</th>
                <th className="text-left px-3 py-2.5 font-semibold text-[#0A192F]">Book treatment</th>
                <th className="text-left px-3 py-2.5 font-semibold text-[#0A192F]">Source</th>
                <th className="text-left px-3 py-2.5 font-semibold text-[#0A192F]">Status</th>
                <th className="text-left px-3 py-2.5 font-semibold text-[#0A192F]">Reason / Decision</th>
                <th className="text-left px-3 py-2.5 font-semibold text-[#0A192F]">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {proposals.length === 0 && !loading && (
                <tr><td colSpan={7} className="px-3 py-4 text-gray-400 text-center">No mapping proposals.</td></tr>
              )}
              {proposals.map((p: any) => (
                <tr key={p.id}>
                  <td className="px-3 py-2.5 font-medium text-[#0A192F]">
                    {p.sourceAccountName || p.sourceAccountExternalId}
                    <span className="block text-gray-400 font-mono text-[10px]">{p.sourceAccountExternalId}</span>
                  </td>
                  <td className="px-3 py-2.5">
                    <span className={`px-1.5 py-0.5 rounded-button text-[10px] font-semibold border ${
                      p.targetTaxClassification === 'MANUAL_REVIEW'
                        ? 'bg-amber-50 text-amber-800 border-amber-200'
                        : 'bg-[#E8F7F0] text-[#10B981] border-[#10B981]/30'
                    }`}>{p.targetTaxClassification}</span>
                  </td>
                  <td className="px-3 py-2.5 text-gray-600">{p.bookTreatment}</td>
                  <td className="px-3 py-2.5 text-gray-500">{p.proposalSource}</td>
                  <td className="px-3 py-2.5"><StatusBadge state={p.status} /></td>
                  <td className="px-3 py-2.5 text-gray-500 max-w-[220px]">{p.decisionReason || '—'}</td>
                  <td className="px-3 py-2.5">
                    {p.status === 'pending' ? (
                      <div className="flex flex-col gap-1.5">
                        <input
                          value={reason}
                          onChange={(e) => setReason(e.target.value)}
                          placeholder="Decision reason (required)"
                          className="border border-gray-300 rounded-button px-2 py-1 text-[10px] w-44 bg-white"
                        />
                        <div className="flex gap-1.5">
                          <button
                            onClick={() => decide(p.id, 'approved')}
                            disabled={deciding === p.id}
                            className="text-[10px] font-semibold bg-[#0A192F] text-white px-2 py-1 rounded-button disabled:opacity-50"
                          >
                            {deciding === p.id ? '…' : 'Approve & Apply'}
                          </button>
                          <button
                            onClick={() => decide(p.id, 'rejected')}
                            disabled={deciding === p.id}
                            className="text-[10px] font-semibold bg-white text-red-600 border border-red-200 px-2 py-1 rounded-button disabled:opacity-50"
                          >
                            Reject
                          </button>
                        </div>
                      </div>
                    ) : (
                      <span className="text-gray-400 text-[10px]">decided {p.decidedAt ? new Date(p.decidedAt).toLocaleDateString() : ''}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div>
        <h3 className="text-base font-serif font-semibold text-[#0A192F] mb-3 tracking-tight">UK Rules Registry</h3>
        <div className="bg-white rounded-card border border-gray-200 overflow-hidden shadow-sm">
          <table className="w-full text-xs">
            <thead className="bg-[#F8F9FA] border-b border-gray-200">
              <tr>
                <th className="text-left px-3 py-2.5 font-semibold text-[#0A192F]">Rule</th>
                <th className="text-left px-3 py-2.5 font-semibold text-[#0A192F]">Version</th>
                <th className="text-left px-3 py-2.5 font-semibold text-[#0A192F]">Effective</th>
                <th className="text-left px-3 py-2.5 font-semibold text-[#0A192F]">State</th>
                <th className="text-left px-3 py-2.5 font-semibold text-[#0A192F]">Source</th>
                <th className="text-left px-3 py-2.5 font-semibold text-[#0A192F]">Rationale</th>
                <th className="text-left px-3 py-2.5 font-semibold text-[#0A192F]">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {rules.length === 0 && !loading && (
                <tr><td colSpan={7} className="px-3 py-4 text-gray-400 text-center">No rules in the registry.</td></tr>
              )}
              {rules.map((r: any) => (
                <tr key={r.id}>
                  <td className="px-3 py-2.5 font-medium text-[#0A192F] font-mono text-[11px]">{r.ruleKey}</td>
                  <td className="px-3 py-2.5 text-gray-600 font-mono text-[11px]">v{r.version}</td>
                  <td className="px-3 py-2.5 text-gray-500 font-mono text-[11px]">{r.effectiveFrom}{r.effectiveTo ? ` → ${r.effectiveTo}` : ''}</td>
                  <td className="px-3 py-2.5"><StatusBadge state={r.approvalState} /></td>
                  <td className="px-3 py-2.5 text-gray-500 max-w-[200px] truncate">{r.sourceUrl || '—'}</td>
                  <td className="px-3 py-2.5 text-gray-500 max-w-[220px]">{r.changeRationale}</td>
                  <td className="px-3 py-2.5">
                    {r.approvalState === 'proposal' && (
                      <button onClick={() => approveRule(r.id)}
                        className="text-[10px] font-semibold bg-[#0A192F] text-white px-2 py-1 rounded-button">
                        Approve
                      </button>
                    )}
                    {r.approvalState === 'approved' && <span className="text-gray-400 text-[10px]">in use by runs</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
