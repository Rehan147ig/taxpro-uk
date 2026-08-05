import { eq } from 'drizzle-orm';
import { getStorage, sha256Hex, buildStorageKey } from '../../lib/storage/index.js';
import { sourceDocuments } from '../../db/schema/source-documents.js';
import { importBatches } from '../../db/schema/import-batches.js';
import { logger } from '../../lib/logger.js';
import type { DbTx } from '../../config/db.js';

/**
 * Evidence persistence — the guarantee that every ingested record can be
 * traced back to the exact bytes it came from.
 *
 * Flow: file bytes → storage backend (tenant-scoped key) → source_documents
 * row → batch gains storage_key/parser_version and auto-links the document
 * (so the commit gate wires source_of + evidence 'source' automatically).
 * Storage failures are logged and non-fatal (intake still works); DB
 * failures remove the stored bytes so no orphans are left behind.
 */
export const INTAKE_PARSER_VERSION = 'intake-csv-v1';

export interface PersistIntakeEvidenceArgs {
  tenantId: string;
  userId: string;
  batchId: string;
  filename: string;
  mimeType: string;
  bytes: Buffer;
  sourceSystem?: string | null;
  checksum?: string;
  /** When true, the batch is re-linked to the persisted document (used when
   *  the uploader did not supply their own sourceDocumentId). */
  autoLinkDocument?: boolean;
}

export async function persistIntakeEvidence(
  tx: DbTx,
  args: PersistIntakeEvidenceArgs,
): Promise<{ documentId: string; storageKey: string; checksum: string } | null> {
  const checksum = args.checksum ?? sha256Hex(args.bytes);
  const storageKey = buildStorageKey({
    tenantId: args.tenantId,
    documentType: 'intake_batch',
    docId: args.batchId,
    version: 1,
    filename: args.filename,
  });

  const storage = getStorage();
  try {
    await storage.put(storageKey, args.bytes);
  } catch (err) {
    logger.warn({ err, batchId: args.batchId }, '[Intelligence] evidence bytes could not be persisted — batch continues without evidence');
    return null;
  }

  try {
    const [doc] = await tx.insert(sourceDocuments).values({
      tenantId: args.tenantId,
      documentType: 'intake_batch',
      filename: args.filename,
      mimeType: args.mimeType || 'text/csv',
      sizeBytes: args.bytes.length,
      storageKey,
      sha256: checksum,
      provenance: 'manual_upload',
      sourceSystem: args.sourceSystem ?? 'manual-upload',
      extractionStatus: 'not_required',
      parserVersion: INTAKE_PARSER_VERSION,
      uploadedByUserId: args.userId,
    }).returning();

    await tx.update(importBatches).set({
      storageKey,
      parserVersion: INTAKE_PARSER_VERSION,
      ...(args.autoLinkDocument === true ? { sourceDocumentId: doc.id } : {}),
    }).where(eq(importBatches.id, args.batchId));

    return { documentId: doc.id, storageKey, checksum };
  } catch (err) {
    try { await storage.delete(storageKey); } catch { /* best effort */ }
    throw err;
  }
}
