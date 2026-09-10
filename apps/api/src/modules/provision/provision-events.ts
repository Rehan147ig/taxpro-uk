import { eq, and } from 'drizzle-orm';
import { db } from '../../config/db.js';
import { provisionEvents } from '../../db/schema/provision-events.js';

export type ActorType = 'user' | 'agent' | 'system';

export interface RecordEventInput {
  tenantId: string;
  provisionRunId: string;
  eventType: string;
  actorType: ActorType;
  actorUserId?: string | null;
  actorAgentId?: string | null;
  reason?: string | null;
  beforeState?: Record<string, unknown> | null;
  afterState?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
}

export async function recordProvisionEvent(input: RecordEventInput, tx?: any): Promise<void> {
  const d = tx ?? db;
  await d.insert(provisionEvents).values({
    tenantId: input.tenantId,
    provisionRunId: input.provisionRunId,
    eventType: input.eventType,
    actorType: input.actorType,
    actorUserId: input.actorUserId ?? null,
    actorAgentId: input.actorAgentId ?? null,
    occurredAt: new Date(),
    reason: input.reason ?? null,
    beforeState: input.beforeState ? JSON.stringify(input.beforeState) : null,
    afterState: input.afterState ? JSON.stringify(input.afterState) : null,
    metadata: input.metadata ? JSON.stringify(input.metadata) : null,
  });
}

export async function getEventsForRun(provisionRunId: string, tenantId: string, tx?: any): Promise<typeof provisionEvents.$inferSelect[]> {
  const d = tx ?? db;
  return d.select().from(provisionEvents)
    .where(and(
      eq(provisionEvents.provisionRunId, provisionRunId),
      eq(provisionEvents.tenantId, tenantId),
    ))
    .orderBy(provisionEvents.occurredAt);
}

export const EVENT_TYPES = {
  RUN_CREATED: 'run.created',
  CALCULATION_COMPLETED: 'calculation.completed',
  MAPPING_OVERRIDE: 'mapping.override',
  REVIEW_ITEM_RESOLVED: 'review_item.resolved',
  REVIEW_ITEM_REJECTED: 'review_item.rejected',
  SUBMITTED_FOR_APPROVAL: 'submitted_for_approval',
  PARTNER_APPROVED: 'partner.approved',
  PARTNER_REJECTED: 'partner.rejected',
  LOCKED: 'run.locked',
  HANDOFF_READY: 'run.handoff_ready',
  FILED_EXTERNALLY: 'run.filed_externally',
  EXPORT_WORKPAPER: 'export.workpaper',
  EXPORT_PACKAGE: 'export.package',
  EXPORT_HANDOFF_PACKAGE: 'export.handoff_package',
  RUN_FAILED: 'run.failed',
  RUN_SUBMITTED: 'run.submitted',
  XERO_JOURNALS_PUSHED: 'xero.journals_pushed',
  AI_WORKFLOW_STARTED: 'ai.workflow.started',
  AI_WORKFLOW_COMPLETED: 'ai.workflow.completed',
  AI_ACTION_DENIED: 'ai.action.denied',
  AI_ACTION_ESCALATED: 'ai.action.escalated',
  MAPPING_SUGGESTED: 'mapping.suggested',
  POSTED_TO_NETSUITE: 'netsuite.posted',
} as const;