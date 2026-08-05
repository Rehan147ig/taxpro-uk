import { and, eq } from 'drizzle-orm';
import { dataLineageEdges } from '../../db/schema/lineage.js';
import { accounts } from '../../db/schema/accounts.js';
import { entities } from '../../db/schema/entities.js';
import { taxMappings } from '../../db/schema/tax-mappings.js';
import { mappingProposals } from '../../db/schema/mapping-proposals.js';
import { trialBalance } from '../../db/schema/trial-balance.js';
import { provisionRuns } from '../../db/schema/provision-runs.js';
import { provisionResults } from '../../db/schema/provision-results.js';
import { provisionEvents } from '../../db/schema/provision-events.js';
import { reviewItems } from '../../db/schema/review-items.js';
import { importBatchRows } from '../../db/schema/import-batches.js';
import { sourceDocuments } from '../../db/schema/source-documents.js';
import { taxAdjustments } from '../../db/schema/tax-adjustments.js';
import { evidenceLinks } from '../../db/schema/evidence-links.js';

/**
 * Lineage — the knowledge graph read model.
 *
 * data_lineage_edges are written at intake/commit time; this service
 * traverses both the persisted edges and the existing foreign keys so
 * that every trace is derivable even for records created before the
 * graph existed.
 */

export interface LineageNode {
  kind: string;
  id: string;
  label: string;
  summary?: Record<string, unknown>;
}

export interface LineageEdge {
  source: { kind: string; id: string };
  target: { kind: string; id: string };
  relation: string;
}

export interface LineageGraph {
  nodes: LineageNode[];
  edges: LineageEdge[];
}

async function persistedNeighbors(
  tx: any,
  tenantId: string,
  kind: string,
  id: string,
): Promise<LineageEdge[]> {
  const [fromEdges, toEdges] = await Promise.all([
    tx.select().from(dataLineageEdges)
      .where(and(eq(dataLineageEdges.tenantId, tenantId), eq(dataLineageEdges.sourceKind, kind), eq(dataLineageEdges.sourceId, id))),
    tx.select().from(dataLineageEdges)
      .where(and(eq(dataLineageEdges.tenantId, tenantId), eq(dataLineageEdges.targetKind, kind), eq(dataLineageEdges.targetId, id))),
  ]);

  return [
    ...fromEdges.map((e: any) => ({ source: { kind: e.sourceKind, id: e.sourceId }, target: { kind: e.targetKind, id: e.targetId }, relation: e.relation })),
    ...toEdges.map((e: any) => ({ source: { kind: e.sourceKind, id: e.sourceId }, target: { kind: e.targetKind, id: e.targetId }, relation: e.relation })),
  ];
}

