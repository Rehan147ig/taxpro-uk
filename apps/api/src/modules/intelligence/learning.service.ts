import { and, eq } from 'drizzle-orm';
import { taxAdjustments } from '../../db/schema/tax-adjustments.js';
import { ConflictError, NotFoundError } from '../../lib/errors.js';
import { recordFeedback } from '../intake/audit.js';
import { emitAgentEvent } from '../../eve/agent.js';
import type { DbTx } from '../../config/db.js';

/**
 * Learning system — governed adjustment review.
 *
 * A reviewer decision on an adjustment is persisted in three places:
 *  1. tax_adjustments status (the governed state machine),
 *  2. reviewer_feedback_events (append-only learning signal),
 *  3. agent_events (structured event for downstream consumers).
 * All inside one transaction so the signals can never diverge.
 */
export async function reviewAdjustment(tx: DbTx, args: {
  tenantId: string;
  adjustmentId: string;
  decision: 'approved' | 'rejected';
  userId: string;
  reason?: string;
}) {
  const [adjustment] = await tx.select().from(taxAdjustments)
    .where(and(eq(taxAdjustments.tenantId, args.tenantId), eq(taxAdjustments.id, args.adjustmentId)))
    .limit(1);
  if (!adjustment) throw new NotFoundError('Tax adjustment', args.adjustmentId);
  if (adjustment.status !== 'pending') throw new ConflictError('Adjustment is not pending review');

  const status = args.decision === 'approved' ? 'approved' : 'rejected';

  const [updated] = await tx.update(taxAdjustments).set({
    status,
    decidedByUserId: args.userId,
    decidedAt: new Date(),
    decisionReason: args.reason ?? null,
  }).where(eq(taxAdjustments.id, adjustment.id)).returning();

  await recordFeedback(tx, {
    tenantId: args.tenantId,
    batchId: null,
    feedbackType: args.decision === 'approved' ? 'accepted' : 'rejected',
    subjectKind: 'tax_adjustment',
    subjectId: adjustment.id,
    suggested: { adjustmentType: adjustment.adjustmentType, amount: adjustment.amount },
    applied: { status },
    reason: args.reason ?? null,
    createdByUserId: args.userId,
  });

  await emitAgentEvent(tx, {
    tenantId: args.tenantId,
    userId: args.userId,
    workflowName: 'learning_system',
    correlationId: adjustment.provisionRunId ?? undefined,
  }, args.decision === 'approved' ? 'learning.adjustment_approved' : 'learning.adjustment_rejected', {
    adjustmentId: adjustment.id,
    provisionRunId: adjustment.provisionRunId,
    accountId: adjustment.accountId,
    reason: args.reason ?? null,
  });

  return updated;
}
