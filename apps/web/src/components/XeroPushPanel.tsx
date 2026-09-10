import { useEffect, useState } from 'react';
import { xero, type XeroAccountCodes } from '../api/client';

interface Props {
  runId: string;
  locked: boolean;
}

const CODE_FIELDS: Array<{ key: keyof XeroAccountCodes; label: string }> = [
  { key: 'currentTaxExpense', label: 'Current tax expense (P&L Dr)' },
  { key: 'corporationTaxPayable', label: 'Corporation tax creditor (BS Cr)' },
  { key: 'deferredTaxExpense', label: 'Deferred tax expense (P&L Dr)' },
  { key: 'deferredTaxProvision', label: 'Deferred tax provision (BS Cr)' },
  { key: 'deferredTaxAsset', label: 'Deferred tax asset (BS Dr)' },
];

type Status =
  | { kind: 'idle' }
  | { kind: 'working' }
  | { kind: 'success'; manualJournalId: string; lines: number }
  | { kind: 'error'; message: string };

export default function XeroPushPanel({ runId, locked }: Props) {
  const [connections, setConnections] = useState<Array<{ id: string; label: string }>>([]);
  const [connectionId, setConnectionId] = useState('');
  const [codes, setCodes] = useState<XeroAccountCodes>({
    currentTaxExpense: '',
    corporationTaxPayable: '',
    deferredTaxExpense: '',
    deferredTaxProvision: '',
    deferredTaxAsset: '',
  });
  const [confirming, setConfirming] = useState(false);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });

  useEffect(() => {
    if (!locked) return;
    xero.connections().then((c) => {
      setConnections(c);
      if (c.length === 1) setConnectionId(c[0].id);
    }).catch(() => null);
  }, [locked, runId]);

  if (!locked) return null;

  const codesComplete = CODE_FIELDS.every((f) => codes[f.key].trim().length > 0);

  const push = async () => {
    setConfirming(false);
    setStatus({ kind: 'working' });
    try {
      const res = await xero.pushJournals(runId, { connectionId, accountCodes: codes });
      setStatus({ kind: 'success', manualJournalId: res.manualJournalId, lines: res.lines });
    } catch (err: any) {
      setStatus({ kind: 'error', message: err.message || 'Push failed' });
    }
  };

  return (
    <div>
      <h4 className="text-xs font-semibold text-[#0A192F] mb-1">Push journals to Xero</h4>
      <p className="text-[11px] text-gray-500 mb-2">
        Posts the locked provision journals as a <span className="font-semibold">DRAFT</span> manual journal.
        Authorise inside Xero — TaxPro never auto-authorises. Codes are mapped explicitly, never guessed.
      </p>

      {status.kind === 'success' && (
        <div className="bg-[#E8F7F0] border border-[#10B981]/30 rounded-card p-2 text-[11px] text-[#0A192F] mb-2">
          Pushed {status.lines} lines — Xero ManualJournal <span className="font-mono">{status.manualJournalId}</span> (DRAFT).
        </div>
      )}
      {status.kind === 'error' && (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded-card p-2 text-[11px] mb-2">{status.message}</div>
      )}

      {connections.length === 0 ? (
        <p className="text-[11px] text-gray-500">No Xero connection — connect an organisation under Data Sources first.</p>
      ) : (
        <div className="space-y-2">
          <label className="block text-[11px] text-gray-600">
            Organisation
            <select value={connectionId} onChange={(e) => setConnectionId(e.target.value)} className="mt-0.5 block w-full text-xs border-gray-300 rounded py-1.5">
              <option value="">— Select —</option>
              {connections.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
            </select>
          </label>
          <div className="grid grid-cols-2 gap-2">
            {CODE_FIELDS.map((f) => (
              <label key={f.key} className="block text-[11px] text-gray-600">
                {f.label}
                <input
                  value={codes[f.key]}
                  onChange={(e) => setCodes({ ...codes, [f.key]: e.target.value })}
                  placeholder="e.g. 810"
                  className="mt-0.5 block w-full text-xs border-gray-300 rounded py-1.5 px-2 font-mono"
                />
              </label>
            ))}
          </div>
          <button
            onClick={() => setConfirming(true)}
            disabled={!connectionId || !codesComplete || status.kind === 'working'}
            className="px-3 py-1.5 bg-[#0A192F] text-white rounded-button text-xs font-medium hover:bg-[#112240] disabled:opacity-50 transition-colors"
          >
            {status.kind === 'working' ? 'Pushing…' : 'Push to Xero (DRAFT)'}
          </button>
        </div>
      )}

      {confirming && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
          <div className="bg-white rounded-card border border-gray-200 p-6 max-w-sm shadow-lg">
            <h4 className="text-sm font-semibold text-[#0A192F] mb-2">Push journals to Xero?</h4>
            <p className="text-xs text-gray-600 mb-4">
              This creates a <span className="font-semibold">DRAFT</span> manual journal in the selected
              organisation. Review and authorise it inside Xero. The push is recorded immutably on the run.
            </p>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setConfirming(false)} className="px-3 py-1.5 text-xs border border-gray-300 rounded-button hover:bg-gray-50">Cancel</button>
              <button onClick={push} className="px-3 py-1.5 text-xs bg-[#0A192F] text-white rounded-button hover:bg-[#112240]">Confirm push</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
