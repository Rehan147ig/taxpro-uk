import { useEffect, useState } from 'react';
import { useParams, Link } from '@tanstack/react-router';
import { provenance, journalExport } from '../api/client';

function shortId(id: string | null | undefined): string {
  return id ? `${id.slice(0, 8)}…` : '—';
}

const STATUS_COLORS: Record<string, string> = {
  draft: 'bg-gray-100 text-gray-700 border-gray-200',
  running: 'bg-amber-50 text-amber-800 border-amber-200',
  completed: 'bg-green-50 text-green-700 border-green-200',
  failed: 'bg-red-50 text-red-700 border-red-200',
  committed: 'bg-green-50 text-green-700 border-green-200',
  superseded: 'bg-gray-100 text-gray-400 border-gray-200',
};

function StatusBadge({ status }: { status?: string }) {
  if (!status) return null;
  const cls = STATUS_COLORS[status] ?? 'bg-gray-100 text-gray-600 border-gray-200';
  return (
    <span className={`inline-block px-2 py-0.5 rounded-full border text-[10px] font-semibold ${cls}`}>
      {status}
    </span>
  );
}

const fmt = (n: number | string | null | undefined) => {
  const v = Number(n ?? 0);
  if (Number.isNaN(v)) return '—';
  return new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP', minimumFractionDigits: 2 }).format(v);
};

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function Step({ title, meta, children }: { title: string; meta?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="bg-white rounded-card border border-gray-200 p-4 shadow-sm">
      <div className="flex items-center justify-between gap-2 mb-2">
        <h3 className="text-sm font-serif font-semibold text-[#0A192F] tracking-tight">{title}</h3>
        {meta}
      </div>
      {children}
    </div>
  );
}

