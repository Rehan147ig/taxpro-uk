import { and, desc, eq, isNull } from 'drizzle-orm';
import { importBatches } from '../db/schema/import-batches.js';
import { ConflictError } from './errors.js';
import type { DbTx } from '../config/db.js';

/**
 * Run → import batch linkage helpers (migration 0021).
 *
 * "Active" batch = `committed` and not superseded: the intake batch whose
 * rows are currently live for the entity/accounting-period combination.
 * Runs created without an explicit batch auto-link the active one so the
 * calculation always points at the exact evidence it consumed.
 */

export async function resolveActiveImportBatch(
  tx: DbTx,
  tenantId: string,
  entityId: string | null | undefined,
  accountingPeriodId: string | null | undefined,
): Promise<typeof importBatches.$inferSelect | null> {
  if (!entityId || !accountingPeriodId) return null;
  const [batch] = await tx.select().from(importBatches)
    .where(and(
      eq(importBatches.tenantId, tenantId),
      eq(importBatches.entityId, entityId),
      eq(importBatches.accountingPeriodId, accountingPeriodId),
      eq(importBatches.status, 'committed'),
      isNull(importBatches.supersededByBatchId),
    ))
    .orderBy(desc(importBatches.createdAt))
    .limit(1);
  return batch ?? null;
}

export async function requireCommittedBatch(
  tx: DbTx,
  tenantId: string,
  batchId: string,
): Promise<typeof importBatches.$inferSelect> {
  const [batch] = await tx.select().from(importBatches)
    .where(and(eq(importBatches.tenantId, tenantId), eq(importBatches.id, batchId)))
    .limit(1);
  if (!batch) {
    throw new ConflictError('Import batch not found in this tenant');
  }
  if (batch.status !== 'committed') {
    throw new ConflictError(`Only committed import batches can be linked to a run (batch is '${batch.status}')`);
  }
  return batch;
}

/** Locked runs never change their evidence linkage — the run's story is frozen. */
export function assertRunBatchLinkageMutable(status: string | null | undefined): void {
  if (status === 'locked') {
    throw new ConflictError('Provision run is locked; the associated import batch cannot be changed');
  }
}
