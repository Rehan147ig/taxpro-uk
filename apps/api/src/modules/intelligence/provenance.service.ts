import { and, desc, eq, inArray, or } from 'drizzle-orm';
import { provisionResults } from '../../db/schema/provision-results.js';
import { provisionRuns } from '../../db/schema/provision-runs.js';
import { dataLineageEdges } from '../../db/schema/lineage.js';
import { evidenceLinks } from '../../db/schema/evidence-links.js';
import { sourceDocuments } from '../../db/schema/source-documents.js';
import { importBatches } from '../../db/schema/import-batches.js';
import { taxAdjustments } from '../../db/schema/tax-adjustments.js';
import { agentEvents } from '../../db/schema/agent-events.js';
import { accounts } from '../../db/schema/accounts.js';
import { NotFoundError } from '../../lib/errors.js';
import type { DbTx } from '../../config/db.js';

/**
 * Provenance API — the "how did we get here?" endpoint for any calculation
 * result or source document. Traverses the knowledge graph edges plus the
 * existing foreign keys so every answer is derived from persisted facts,
 * never from ad-hoc reconstruction.
 */

export async function getProvenanceForResult(tx: DbTx, tenantId: string, resultId: string) {
  const [result] = await tx.select().from(provisionResults)
    .where(and(eq(provisionResults.tenantId, tenantId), eq(provisionResults.id, resultId)))
    .limit(1);
  if (!result) throw new NotFoundError('Provision result', resultId);

  const [run] = result.provisionRunId
    ? await tx.select().from(provisionRuns).where(eq(provisionRuns.id, result.provisionRunId)).limit(1)
    : [];
  if (!run) throw new NotFoundError('Provision run', result.provisionRunId ?? resultId);

  const downstream = await tx.select().from(dataLineageEdges)
    .where(and(eq(dataLineageEdges.tenantId, tenantId), eq(dataLineageEdges.sourceKind, 'provision_result'), eq(dataLineageEdges.sourceId, resultId)));
  const upstream = await tx.select().from(dataLineageEdges)
    .where(and(eq(dataLineageEdges.tenantId, tenantId), eq(dataLineageEdges.targetKind, 'provision_result'), eq(dataLineageEdges.targetId, resultId)));
  const edges = [...upstream, ...downstream];

  const accountIds = edges.filter((e) => e.relation === 'used_balance').map((e) => e.targetId);
  const calculatedFrom = accountIds.length > 0
    ? await tx.select({
        id: accounts.id, accountNumber: accounts.accountNumber, name: accounts.name,
        type: accounts.type, detailType: accounts.detailType,
      }).from(accounts).where(and(eq(accounts.tenantId, tenantId), inArray(accounts.id, accountIds)))
    : [];

  const batches = await tx.select().from(importBatches)
    .where(and(
      eq(importBatches.tenantId, tenantId),
      or(
        and(
          eq(importBatches.entityId, run.entityId ?? ''),
          eq(importBatches.accountingPeriodId, run.accountingPeriodId ?? ''),
        ),
        run.sourceDocumentId ? eq(importBatches.sourceDocumentId, run.sourceDocumentId) : undefined,
      ),
    ))
    .orderBy(desc(importBatches.createdAt));

  const batchIds = batches.map((b) => b.id);
  const batchDocs = batchIds.length > 0
    ? await tx.select().from(evidenceLinks)
        .where(and(eq(evidenceLinks.tenantId, tenantId), inArray(evidenceLinks.subjectId, batchIds), eq(evidenceLinks.subjectKind, 'import_batch')))
    : [];
  const docIds = [...new Set(batchDocs.map((l) => l.documentId))];
  const documents = docIds.length > 0
    ? await tx.select().from(sourceDocuments).where(and(eq(sourceDocuments.tenantId, tenantId), inArray(sourceDocuments.id, docIds)))
    : [];

  const adjustments = await tx.select().from(taxAdjustments)
    .where(and(eq(taxAdjustments.tenantId, tenantId), eq(taxAdjustments.provisionRunId, run.id)));

  const agentEventsList = await tx.select().from(agentEvents)
    .where(and(eq(agentEvents.tenantId, tenantId), eq(agentEvents.runId, run.id)))
    .orderBy(desc(agentEvents.occurredAt));

  return {
    result: {
      id: result.id,
      period: result.period,
      status: result.status,
      currentTaxExpense: result.currentTaxExpense,
      deferredTaxExpense: result.deferredTaxExpense,
      totalTaxExpense: result.totalTaxExpense,
      bookIncome: result.bookIncome,
      effectiveTaxRate: result.effectiveTaxRate,
      taxPayable: result.taxPayable,
      createdAt: result.createdAt,
    },
    run: {
      id: run.id,
      mode: run.mode,
      status: run.status,
      approvalStatus: run.approvalStatus,
      engineVersion: run.engineVersion,
      inputDataHash: run.inputDataHash,
      mappingVersionHash: run.mappingVersionHash,
      rulesUsed: run.rulesUsed,
      correlationId: run.correlationId,
      sourceDocumentId: run.sourceDocumentId,
      createdAt: run.createdAt,
    },
    producedBy: { kind: 'provision_run', id: run.id, relation: 'produced' },
    calculatedFrom,
    batches: batches.map((b) => ({
      id: b.id,
      status: b.status,
      sourceSystem: b.sourceSystem,
      sourceType: b.sourceType,
      sourceReference: b.sourceReference,
      originalFilename: b.originalFilename,
      checksum: b.checksum,
      storageKey: b.storageKey,
      parserVersion: b.parserVersion,
      rowCount: b.rowCount,
      createdAt: b.createdAt,
    })),
    documents,
    adjustments: adjustments.map((a) => ({
      id: a.id,
      adjustmentType: a.adjustmentType,
      amount: a.amount,
      reason: a.reason,
      status: a.status,
      createdByUserId: a.createdByUserId,
      createdAt: a.createdAt,
    })),
    agentEvents: agentEventsList.map((e) => ({
      id: e.id,
      eventType: e.eventType,
      sourceAgent: e.sourceAgent,
      correlationId: e.correlationId,
      occurredAt: e.occurredAt,
    })),
    edges: edges.map((e) => ({
      sourceKind: e.sourceKind, sourceId: e.sourceId,
      targetKind: e.targetKind, targetId: e.targetId,
      relation: e.relation, metadata: e.metadata,
    })),
  };
}

