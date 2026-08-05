import { and, eq } from 'drizzle-orm';
import { importBatches } from '../../db/schema/import-batches.js';
import { importBatchEvents } from '../../db/schema/import-batches.js';
import { reviewerFeedbackEvents } from '../../db/schema/feedback.js';
import { NotFoundError, ForbiddenError } from '../../lib/errors.js';

/**
 * Append-only audit ledger for import batches plus the reviewer
 * feedback event log that feeds the deterministic tax memory.
 */

export interface BatchEventInput {
  tenantId: string;
  batchId: string;
  eventType: string;
  actorType?: 'user' | 'agent' | 'system';
  actorUserId?: string | null;
  reason?: string | null;
  beforeState?: Record<string, unknown> | null;
  afterState?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
}

export async function recordBatchEvent(tx: any, input: BatchEventInput): Promise<void> {
  await tx.insert(importBatchEvents).values({
    tenantId: input.tenantId,
    batchId: input.batchId,
    eventType: input.eventType,
    actorType: input.actorType ?? 'user',
    actorUserId: input.actorUserId ?? null,
    reason: input.reason ?? null,
    beforeState: input.beforeState ?? null,
    afterState: input.afterState ?? null,
    metadata: input.metadata ?? null,
  });
}

export interface FeedbackEventInput {
  tenantId: string;
  batchId?: string | null;
  feedbackType: 'accepted' | 'rejected' | 'overridden' | 'corrected';
  subjectKind: string;
  subjectId: string;
  suggested?: Record<string, unknown> | null;
  applied?: Record<string, unknown> | null;
  reason?: string | null;
  createdByUserId: string;
}

export async function recordFeedback(tx: any, input: FeedbackEventInput): Promise<void> {
  await tx.insert(reviewerFeedbackEvents).values({
    tenantId: input.tenantId,
    batchId: input.batchId ?? null,
    feedbackType: input.feedbackType,
    subjectKind: input.subjectKind,
    subjectId: input.subjectId,
    suggested: input.suggested ?? null,
    applied: input.applied ?? null,
    reason: input.reason ?? null,
    createdByUserId: input.createdByUserId,
  });
}

/**
 * Load a batch, enforcing tenant scope (RLS is already tenant-scoped, this
 * adds a row-existence check with a clear 404).
 */
export async function requireBatch(tx: any, tenantId: string, batchId: string) {
  const [batch] = await tx.select().from(importBatches)
    .where(and(eq(importBatches.tenantId, tenantId), eq(importBatches.id, batchId)))
    .limit(1);
  if (!batch) throw new NotFoundError('Import batch', batchId);
  return batch;
}

export async function requireBatchInTenant(tx: any, tenantId: string, batchId: string): Promise<void> {
  const batch = await requireBatch(tx, tenantId, batchId);
  if (batch.tenantId !== tenantId) throw new ForbiddenError('Cross-tenant access denied');
}

export async function listBatchEvents(tx: any, tenantId: string, batchId: string) {
  return tx.select().from(importBatchEvents)
    .where(and(eq(importBatchEvents.tenantId, tenantId), eq(importBatchEvents.batchId, batchId)))
    .orderBy(importBatchEvents.occurredAt);
}