function uniqueNodes(acc: LineageGraph): LineageGraph {
  const seen = new Set<string>();
  const nodes = acc.nodes.filter((n) => {
    const key = `${n.kind}:${n.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const edgeKeys = new Set<string>();
  const edges = acc.edges.filter((e) => {
    const key = `${e.source.kind}:${e.source.id}->${e.relation}->${e.target.kind}:${e.target.id}`;
    if (edgeKeys.has(key)) return false;
    edgeKeys.add(key);
    return true;
  });
  return { nodes, edges };
}

export async function getLineageForAccount(
  tx: any,
  tenantId: string,
  accountId: string,
): Promise<LineageGraph> {
  const graph: LineageGraph = { nodes: [], edges: [] };

  const [accountRows, mappingRows, proposalRows, tbRows, reviewRows, batchRows, adjustmentRows, evidenceRows] = await Promise.all([
    tx.select().from(accounts).where(and(eq(accounts.tenantId, tenantId), eq(accounts.id, accountId))),
    tx.select().from(taxMappings).where(and(eq(taxMappings.tenantId, tenantId), eq(taxMappings.accountId, accountId))),
    tx.select().from(mappingProposals).where(and(eq(mappingProposals.tenantId, tenantId), eq(mappingProposals.accountId, accountId))),
    tx.select().from(trialBalance).where(and(eq(trialBalance.tenantId, tenantId), eq(trialBalance.accountId, accountId))),
    tx.select().from(reviewItems).where(and(eq(reviewItems.tenantId, tenantId), eq(reviewItems.accountId, accountId))),
    tx.select().from(importBatchRows).where(and(eq(importBatchRows.tenantId, tenantId), eq(importBatchRows.accountId, accountId))),
    tx.select().from(taxAdjustments).where(and(eq(taxAdjustments.tenantId, tenantId), eq(taxAdjustments.accountId, accountId))),
    tx.select().from(evidenceLinks).where(and(eq(evidenceLinks.tenantId, tenantId), eq(evidenceLinks.subjectKind, 'account'), eq(evidenceLinks.subjectId, accountId))),
  ]);

  if (accountRows.length === 0) return graph;
  const account = accountRows[0];
  graph.nodes.push({ kind: 'account', id: account.id, label: account.name, summary: { number: account.accountNumber, type: account.type } });

  for (const m of mappingRows) {
    graph.nodes.push({ kind: 'tax_mapping', id: m.id, label: `${m.taxAccountType} (${m.status})` });
    graph.edges.push({ source: { kind: 'account', id: accountId }, target: { kind: 'tax_mapping', id: m.id }, relation: 'mapped_to' });
  }
  for (const p of proposalRows) {
    graph.nodes.push({ kind: 'mapping_proposal', id: p.id, label: `${p.targetTaxClassification} (${p.status})` });
    graph.edges.push({ source: { kind: 'account', id: accountId }, target: { kind: 'mapping_proposal', id: p.id }, relation: 'proposed_for' });
  }
  for (const tb of tbRows) {
    graph.nodes.push({ kind: 'trial_balance', id: tb.id, label: `Balance ${tb.balance} (${tb.period})`, summary: { period: tb.period, source: tb.source } });
    graph.edges.push({ source: { kind: 'account', id: accountId }, target: { kind: 'trial_balance', id: tb.id }, relation: 'balanced_at' });
  }
  for (const r of reviewRows) {
    graph.nodes.push({ kind: 'review_item', id: r.id, label: r.title });
    graph.edges.push({ source: { kind: 'account', id: accountId }, target: { kind: 'review_item', id: r.id }, relation: 'flagged_by' });
  }
  for (const br of batchRows) {
    graph.nodes.push({ kind: 'import_batch_row', id: br.id, label: `Row ${br.rowNumber} (${br.status})` });
    graph.edges.push({ source: { kind: 'account', id: accountId }, target: { kind: 'import_batch_row', id: br.id }, relation: 'imported_via' });
  }
  for (const a of adjustmentRows) {
    graph.nodes.push({ kind: 'tax_adjustment', id: a.id, label: `${a.adjustmentType} ${a.amount}` });
    graph.edges.push({ source: { kind: 'account', id: accountId }, target: { kind: 'tax_adjustment', id: a.id }, relation: 'adjusted_by' });
  }
  for (const e of evidenceRows) {
    graph.nodes.push({ kind: 'evidence_link', id: e.id, label: e.evidenceRole });
    graph.edges.push({ source: { kind: 'account', id: accountId }, target: { kind: 'evidence_link', id: e.id }, relation: 'evidenced_by' });
  }

  return uniqueNodes(graph);
}

export async function getLineageForRun(
  tx: any,
  tenantId: string,
  runId: string,
): Promise<LineageGraph> {
  const graph: LineageGraph = { nodes: [], edges: [] };

  const [runRows, resultRows, eventRows, reviewRows, adjustmentRows, evidenceRows, docRows] = await Promise.all([
    tx.select().from(provisionRuns).where(and(eq(provisionRuns.tenantId, tenantId), eq(provisionRuns.id, runId))),
    tx.select().from(provisionResults).where(and(eq(provisionResults.tenantId, tenantId), eq(provisionResults.provisionRunId, runId))),
    tx.select().from(provisionEvents).where(and(eq(provisionEvents.tenantId, tenantId), eq(provisionEvents.provisionRunId, runId))),
    tx.select().from(reviewItems).where(and(eq(reviewItems.tenantId, tenantId), eq(reviewItems.provisionRunId, runId))),
    tx.select().from(taxAdjustments).where(and(eq(taxAdjustments.tenantId, tenantId), eq(taxAdjustments.provisionRunId, runId))),
    tx.select().from(evidenceLinks).where(and(eq(evidenceLinks.tenantId, tenantId), eq(evidenceLinks.subjectKind, 'provision_run'), eq(evidenceLinks.subjectId, runId))),
    tx.select().from(sourceDocuments),
  ]);

  if (runRows.length === 0) return graph;
  const run = runRows[0];
  const docMap = new Map(docRows.map((d: any) => [d.id, d]));

  graph.nodes.push({ kind: 'provision_run', id: run.id, label: `Provision run ${run.status}`, summary: { status: run.status, approvalStatus: run.approvalStatus } });

  if (run.parentRunId) {
    graph.nodes.push({ kind: 'provision_run', id: run.parentRunId, label: 'Parent provision run' });
    graph.edges.push({ source: { kind: 'provision_run', id: run.parentRunId }, target: { kind: 'provision_run', id: run.id }, relation: 'superseded_by' });
  }

  if (run.sourceDocumentId) {
    const doc = docMap.get(run.sourceDocumentId) as { filename?: string } | undefined;
    graph.nodes.push({ kind: 'source_document', id: run.sourceDocumentId, label: doc?.filename ?? 'Source document' });
    graph.edges.push({ source: { kind: 'source_document', id: run.sourceDocumentId }, target: { kind: 'provision_run', id: run.id }, relation: 'input_to' });
  }

  for (const r of resultRows) {
    graph.nodes.push({ kind: 'provision_result', id: r.id, label: `Result ${r.period} (${r.status})` });
    graph.edges.push({ source: { kind: 'provision_run', id: run.id }, target: { kind: 'provision_result', id: r.id }, relation: 'produced' });
  }
  for (const e of eventRows) {
    graph.nodes.push({ kind: 'provision_event', id: e.id, label: e.eventType });
    graph.edges.push({ source: { kind: 'provision_run', id: run.id }, target: { kind: 'provision_event', id: e.id }, relation: 'logged' });
  }
  for (const r of reviewRows) {
    graph.nodes.push({ kind: 'review_item', id: r.id, label: r.title });
    graph.edges.push({ source: { kind: 'provision_run', id: run.id }, target: { kind: 'review_item', id: r.id }, relation: 'flagged_by' });
  }
  for (const a of adjustmentRows) {
    graph.nodes.push({ kind: 'tax_adjustment', id: a.id, label: `${a.adjustmentType} ${a.amount}` });
    graph.edges.push({ source: { kind: 'provision_run', id: run.id }, target: { kind: 'tax_adjustment', id: a.id }, relation: 'adjusted_by' });
  }
  for (const e of evidenceRows) {
    graph.nodes.push({ kind: 'evidence_link', id: e.id, label: e.evidenceRole });
    graph.edges.push({ source: { kind: 'provision_run', id: run.id }, target: { kind: 'evidence_link', id: e.id }, relation: 'evidenced_by' });
  }

  return uniqueNodes(graph);
}

export async function listEvidenceLinks(tx: any, tenantId: string, subjectKind?: string, subjectId?: string, limit = 100) {
  const conditions = [eq(evidenceLinks.tenantId, tenantId)];
  if (subjectKind) conditions.push(eq(evidenceLinks.subjectKind, subjectKind));
  if (subjectId) conditions.push(eq(evidenceLinks.subjectId, subjectId));
  return tx.select().from(evidenceLinks).where(and(...conditions)).limit(limit);
}

export async function getEvidenceDocumentId(tx: any, tenantId: string, documentId: string): Promise<string | null> {
  const [doc] = await tx.select({ id: sourceDocuments.id }).from(sourceDocuments)
    .where(and(eq(sourceDocuments.tenantId, tenantId), eq(sourceDocuments.id, documentId))).limit(1);
  return doc?.id ?? null;
}