export async function getProvenanceForDocument(tx: DbTx, tenantId: string, documentId: string) {
  const [doc] = await tx.select().from(sourceDocuments)
    .where(and(eq(sourceDocuments.tenantId, tenantId), eq(sourceDocuments.id, documentId)))
    .limit(1);
  if (!doc) throw new NotFoundError('Source document', documentId);

  const links = await tx.select().from(evidenceLinks)
    .where(and(eq(evidenceLinks.tenantId, tenantId), eq(evidenceLinks.documentId, documentId)));

  const batches = links.length > 0
    ? await tx.select().from(importBatches).where(and(
        eq(importBatches.tenantId, tenantId),
        inArray(importBatches.id, [...new Set(links.filter((l) => l.subjectKind === 'import_batch').map((l) => l.subjectId))]),
      ))
    : [];

  const runs = await tx.select({
    id: provisionRuns.id, period: provisionRuns.period, endPeriod: provisionRuns.endPeriod,
    status: provisionRuns.status, approvalStatus: provisionRuns.approvalStatus,
    inputDataHash: provisionRuns.inputDataHash, createdAt: provisionRuns.createdAt,
  }).from(provisionRuns)
    .where(and(eq(provisionRuns.tenantId, tenantId), eq(provisionRuns.sourceDocumentId, documentId)));

  const lineage = await tx.select().from(dataLineageEdges)
    .where(and(eq(dataLineageEdges.tenantId, tenantId), eq(dataLineageEdges.sourceKind, 'source_document'), eq(dataLineageEdges.sourceId, documentId)));

  return {
    document: doc,
    linkedAs: links.map((l) => ({
      id: l.id, subjectKind: l.subjectKind, subjectId: l.subjectId,
      evidenceRole: l.evidenceRole, note: l.note, createdAt: l.createdAt,
    })),
    batches: batches.map((b) => ({
      id: b.id, status: b.status, sourceSystem: b.sourceSystem,
      originalFilename: b.originalFilename, checksum: b.checksum,
      storageKey: b.storageKey, parserVersion: b.parserVersion, createdAt: b.createdAt,
    })),
    runs,
    lineage,
  };
}
