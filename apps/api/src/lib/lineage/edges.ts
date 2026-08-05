import { dataLineageEdges } from '../../db/schema/lineage.js';

/**
 * Shared knowledge-graph edge writer. Every flow that links records writes
 * typed edges through here so the whole provenance story is queryable and
 * idempotent (unique constraint + ON CONFLICT DO NOTHING).
 */
export interface LineageEdgeInput {
  tenantId: string;
  sourceKind: string;
  sourceId: string;
  targetKind: string;
  targetId: string;
  relation: string;
  metadata?: Record<string, unknown>;
}

export async function recordLineageEdge(tx: any, edge: LineageEdgeInput): Promise<void> {
  await recordLineageEdges(tx, [edge]);
}

export async function recordLineageEdges(tx: any, edges: LineageEdgeInput[]): Promise<void> {
  if (edges.length === 0) return;
  await tx.insert(dataLineageEdges).values(edges.map((e) => ({
    tenantId: e.tenantId,
    sourceKind: e.sourceKind,
    sourceId: e.sourceId,
    targetKind: e.targetKind,
    targetId: e.targetId,
    relation: e.relation,
    metadata: e.metadata,
  }))).onConflictDoNothing({
    target: [
      dataLineageEdges.tenantId,
      dataLineageEdges.sourceKind,
      dataLineageEdges.sourceId,
      dataLineageEdges.targetKind,
      dataLineageEdges.targetId,
      dataLineageEdges.relation,
    ],
  });
}
