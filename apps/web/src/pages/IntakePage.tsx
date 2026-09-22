import { useEffect, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { intake, provision, periods, config as featureFlags, reviewItems as reviewApi } from '../api/client';

// Canonical intake fields for the XLSX column-map editor (mirrors
// CANONICAL_FIELDS in apps/api/src/modules/intake/xlsx.ts).
const CANONICAL_FIELDS = [
  'accountName', 'accountNumber', 'accountType', 'debit', 'credit', 'balance',
  'period', 'periodEnd', 'currency', 'entityName', 'entityExternalId',
  'accountExternalId', 'detailType',
];

const BATCH_STATUS_COLORS: Record<string, string> = {
  draft: 'bg-gray-100 text-gray-700 border-gray-200',
  validating: 'bg-amber-50 text-amber-800 border-amber-200',
  ready_for_review: 'bg-blue-50 text-blue-800 border-blue-200',
  committed: 'bg-green-50 text-green-700 border-green-200',
  failed: 'bg-red-50 text-red-700 border-red-200',
  superseded: 'bg-gray-100 text-gray-400 border-gray-200',
};

const SUGGESTION_STATUS_COLORS: Record<string, string> = {
  pending: 'bg-amber-50 text-amber-800 border-amber-200',
  accepted: 'bg-green-50 text-green-700 border-green-200',
  rejected: 'bg-red-50 text-red-700 border-red-200',
  overridden: 'bg-purple-50 text-purple-700 border-purple-200',
  applied: 'bg-green-100 text-green-800 border-green-300',
};

const ADJUSTMENT_STATUS_COLORS: Record<string, string> = {
  pending: 'bg-amber-50 text-amber-800 border-amber-200',
  approved: 'bg-green-50 text-green-700 border-green-200',
  rejected: 'bg-red-50 text-red-700 border-red-200',
};

function shortId(id: string | null | undefined): string {
  return id ? `${id.slice(0, 8)}…` : '—';
}

function StatusBadge({ status, map }: { status: string; map: Record<string, string> }) {
  const cls = map[status] ?? 'bg-gray-100 text-gray-600 border-gray-200';
  return (
    <span className={`inline-block px-2 py-0.5 rounded-full border text-[10px] font-semibold ${cls}`}>
      {status}
    </span>
  );
}

export default function IntakePage() {
  const [entities, setEntities] = useState<any[]>([]);
  const [accountingPeriods, setAccountingPeriods] = useState<any[]>([]);
  const [batches, setBatches] = useState<any[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [batchDetail, setBatchDetail] = useState<{ batch: any; events: any[]; rowStats: any } | null>(null);
  const [errorRows, setErrorRows] = useState<any[]>([]);
  const [suggestions, setSuggestions] = useState<any[]>([]);
  const [adjustments, setAdjustments] = useState<any[]>([]);

  const [entityId, setEntityId] = useState('');
  const [accountingPeriodId, setAccountingPeriodId] = useState('');
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [working, setWorking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Adjustment review modal state
  const [reviewTarget, setReviewTarget] = useState<{ id: string; decision: 'approved' | 'rejected' } | null>(null);
  const [reviewReason, setReviewReason] = useState('');

  // Feature flags for the messy-data hardening pass (all default off).
  const [flags, setFlags] = useState<Record<string, boolean> | null>(null);

  // Feature 1 — XLSX upload → preview → column-map state.
  const [xlsxPreview, setXlsxPreview] = useState<{
    uploadId: string; sheets: string[]; previews: any[]; suggestedColumnMaps: Record<string, any>;
  } | null>(null);
  const [xlsxSheet, setXlsxSheet] = useState('');
  const [xlsxHeaderRow, setXlsxHeaderRow] = useState<number | null>(null);
  const [xlsxMap, setXlsxMap] = useState<Record<string, string>>({});

  // Features 2–3 — per-batch deterministic check reports + bridge items.
  const [signReport, setSignReport] = useState<any | null>(null);
  const [bridgeReport, setBridgeReport] = useState<{ priorRunId: string | null; result: any } | null>(null);
  const [bridgeItems, setBridgeItems] = useState<any[]>([]);
  const [decisionReason, setDecisionReason] = useState('');

  const load = async () => {
    const [batchRes, adjRes] = await Promise.all([
      intake.batches(),
      intake.adjustments().catch(() => ({ adjustments: [] })),
    ]);
    setBatches(batchRes.batches);
    setAdjustments(adjRes.adjustments);
  };

  useEffect(() => {
    (async () => {
      try {
        const [ents, aps] = await Promise.all([
          provision.entities(),
          periods.accounting(),
        ]);
        featureFlags.flags().then(setFlags).catch(() => setFlags({}));
        setEntities(ents);
        setAccountingPeriods(aps);
        const uk = ents.find((e: any) => ['UK_FRS102', 'UK_FRS102_S29', 'UK'].includes(e.taxJurisdiction ?? ''));
        if (uk) setEntityId(uk.id);
        if (aps.length > 0) setAccountingPeriodId(aps[0].id);
        await load();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to load intake workspace');
      }
    })();
  }, []);

  const uploadFile = async (file: File) => {
    if (!entityId || !accountingPeriodId) {
      setError('Select an entity and accounting period before uploading.');
      return;
    }
    if (!file.name.toLowerCase().endsWith('.csv')) {
      setError(`Unsupported file type: ${file.name}. Intake accepts CSV files.`);
      return;
    }
    setUploading(true);
    setError(null);
    setNotice(null);
    try {
      const res = await intake.upload(file, entityId, accountingPeriodId);
      setNotice(res.duplicate
        ? `Duplicate upload detected — returned existing batch ${shortId(res.batch?.id)} without creating evidence.`
        : `Batch ${shortId(res.batch?.id)} uploaded: ${res.batch?.rowCount ?? '?'} rows parsed, status ${res.batch?.status}.`);
      await load();
      if (res.batch?.id) await selectBatch(res.batch.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  };

  const selectBatch = async (id: string) => {
    setSelectedId(id);
    setError(null);
    setSignReport(null);
    setBridgeReport(null);
    setBridgeItems([]);
    try {
      const [detail, rows, sugg] = await Promise.all([
        intake.batch(id),
        intake.rows(id),
        intake.suggestions(id),
      ]);
      setBatchDetail(detail);
      setErrorRows(rows.rows.filter((r: any) => r.status === 'error' || r.status === 'warning'));
      setSuggestions(sugg.suggestions);
      await loadMessyData(id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load batch');
    }
  };

  // Deterministic intake checks (Features 2–3). Each fetch is best-effort:
  // a 403 means the flag is off and the panel simply stays hidden.
  const loadMessyData = async (id: string) => {
    const [sign, bridge, items] = await Promise.all([
      intake.signReport(id).catch(() => null),
      intake.bridgeReport(id).catch(() => null),
      reviewApi.list().catch(() => [] as any[]),
    ]);
    if (sign) setSignReport(sign.report);
    if (bridge) setBridgeReport({ priorRunId: bridge.priorRunId, result: bridge.result });
    if (Array.isArray(items)) {
      setBridgeItems(items.filter((i: any) => i.sourceRef === `import_batch:${id}`));
    }
  };

  const decideSign = (decision: 'confirm' | 'reject') =>
    runAction(`sign-${decision}`, async () => {
      if (!selectedId) return;
      if (decision === 'confirm') await intake.signConfirm(selectedId, decisionReason || undefined);
      else await intake.signReject(selectedId, decisionReason || undefined);
      setDecisionReason('');
      await loadMessyData(selectedId);
    }, `Sign inversion ${decision} recorded by reviewer.`);

  const resolveBridgeItem = (itemId: string) =>
    runAction(`bridge-${itemId}`, async () => {
      if (!selectedId) return;
      if (!decisionReason.trim()) throw new Error('A resolution reason is required.');
      await intake.bridgeResolveItem(selectedId, itemId, decisionReason.trim());
      setDecisionReason('');
      await loadMessyData(selectedId);
    }, 'Bridge item resolved with reason.');

  const uploadXlsx = async (file: File) => {
    const lower = file.name.toLowerCase();
    if (!lower.endsWith('.xlsx') && !lower.endsWith('.xlsm')) {
      setError(`Unsupported file type: ${file.name}. XLSX ingest accepts .xlsx and .xlsm only.`);
      return;
    }
    setUploading(true);
    setError(null);
    setNotice(null);
    try {
      const preview = await intake.xlsxUpload(file);
      setXlsxPreview(preview);
      const firstSheet = preview.sheets[0] ?? '';
      setXlsxSheet(firstSheet);
      const firstPreview = preview.previews.find((p: any) => p.name === firstSheet);
      const headerRow = firstPreview?.headerCandidates?.[0] ?? 1;
      setXlsxHeaderRow(headerRow);
      const headerCells: string[] =
        firstPreview?.firstRows?.find((r: any) => r.rowNumber === headerRow)?.cells ?? [];
      const suggested = preview.suggestedColumnMaps?.[firstSheet] as Record<string, string> | null;
      const draft: Record<string, string> = {};
      for (const canonical of CANONICAL_FIELDS) {
        if (suggested) {
          const userCol = Object.keys(suggested).find((k) => suggested[k] === canonical);
          if (userCol && headerCells.includes(userCol)) draft[canonical] = userCol;
        }
        if (!draft[canonical]) {
          const guess = headerCells.find((h) => h.toLowerCase().replace(/[\s_-]/g, '') === canonical.toLowerCase());
          if (guess) draft[canonical] = guess;
        }
      }
      setXlsxMap(draft);
      setNotice(`Workbook parsed: ${preview.sheets.length} sheet(s). Pick the TB sheet, confirm the header row, map columns, then create the batch.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'XLSX upload failed');
    } finally {
      setUploading(false);
    }
  };

  const pickXlsxSheet = (sheet: string) => {
    setXlsxSheet(sheet);
    const preview = xlsxPreview?.previews.find((p: any) => p.name === sheet);
    const headerRow = preview?.headerCandidates?.[0] ?? 1;
    setXlsxHeaderRow(headerRow);
    setXlsxMap({});
  };

  const createXlsxBatch = async () => {
    if (!xlsxPreview || !xlsxSheet || !xlsxHeaderRow) {
      setError('Upload a workbook and pick a sheet and header row first.');
      return;
    }
    if (!entityId || !accountingPeriodId) {
      setError('Select an entity and accounting period before creating the batch.');
      return;
    }
    const columnMap: Record<string, string> = {};
    for (const [canonical, userCol] of Object.entries(xlsxMap)) {
      if (userCol) columnMap[userCol] = canonical;
    }
    await runAction('xlsx-map', async () => {
      const res = await intake.xlsxColumnMap({
        uploadId: xlsxPreview.uploadId,
        sheetName: xlsxSheet,
        headerRow: xlsxHeaderRow,
        columnMap,
        entityId,
        accountingPeriodId,
      });
      setXlsxPreview(null);
      if (res.batch?.id) await selectBatch(res.batch.id);
      return res;
    }, `XLSX batch created from sheet "${xlsxSheet}" — column map remembered for this client layout.`);
  };

  const runAction = async (key: string, fn: () => Promise<any>, successMsg?: string) => {
    setWorking(key);
    setError(null);
    setNotice(null);
    try {
      await fn();
      if (successMsg) setNotice(successMsg);
      await load();
      if (selectedId) await selectBatch(selectedId);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Action failed');
    } finally {
      setWorking(null);
    }
  };

  const decideSuggestion = (s: any, decision: 'accept' | 'reject') =>
    runAction(`suggest-${s.id}`,
      () => intake.decideSuggestion(s.id, { decision }),
      `Suggestion ${decision} recorded — tax memory updated.`);

  const submitReview = async () => {
    if (!reviewTarget) return;
    await runAction(`adjust-${reviewTarget.id}`,
      () => reviewTarget.decision === 'approved'
        ? intake.approveAdjustment(reviewTarget.id, reviewReason || undefined)
        : intake.rejectAdjustment(reviewTarget.id, reviewReason || undefined),
      `Adjustment ${reviewTarget.decision} with learning signal emitted.`);
    setReviewTarget(null);
    setReviewReason('');
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-serif font-semibold text-[#0A192F] tracking-tight">Data Intake</h1>
          <p className="text-xs text-gray-500 mt-1">
            Upload trial balance CSVs → validate → review AI suggestions → commit. Every upload becomes persisted evidence.
          </p>
        </div>
        <Link to="/workbench" className="text-xs text-[#0A192F] font-semibold hover:underline">Workbench →</Link>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded-card p-3 text-xs">{error}</div>
      )}
      {notice && (
        <div className="bg-green-50 border border-green-200 text-green-800 rounded-card p-3 text-xs">{notice}</div>
      )}

      {/* Uploader */}
      <div className="bg-white rounded-card border border-gray-200 p-4 shadow-sm space-y-3">
        <div className="flex flex-wrap gap-4 items-end">
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide">Entity</span>
            <select value={entityId} onChange={(e) => setEntityId(e.target.value)}
              className="border border-gray-200 rounded-button px-2 py-1.5 text-xs bg-white min-w-52">
              {entities.map((e: any) => (
                <option key={e.id} value={e.id}>{e.name} ({e.taxJurisdiction ?? 'no jurisdiction'})</option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide">Accounting period</span>
            <select value={accountingPeriodId} onChange={(e) => setAccountingPeriodId(e.target.value)}
              className="border border-gray-200 rounded-button px-2 py-1.5 text-xs bg-white min-w-52">
              {accountingPeriods.map((p: any) => (
                <option key={p.id} value={p.id}>{p.name} ({p.startDate} → {p.endDate})</option>
              ))}
            </select>
          </label>
        </div>

        <div
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            const file = e.dataTransfer.files?.[0];
            if (file) uploadFile(file);
          }}
          className={`border-2 border-dashed rounded-card p-8 text-center transition-colors ${
            dragging ? 'border-[#0A192F] bg-[#F0F4FA]' : 'border-gray-300 bg-gray-50'
          }`}
        >
          <p className="text-sm font-medium text-[#0A192F]">
            {uploading ? 'Uploading…' : 'Drag & drop a trial balance CSV here'}
          </p>
          <p className="text-[10px] text-gray-500 mt-1">CSV only, up to 25 MB · duplicate files are detected by checksum</p>
          <label className="mt-3 inline-block">
            <input type="file" accept=".csv" className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadFile(f); e.target.value = ''; }} />
            <span className="text-xs font-semibold bg-[#0A192F] text-white px-4 py-2 rounded-button cursor-pointer hover:bg-[#112240]">
              Browse files
            </span>
          </label>
        </div>
      </div>

      {/* Feature 1 — XLSX ingest with column mapping (behind INTAKE_XLSX) */}
      {flags?.INTAKE_XLSX && (
        <div className="bg-white rounded-card border border-gray-200 p-4 shadow-sm space-y-3">
          <div>
            <h3 className="text-base font-serif font-semibold text-[#0A192F] tracking-tight">Excel trial balance</h3>
            <p className="text-[10px] text-gray-500">XLSX/XLSM up to 20 MB · merged headers, offset header rows and junk sheets handled · map remembered per client layout</p>
          </div>
          <label className="inline-block">
            <input type="file" accept=".xlsx,.xlsm" className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadXlsx(f); e.target.value = ''; }} />
            <span className="text-xs font-semibold bg-[#0A192F] text-white px-4 py-2 rounded-button cursor-pointer hover:bg-[#112240]">
              {uploading ? 'Parsing…' : 'Upload Excel workbook'}
            </span>
          </label>
          {xlsxPreview && (
            <div className="space-y-3 border-t border-gray-100 pt-3">
              <div className="flex flex-wrap gap-4 items-end">
                <label className="flex flex-col gap-1 text-xs">
                  <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide">Sheet ({xlsxPreview.sheets.length})</span>
                  <select value={xlsxSheet} onChange={(e) => pickXlsxSheet(e.target.value)}
                    className="border border-gray-200 rounded-button px-2 py-1.5 text-xs bg-white min-w-52">
                    {xlsxPreview.sheets.map((s: string) => <option key={s} value={s}>{s}</option>)}
                  </select>
                </label>
                <label className="flex flex-col gap-1 text-xs">
                  <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide">Header row</span>
                  <select value={xlsxHeaderRow ?? ''} onChange={(e) => setXlsxHeaderRow(Number(e.target.value))}
                    className="border border-gray-200 rounded-button px-2 py-1.5 text-xs bg-white">
                    {(xlsxPreview.previews.find((p: any) => p.name === xlsxSheet)?.headerCandidates ?? [1]).map((r: number) => (
                      <option key={r} value={r}>Row {r}</option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
                {CANONICAL_FIELDS.map((canonical) => {
                  const headerCells: string[] =
                    xlsxPreview.previews.find((p: any) => p.name === xlsxSheet)?.firstRows
                      ?.find((r: any) => r.rowNumber === xlsxHeaderRow)?.cells ?? [];
                  const required = ['accountName', 'accountType', 'period'].includes(canonical);
                  return (
                    <label key={canonical} className="flex flex-col gap-1 text-xs">
                      <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide">
                        {canonical}{required ? ' *' : ''}
                      </span>
                      <select value={xlsxMap[canonical] ?? ''} onChange={(e) => setXlsxMap({ ...xlsxMap, [canonical]: e.target.value })}
                        className="border border-gray-200 rounded-button px-2 py-1.5 text-xs bg-white">
                        <option value="">— ignore —</option>
                        {headerCells.map((h: string, i: number) => (
                          <option key={`${i}-${h}`} value={h}>{h || `(empty col ${i + 1})`}</option>
                        ))}
                      </select>
                    </label>
                  );
                })}
              </div>
              <button onClick={createXlsxBatch} disabled={working !== null}
                className="text-[10px] font-semibold bg-green-700 text-white px-3 py-1.5 rounded-button disabled:opacity-50">
                {working === 'xlsx-map' ? 'Creating…' : 'Create import batch from sheet'}
              </button>
            </div>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Batch queue */}
        <div className="bg-white rounded-card border border-gray-200 overflow-hidden shadow-sm">
          <div className="px-4 py-3 border-b border-gray-200 flex justify-between items-center">
            <h3 className="text-base font-serif font-semibold text-[#0A192F] tracking-tight">Batch queue</h3>
            <button onClick={() => load()} className="text-[10px] text-[#0A192F] font-semibold hover:underline">Refresh</button>
          </div>
          <table className="w-full text-xs">
            <thead className="bg-[#F8F9FA] border-b border-gray-200">
              <tr>
                <th className="text-left px-3 py-2 font-semibold text-[#0A192F]">File</th>
                <th className="text-left px-3 py-2 font-semibold text-[#0A192F]">Rows</th>
                <th className="text-left px-3 py-2 font-semibold text-[#0A192F]">Status</th>
                <th className="text-left px-3 py-2 font-semibold text-[#0A192F]">Created</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {batches.length === 0 && (
                <tr><td colSpan={4} className="px-3 py-4 text-gray-400 text-center">No batches yet. Upload a CSV above.</td></tr>
              )}
              {batches.map((b: any) => (
                <tr key={b.id} onClick={() => selectBatch(b.id)}
                  className={`cursor-pointer transition-colors ${selectedId === b.id ? 'bg-[#F0F4FA]' : 'hover:bg-[#F8F9FA]'}`}>
                  <td className="px-3 py-2.5">
                    <div className="font-medium text-[#0A192F]">{b.originalFilename}</div>
                    <div className="text-[10px] text-gray-400 font-mono">{shortId(b.id)} · {b.sourceType}</div>
                  </td>
                  <td className="px-3 py-2.5 text-gray-600">{b.rowCount ?? 0}</td>
                  <td className="px-3 py-2.5"><StatusBadge status={b.status} map={BATCH_STATUS_COLORS} /></td>
                  <td className="px-3 py-2.5 text-gray-500">{b.createdAt ? new Date(b.createdAt).toLocaleString() : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Selected batch */}
        <div className="bg-white rounded-card border border-gray-200 shadow-sm p-4 space-y-4">
          <h3 className="text-base font-serif font-semibold text-[#0A192F] tracking-tight">Batch detail</h3>
          {!batchDetail && <p className="text-xs text-gray-400">Select a batch to inspect validation errors, suggestions and evidence.</p>}
          {batchDetail && (
            <>
              <div className="grid grid-cols-4 gap-2 text-center">
                <div className="bg-gray-50 rounded-card p-2"><div className="text-lg font-semibold text-[#0A192F]">{batchDetail.rowStats.total}</div><div className="text-[10px] text-gray-500">rows</div></div>
                <div className="bg-green-50 rounded-card p-2"><div className="text-lg font-semibold text-green-700">{batchDetail.rowStats.ok}</div><div className="text-[10px] text-gray-500">ok</div></div>
                <div className="bg-amber-50 rounded-card p-2"><div className="text-lg font-semibold text-amber-700">{batchDetail.rowStats.warnings}</div><div className="text-[10px] text-gray-500">warnings</div></div>
                <div className="bg-red-50 rounded-card p-2"><div className="text-lg font-semibold text-red-700">{batchDetail.rowStats.errors}</div><div className="text-[10px] text-gray-500">errors</div></div>
              </div>

              <div className="flex flex-wrap gap-2">
                <StatusBadge status={batchDetail.batch.status} map={BATCH_STATUS_COLORS} />
                <span className="text-[10px] text-gray-500 font-mono">{shortId(batchDetail.batch.id)}</span>
                {batchDetail.batch.storageKey && (
                  <span className="text-[10px] text-gray-400 font-mono">evidence {shortId(batchDetail.batch.storageKey)}</span>
                )}
              </div>

              {errorRows.length > 0 && (
                <div className="border border-red-200 rounded-card overflow-hidden">
                  <div className="px-3 py-2 bg-red-50 text-red-700 text-[10px] font-semibold">
                    {errorRows.length} validation problem(s) — fix the source file and re-upload before committing
                  </div>
                  <div className="max-h-40 overflow-auto divide-y divide-gray-100">
                    {errorRows.map((r: any) => (
                      <div key={r.id} className="px-3 py-2 text-[11px] flex justify-between gap-2">
                        <span className="text-gray-600">Row {r.rowNumber}</span>
                        <span className="font-mono text-red-700 text-[10px] break-all">
                          {Array.isArray(r.validation?.codes) ? r.validation.codes.join(', ') : r.status}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Feature 2 — sign-convention check (behind INTAKE_SIGN_CONVENTION) */}
              {flags?.INTAKE_SIGN_CONVENTION && signReport && (
                <div className={`border rounded-card overflow-hidden ${signReport.classification === 'standard' ? 'border-green-200' : signReport.classification === 'inverted' ? 'border-red-300' : 'border-amber-200'}`}>
                  <div className={`px-3 py-2 text-[10px] font-semibold ${signReport.classification === 'standard' ? 'bg-green-50 text-green-700' : signReport.classification === 'inverted' ? 'bg-red-50 text-red-700' : 'bg-amber-50 text-amber-800'}`}>
                    Sign convention: {signReport.classification} ({signReport.code})
                  </div>
                  <div className="px-3 py-2">
                    <table className="w-full text-[11px]">
                      <thead>
                        <tr className="text-left text-gray-400">
                          <th className="py-1 font-semibold">Type</th>
                          <th className="py-1 font-semibold">Total</th>
                          <th className="py-1 font-semibold">Expected</th>
                          <th className="py-1 font-semibold">Observed</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100">
                        {(signReport.totals ?? []).map((t: any) => (
                          <tr key={t.accountType} className={t.inverted ? 'text-red-700 font-semibold' : 'text-gray-600'}>
                            <td className="py-1">{t.accountType}</td>
                            <td className="py-1 font-mono">{t.total}</td>
                            <td className="py-1">{t.expected}</td>
                            <td className="py-1">{t.observed}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {signReport.classification === 'inverted' && (
                      <div className="flex flex-wrap items-center gap-2 mt-2">
                        <input value={decisionReason} onChange={(e) => setDecisionReason(e.target.value)}
                          placeholder="Reviewer reason (recommended)" maxLength={500}
                          className="flex-1 min-w-40 border border-gray-200 rounded-button px-2 py-1.5 text-[11px]" />
                        <button onClick={() => decideSign('confirm')} disabled={working !== null}
                          className="text-[10px] font-semibold bg-green-700 text-white px-3 py-1.5 rounded-button disabled:opacity-50">
                          Confirm inversion (× −1 on commit)
                        </button>
                        <button onClick={() => decideSign('reject')} disabled={working !== null}
                          className="text-[10px] bg-red-50 text-red-700 border border-red-200 px-3 py-1.5 rounded-button disabled:opacity-50">
                          Reject (fix source file)
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Feature 3 — prior-period bridge (behind INTAKE_PRIOR_BRIDGE) */}
              {flags?.INTAKE_PRIOR_BRIDGE && bridgeReport && (
                <div className="border border-gray-200 rounded-card overflow-hidden">
                  <div className="px-3 py-2 bg-[#F8F9FA] text-[10px] font-semibold text-[#0A192F]">
                    Prior-period bridge: {bridgeReport.priorRunId ? 'prior locked run found' : 'first period — no prior locked run'}
                    {bridgeReport.priorRunId && (
                      <span className="ml-2 text-gray-500 font-normal">
                        new {bridgeReport.result.newAccounts?.length ?? 0} · missing {bridgeReport.result.missingAccounts?.length ?? 0} · renames {bridgeReport.result.renames?.length ?? 0} · mismatches {bridgeReport.result.mismatches?.length ?? 0}
                      </span>
                    )}
                  </div>
                  {(bridgeReport.result.renames ?? []).length > 0 && (
                    <div className="px-3 py-2 border-t border-gray-100">
                      <p className="text-[10px] font-semibold text-amber-800 uppercase tracking-wide mb-1">Possible renames (carry-forward proposed — accept in Proposals)</p>
                      {(bridgeReport.result.renames ?? []).map((r: any, i: number) => (
                        <div key={i} className="text-[11px] text-gray-600">
                          “{r.prior.name}” → “{r.current.name}” · similarity {Math.round((r.similarity ?? 0) * 100)}%
                          {r.prior.mapping ? ` · carries ${r.prior.mapping.taxAccountType}` : ' · no prior mapping'}
                        </div>
                      ))}
                    </div>
                  )}
                  {(bridgeReport.result.mismatches ?? []).length > 0 && (
                    <div className="px-3 py-2 border-t border-gray-100">
                      <p className="text-[10px] font-semibold text-red-700 uppercase tracking-wide mb-1">Opening-balance mismatches (block commit until resolved)</p>
                      {(bridgeReport.result.mismatches ?? []).map((m: any, i: number) => (
                        <div key={i} className="text-[11px] text-gray-600 font-mono">
                          {m.current.name}: prior {m.priorClosing} vs import {m.currentOpening} (Δ £{m.delta})
                        </div>
                      ))}
                    </div>
                  )}
                  {bridgeItems.length > 0 && (
                    <div className="px-3 py-2 border-t border-gray-100 space-y-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <input value={decisionReason} onChange={(e) => setDecisionReason(e.target.value)}
                          placeholder="Resolution reason (required)" maxLength={2000}
                          className="flex-1 min-w-40 border border-gray-200 rounded-button px-2 py-1.5 text-[11px]" />
                      </div>
                      {bridgeItems.filter((i: any) => !['resolved', 'rejected', 'waived'].includes(i.status)).map((i: any) => (
                        <div key={i.id} className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
                          <span className="text-gray-600">
                            <span className="font-mono font-semibold text-[#0A192F]">{i.itemType}</span> · {i.status}
                          </span>
                          <button onClick={() => resolveBridgeItem(i.id)} disabled={working !== null}
                            className="text-[10px] bg-[#0A192F] text-white px-3 py-1 rounded-button disabled:opacity-50">
                            Resolve with reason
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              <div className="flex flex-wrap gap-2">
                <button
                  onClick={() => runAction('suggest', () => intake.generateSuggestions(batchDetail.batch.id), 'Suggestions generated (tax memory + rules + advisory AI).')}
                  disabled={working !== null || batchDetail.batch.status === 'committed' || batchDetail.batch.status === 'failed'}
                  className="text-[10px] font-semibold bg-[#0A192F] text-white px-3 py-1.5 rounded-button disabled:opacity-50"
                >
                  {working === 'suggest' ? 'Generating…' : 'Generate mapping suggestions'}
                </button>
                <button
                  onClick={() => runAction('commit', () => intake.commit(batchDetail.batch.id), 'Batch committed — accounts, trial balance and lineage written.')}
                  disabled={working !== null || batchDetail.batch.status !== 'ready_for_review'}
                  className="text-[10px] font-semibold bg-green-700 text-white px-3 py-1.5 rounded-button disabled:opacity-50"
                >
                  {working === 'commit' ? 'Committing…' : 'Commit batch'}
                </button>
              </div>

              {batchDetail.events.length > 0 && (
                <div>
                  <p className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide mb-1">Batch ledger</p>
                  <div className="max-h-28 overflow-auto divide-y divide-gray-100 border border-gray-200 rounded-card">
                    {batchDetail.events.map((ev: any) => (
                      <div key={ev.id} className="px-3 py-1.5 text-[10px] flex justify-between gap-2">
                        <span className="font-semibold text-[#0A192F]">{ev.eventType}</span>
                        <span className="text-gray-400">{ev.occurredAt ? new Date(ev.occurredAt).toLocaleString() : ''}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* Mapping proposal review */}
      <div className="bg-white rounded-card border border-gray-200 overflow-hidden shadow-sm">
        <div className="px-4 py-3 border-b border-gray-200">
          <h3 className="text-base font-serif font-semibold text-[#0A192F] tracking-tight">Mapping proposal review</h3>
          <p className="text-[10px] text-gray-500">AI and tax memory propose — humans decide. Accepted decisions become tax memory precedents.</p>
        </div>
        {!selectedId && <div className="px-4 py-4 text-xs text-gray-400">Select a batch to review its mapping proposals.</div>}
        {selectedId && suggestions.length === 0 && (
          <div className="px-4 py-4 text-xs text-gray-400">No suggestions yet for this batch — generate them above.</div>
        )}
        {suggestions.length > 0 && (
          <table className="w-full text-xs">
            <thead className="bg-[#F8F9FA] border-b border-gray-200">
              <tr>
                <th className="text-left px-3 py-2 font-semibold text-[#0A192F]">Account</th>
                <th className="text-left px-3 py-2 font-semibold text-[#0A192F]">Proposed treatment</th>
                <th className="text-left px-3 py-2 font-semibold text-[#0A192F]">Confidence</th>
                <th className="text-left px-3 py-2 font-semibold text-[#0A192F]">Source</th>
                <th className="text-left px-3 py-2 font-semibold text-[#0A192F]">Status</th>
                <th className="text-left px-3 py-2 font-semibold text-[#0A192F]">Review</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {suggestions.map((s: any) => (
                <tr key={s.id} className="hover:bg-[#F8F9FA]">
                  <td className="px-3 py-2.5">
                    <div className="font-medium text-[#0A192F]">{s.citedAccountName ?? s.accountId}</div>
                    <div className="text-[10px] text-gray-400 font-mono">{shortId(s.accountId)}</div>
                  </td>
                  <td className="px-3 py-2.5">
                    <div className="text-[#0A192F]">{s.suggestedTaxAccountType}</div>
                    <div className="text-[10px] text-gray-500">{s.bookTreatment}{s.timingCategory ? ` · ${s.timingCategory}` : ''}</div>
                    {s.rationale && <div className="text-[10px] text-gray-400 max-w-xs truncate" title={s.rationale}>{s.rationale}</div>}
                  </td>
                  <td className="px-3 py-2.5 text-gray-600">{s.confidenceScore != null ? `${Number(s.confidenceScore).toFixed(2)}` : '—'}</td>
                  <td className="px-3 py-2.5 text-gray-500">{s.source}</td>
                  <td className="px-3 py-2.5"><StatusBadge status={s.status} map={SUGGESTION_STATUS_COLORS} /></td>
                  <td className="px-3 py-2.5">
                    {s.status === 'pending' ? (
                      <div className="flex gap-1.5">
                        <button
                          onClick={() => decideSuggestion(s, 'accept')}
                          disabled={working !== null}
                          className="text-[10px] bg-green-50 text-green-700 border border-green-200 px-2.5 py-1 rounded-button hover:bg-green-100 disabled:opacity-50"
                        >
                          {working === `suggest-${s.id}` ? '…' : 'Accept'}
                        </button>
                        <button
                          onClick={() => decideSuggestion(s, 'reject')}
                          disabled={working !== null}
                          className="text-[10px] bg-red-50 text-red-700 border border-red-200 px-2.5 py-1 rounded-button hover:bg-red-100 disabled:opacity-50"
                        >
                          Reject
                        </button>
                      </div>
                    ) : (
                      <span className="text-[10px] text-gray-400">{s.decidedAt ? new Date(s.decidedAt).toLocaleDateString() : ''}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Adjustment review dashboard */}
      <div className="bg-white rounded-card border border-gray-200 overflow-hidden shadow-sm">
        <div className="px-4 py-3 border-b border-gray-200">
          <h3 className="text-base font-serif font-semibold text-[#0A192F] tracking-tight">Manual adjustments</h3>
          <p className="text-[10px] text-gray-500">
            Reviewer-only lifecycle: approve or reject with a reason. Decisions emit learning signals into tax memory.
          </p>
        </div>
        {adjustments.length === 0 && <div className="px-4 py-4 text-xs text-gray-400">No manual adjustments recorded.</div>}
        {adjustments.length > 0 && (
          <table className="w-full text-xs">
            <thead className="bg-[#F8F9FA] border-b border-gray-200">
              <tr>
                <th className="text-left px-3 py-2 font-semibold text-[#0A192F]">Type</th>
                <th className="text-left px-3 py-2 font-semibold text-[#0A192F]">Amount</th>
                <th className="text-left px-3 py-2 font-semibold text-[#0A192F]">Reason</th>
                <th className="text-left px-3 py-2 font-semibold text-[#0A192F]">Status</th>
                <th className="text-left px-3 py-2 font-semibold text-[#0A192F]">Review</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {adjustments.map((a: any) => (
                <tr key={a.id} className="hover:bg-[#F8F9FA]">
                  <td className="px-3 py-2.5">
                    <div className="font-medium text-[#0A192F]">{a.adjustmentType}</div>
                    <div className="text-[10px] text-gray-400 font-mono">{shortId(a.id)}</div>
                  </td>
                  <td className="px-3 py-2.5 font-mono text-[#0A192F]">{Number(a.amount).toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                  <td className="px-3 py-2.5 text-gray-600 max-w-xs">
                    {a.description ?? a.reason}
                  </td>
                  <td className="px-3 py-2.5"><StatusBadge status={a.status} map={ADJUSTMENT_STATUS_COLORS} /></td>
                  <td className="px-3 py-2.5">
                    {a.status === 'pending' ? (
                      <div className="flex gap-1.5">
                        <button
                          onClick={() => setReviewTarget({ id: a.id, decision: 'approved' })}
                          className="text-[10px] bg-green-50 text-green-700 border border-green-200 px-2.5 py-1 rounded-button hover:bg-green-100"
                        >
                          Approve
                        </button>
                        <button
                          onClick={() => setReviewTarget({ id: a.id, decision: 'rejected' })}
                          className="text-[10px] bg-red-50 text-red-700 border border-red-200 px-2.5 py-1 rounded-button hover:bg-red-100"
                        >
                          Reject
                        </button>
                      </div>
                    ) : (
                      <span className="text-[10px] text-gray-400">{a.decidedAt ? new Date(a.decidedAt).toLocaleString() : ''}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Review reason modal */}
      {reviewTarget && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
          <div className="bg-white rounded-card border border-gray-200 shadow-lg p-5 w-full max-w-md space-y-3">
            <h4 className="text-base font-serif font-semibold text-[#0A192F]">
              {reviewTarget.decision === 'approved' ? 'Approve adjustment' : 'Reject adjustment'}
            </h4>
            <p className="text-[11px] text-gray-500">
              {reviewTarget.decision === 'approved'
                ? 'Approval emits a learning.adjustment_approved signal that feeds tax memory.'
                : 'Rejection emits a learning.adjustment_rejected signal so the suggestion pipeline can learn.'}
            </p>
            <textarea
              value={reviewReason}
              onChange={(e) => setReviewReason(e.target.value)}
              placeholder="Reason (recommended, optional) — max 500 chars"
              maxLength={500}
              rows={3}
              className="w-full border border-gray-200 rounded-button px-3 py-2 text-xs focus:outline-none focus:border-[#0A192F]"
            />
            <div className="flex justify-end gap-2">
              <button
                onClick={() => { setReviewTarget(null); setReviewReason(''); }}
                className="text-xs text-gray-600 hover:underline"
              >
                Cancel
              </button>
              <button
                onClick={submitReview}
                disabled={working !== null}
                className="text-xs font-semibold bg-[#0A192F] text-white px-4 py-2 rounded-button disabled:opacity-50"
              >
                {working === `adjust-${reviewTarget.id}` ? 'Submitting…' : `Confirm ${reviewTarget.decision}`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