export default function ProvenancePage() {
  const { resultId } = useParams({ from: '/provenance/$resultId' });
  const [prov, setProv] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        setProv(await provenance.result(resultId));
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to load provenance');
      }
    })();
  }, [resultId]);

  if (error) {
    return (
      <div className="bg-red-50 border border-red-200 text-red-700 rounded-card p-4 text-xs">
        {error}
      </div>
    );
  }
  if (!prov) {
    return (
      <div className="animate-pulse space-y-4">
        <div className="h-8 bg-gray-200 rounded w-72" />
        <div className="bg-gray-100 rounded-xl h-32" />
        <div className="grid grid-cols-2 gap-4">
          <div className="bg-gray-100 rounded-xl h-72" />
          <div className="bg-gray-100 rounded-xl h-72" />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-serif font-semibold text-[#0A192F] tracking-tight">Calculation provenance</h1>
          <p className="text-xs text-gray-500 mt-1">
            Why this number exists — every input, balance, agent and decision behind <span className="font-mono">{shortId(prov.result.id)}</span>.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={async () => {
              try {
                downloadBlob(await journalExport.jsonBlob(prov.result.id), `taxpro-journals-${prov.result.period || prov.result.id}.json`);
              } catch (e) {
                setError(e instanceof Error ? e.message : 'Journal export failed');
              }
            }}
            className="text-[10px] font-semibold bg-[#0A192F] text-white px-3 py-1.5 rounded-button hover:bg-[#112240]"
          >
            Download journal JSON
          </button>
          <button
            onClick={async () => {
              try {
                downloadBlob(await journalExport.csvBlob(prov.result.id), `taxpro-journals-${prov.result.period || prov.result.id}.csv`);
              } catch (e) {
                setError(e instanceof Error ? e.message : 'Journal export failed');
              }
            }}
            className="text-[10px] font-semibold border border-[#0A192F] text-[#0A192F] px-3 py-1.5 rounded-button hover:bg-[#F0F4FA]"
          >
            Download journal CSV
          </button>
        </div>
      </div>

      {/* Result summary */}
      <Step title="Provision result" meta={<StatusBadge status={prov.result.status} />}>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-center">
          <div className="bg-gray-50 rounded-card p-3">
            <div className="text-lg font-semibold text-[#0A192F]">{fmt(prov.result.currentTaxExpense)}</div>
            <div className="text-[10px] text-gray-500">Current tax expense</div>
          </div>
          <div className="bg-gray-50 rounded-card p-3">
            <div className="text-lg font-semibold text-[#0A192F]">{fmt(prov.result.deferredTaxExpense)}</div>
            <div className="text-[10px] text-gray-500">Deferred tax expense</div>
          </div>
          <div className="bg-gray-50 rounded-card p-3">
            <div className="text-lg font-semibold text-[#0A192F]">{fmt(prov.result.totalTaxExpense)}</div>
            <div className="text-[10px] text-gray-500">Total tax expense</div>
          </div>
          <div className="bg-gray-50 rounded-card p-3">
            <div className="text-lg font-semibold text-[#0A192F]">{fmt(prov.result.taxPayable)}</div>
            <div className="text-[10px] text-gray-500">Tax payable</div>
          </div>
        </div>
        <div className="mt-3 text-[10px] text-gray-500 grid grid-cols-2 md:grid-cols-4 gap-2">
          <span>Book income: <b className="text-[#0A192F]">{fmt(prov.result.bookIncome)}</b></span>
          <span>Effective rate: <b className="text-[#0A192F]">{prov.result.effectiveTaxRate != null ? `${Number(prov.result.effectiveTaxRate).toFixed(2)}%` : '—'}</b></span>
          <span>Period: <b className="text-[#0A192F]">{prov.result.period}</b></span>
          <span>Created: <b className="text-[#0A192F]">{prov.result.createdAt ? new Date(prov.result.createdAt).toLocaleString() : '—'}</b></span>
        </div>
      </Step>

      {/* Pipeline */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
        <Step title="Source documents" meta={<span className="text-[10px] text-gray-400">{prov.documents.length}</span>}>
          <div className="space-y-2">
            {prov.documents.length === 0 && <p className="text-[10px] text-gray-400">None linked</p>}
            {prov.documents.map((d: any) => (
              <div key={d.id} className="border border-gray-100 rounded-button p-2">
                <div className="text-xs font-medium text-[#0A192F]">{d.title ?? 'Untitled document'}</div>
                <div className="text-[10px] text-gray-400 font-mono">{shortId(d.id)} · {d.documentType ?? 'source'}</div>
              </div>
            ))}
          </div>
        </Step>

        <Step title="Import batches" meta={<span className="text-[10px] text-gray-400">{prov.batches.length}</span>}>
          <div className="space-y-2">
            {prov.batches.length === 0 && <p className="text-[10px] text-gray-400">None linked</p>}
            {prov.batches.map((b: any) => (
              <div key={b.id} className="border border-gray-100 rounded-button p-2 space-y-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-medium text-[#0A192F] truncate">{b.originalFilename}</span>
                  <StatusBadge status={b.status} />
                </div>
                <div className="text-[10px] text-gray-400 font-mono">{shortId(b.id)} · {b.sourceSystem} {b.sourceReference ? `· ${b.sourceReference}` : ''}</div>
                <div className="text-[10px] text-gray-400">{b.rowCount ?? 0} rows · checksum <span className="font-mono">{shortId(b.checksum)}</span></div>
              </div>
            ))}
          </div>
        </Step>

        <Step title="Account balances" meta={<span className="text-[10px] text-gray-400">{prov.calculatedFrom.length}</span>}>
          <div className="space-y-1">
            {prov.calculatedFrom.length === 0 && <p className="text-[10px] text-gray-400">No balances used</p>}
            {prov.calculatedFrom.map((a: any) => (
              <div key={a.id} className="flex justify-between gap-2 border-b border-gray-50 pb-1">
                <span className="text-[11px] text-[#0A192F]">{a.accountNumber} · {a.name}</span>
                <span className="text-[10px] text-gray-400 font-mono">{shortId(a.id)}</span>
              </div>
            ))}
          </div>
        </Step>

        <Step title="Provision run" meta={<StatusBadge status={prov.run.status} />}>
          <div className="space-y-1 text-[11px]">
            <div className="flex justify-between"><span className="text-gray-500">Mode</span><b className="text-[#0A192F]">{prov.run.mode}</b></div>
            <div className="flex justify-between"><span className="text-gray-500">Approval</span><b className="text-[#0A192F]">{prov.run.approvalStatus}</b></div>
            <div className="flex justify-between"><span className="text-gray-500">Engine</span><b className="text-[#0A192F] font-mono">{prov.run.engineVersion}</b></div>
            <div className="flex justify-between"><span className="text-gray-500">Input hash</span><b className="text-[#0A192F] font-mono">{shortId(prov.run.inputDataHash)}</b></div>
            <div className="flex justify-between"><span className="text-gray-500">Mapping hash</span><b className="text-[#0A192F] font-mono">{shortId(prov.run.mappingVersionHash)}</b></div>
            <div className="flex justify-between"><span className="text-gray-500">Created</span><b className="text-[#0A192F]">{prov.run.createdAt ? new Date(prov.run.createdAt).toLocaleString() : '—'}</b></div>
            <div className="mt-2">
              <p className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide">Rules used</p>
              <div className="flex flex-wrap gap-1 mt-1">
                {(prov.run.rulesUsed ?? []).map((r: string) => (
                  <span key={r} className="text-[9px] bg-[#F0F4FA] border border-[#D8E2F0] text-[#0A192F] px-1.5 py-0.5 rounded">{r}</span>
                ))}
              </div>
            </div>
            <div className="mt-2">
              <Link to="/runs/$runId" params={{ runId: prov.run.id }} className="text-[10px] font-semibold text-[#0A192F] hover:underline">
                Open run detail →
              </Link>
            </div>
          </div>
        </Step>
      </div>

      {/* Agent activity */}
      <Step title="Agent activity" meta={<span className="text-[10px] text-gray-400">{prov.agentEvents.length} events</span>}>
        {prov.agentEvents.length === 0 && <p className="text-[10px] text-gray-400">No agent events recorded for this run.</p>}
        <div className="max-h-56 overflow-auto divide-y divide-gray-100 border border-gray-200 rounded-card">
          {prov.agentEvents.map((e: any) => (
            <div key={e.id} className="px-3 py-2 flex justify-between items-center gap-2">
              <div>
                <span className="text-[11px] font-semibold text-[#0A192F]">{e.eventType}</span>
                <span className="text-[10px] text-gray-400 ml-2">by {e.sourceAgent}</span>
              </div>
              <span className="text-[10px] text-gray-400">{e.occurredAt ? new Date(e.occurredAt).toLocaleString() : ''}</span>
            </div>
          ))}
        </div>
      </Step>

      {/* Adjustments */}
      <Step title="Manual adjustments" meta={<span className="text-[10px] text-gray-400">{prov.adjustments.length}</span>}>
        {prov.adjustments.length === 0 && <p className="text-[10px] text-gray-400">None recorded for this run.</p>}
        <div className="divide-y divide-gray-100 border border-gray-200 rounded-card">
          {prov.adjustments.map((a: any) => (
            <div key={a.id} className="px-3 py-2 flex justify-between items-center gap-2">
              <div>
                <span className="text-[11px] font-semibold text-[#0A192F]">{a.adjustmentType}</span>
                <span className="text-[10px] text-gray-400 ml-2">{a.reason}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="font-mono text-[11px] text-[#0A192F]">{fmt(a.amount)}</span>
                <StatusBadge status={a.status} />
              </div>
            </div>
          ))}
        </div>
      </Step>

      {/* Lineage edges */}
      <Step title="Knowledge graph edges" meta={<span className="text-[10px] text-gray-400">{prov.edges.length}</span>}>
        {prov.edges.length === 0 && <p className="text-[10px] text-gray-400">No lineage edges recorded.</p>}
        <div className="max-h-40 overflow-auto divide-y divide-gray-100 border border-gray-200 rounded-card">
          {prov.edges.map((e: any, i: number) => (
            <div key={i} className="px-3 py-1.5 text-[10px] font-mono flex justify-between gap-2">
              <span className="text-gray-500">{e.sourceKind}:{shortId(e.sourceId)} → {e.targetKind}:{shortId(e.targetId)}</span>
              <span className="text-[#0A192F] font-semibold">{e.relation}</span>
            </div>
          ))}
        </div>
      </Step>
    </div>
  );
}
