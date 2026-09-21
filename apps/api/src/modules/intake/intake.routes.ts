import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import crypto from 'crypto';
import { and, desc, eq, inArray, isNull, lt, not, sql } from 'drizzle-orm';
import { withTenantContext } from '../../config/db.js';
import { entities } from '../../db/schema/entities.js';
import { accountingPeriods } from '../../db/schema/accounting-periods.js';
import { accounts } from '../../db/schema/accounts.js';
import { trialBalance } from '../../db/schema/trial-balance.js';
import { provisionRuns } from '../../db/schema/provision-runs.js';
import { sourceDocuments } from '../../db/schema/source-documents.js';
import { importBatches, importBatchRows, IMPORT_SOURCE_TYPES } from '../../db/schema/import-batches.js';
import { evidenceLinks, EVIDENCE_ROLES } from '../../db/schema/evidence-links.js';
import { mappingSuggestions, taxMemoryPrecedents } from '../../db/schema/tax-memory.js';
import { taxAdjustments } from '../../db/schema/tax-adjustments.js';
import { dataLineageEdges } from '../../db/schema/lineage.js';
import { authMiddleware } from '../../lib/middleware/auth.js';
import { requireMinimumRole } from '../../lib/middleware/rbac.js';
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '../../lib/errors.js';
import { parseCsv, rowToRecord } from './csv.js';
import { validateRow, buildBatchSummary } from './validate.js';
import type { NormalizedRow } from './validate.js';
import { isIntakeXlsxEnabled, isIntakeSignConventionEnabled, isIntakePriorBridgeEnabled } from '../../config/features.js';
import {
  diffPriorPeriod,
  bridgeItemCount,
  RENAME_SIMILARITY_THRESHOLD,
  OPENING_BALANCE_TOLERANCE,
  type PriorBridgeAccount,
  type CurrentBridgeAccount,
  type PriorPeriodBridgeResult,
} from './prior-period-bridge.js';
import { mappingProposals } from '../../db/schema/mapping-proposals.js';
import { taxMappings } from '../../db/schema/tax-mappings.js';
import { fallbackClassifyByName } from './memory.js';
import { validateUkClassification } from '../mapping/uk-taxonomy.js';
import {
  detectSignConvention,
  applySignInversion,
  signTotalsByType,
  type SignConventionReport,
} from './sign-convention.js';
import { reviewItems } from '../../db/schema/review-items.js';
import { reviewItemEvents } from '../../db/schema/review-item-events.js';
import {
  parseXlsxBuffer,
  buildSheetPreviews,
  mapSheetToParsedRows,
  buildClientFingerprint,
  CANONICAL_FIELDS,
  XLSX_MAX_BYTES,
} from './xlsx.js';
import { intakeColumnMaps } from '../../db/schema/intake-column-maps.js';
import { getStorage, buildStorageKey, sha256Hex as storageSha256 } from '../../lib/storage/index.js';
import { generateSuggestionsForBatch } from './memory.js';
import { recordBatchEvent, recordFeedback, requireBatch, listBatchEvents } from './audit.js';
import { enrichSuggestionsWithAi } from './agent.js';
import { getLineageForAccount, getLineageForRun, listEvidenceLinks } from './lineage.js';
import { isAiConfigured } from '../../config/ai.js';
import { logger } from '../../lib/logger.js';
import { persistIntakeEvidence } from '../intelligence/evidence.service.js';
import { emitAgentEvent } from '../../eve/agent.js';
import { reviewAdjustment } from '../intelligence/learning.service.js';
import { defineIntelligenceAgents } from '../intelligence/agents.js';

defineIntelligenceAgents();

export const intakeRoutes = new Hono();
intakeRoutes.use('*', authMiddleware);

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

const batchCreateSchema = z.object({
  entityId: z.string().uuid(),
  accountingPeriodId: z.string().uuid(),
  sourceType: z.enum(IMPORT_SOURCE_TYPES).default('csv'),
  sourceSystem: z.string().max(100).optional(),
  sourceReference: z.string().max(255).optional(),
  sourceDocumentId: z.string().uuid().optional(),
});

const failSchema = z.object({ reason: z.string().min(1).max(500) });

const decideSchema = z.object({
  decision: z.enum(['accept', 'reject', 'override']),
  reason: z.string().max(500).optional(),
  override: z.object({
    taxAccountType: z.string().min(1).max(100),
    bookTreatment: z.enum(['permanent', 'temporary', 'no_diff']),
    timingCategory: z.enum(['deductible_temporary', 'taxable_temporary']).optional(),
  }).optional(),
});

const evidenceSchema = z.object({
  subjectKind: z.string().min(1).max(40),
  subjectId: z.string().uuid(),
  documentId: z.string().uuid(),
  evidenceRole: z.enum(EVIDENCE_ROLES).default('supporting'),
  note: z.string().max(500).optional(),
});

const batchEvidenceSchema = z.object({
  documentId: z.string().uuid(),
  note: z.string().max(500).optional(),
});

const adjustmentSchema = z.object({
  provisionRunId: z.string().uuid().optional(),
  accountId: z.string().uuid().optional(),
  adjustmentType: z.enum(['permanent', 'temporary', 'other']),
  amount: z.string().regex(/^-?\d+(\.\d{1,2})?$/, 'amount must be a decimal with up to 2 places'),
  description: z.string().max(500).optional(),
  reason: z.string().min(1).max(1000),
  evidenceDocumentId: z.string().uuid().optional(),
  effectivePeriod: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

function sha256Hex(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

async function verifyDocument(tx: any, tenantId: string, documentId: string): Promise<string> {
  const [doc] = await tx.select({ id: sourceDocuments.id }).from(sourceDocuments)
    .where(and(eq(sourceDocuments.tenantId, tenantId), eq(sourceDocuments.id, documentId)))
    .limit(1);
  if (!doc) throw new NotFoundError('Source document', documentId);
  return doc.id;
}

function periodContext(period: { startDate: string; endDate: string }) {
  return { periodStart: period.startDate, periodEnd: period.endDate, defaultCurrency: 'GBP' };
}

// ── Create / list batches ──

intakeRoutes.post('/batches', requireMinimumRole('preparer'), async (c) => {
  const user = c.get('user');
  const form = await c.req.parseBody();

  const file = form['file'];
  if (!(file instanceof File)) {
    throw new BadRequestError('No file uploaded. Use multipart field name "file".');
  }
  if (!file.name.toLowerCase().endsWith('.csv')) {
    throw new BadRequestError(`Unsupported file type: ${file.name}. Intake accepts CSV files.`);
  }

  const parsedFields = batchCreateSchema.safeParse({
    entityId: form['entityId'],
    accountingPeriodId: form['accountingPeriodId'],
    sourceType: form['sourceType'],
    sourceSystem: form['sourceSystem'],
    sourceReference: form['sourceReference'],
    sourceDocumentId: form['sourceDocumentId'],
  });
  if (!parsedFields.success) {
    throw new BadRequestError('Invalid batch fields', { issues: parsedFields.error.flatten().fieldErrors });
  }
  const fields = parsedFields.data;

  const buffer = Buffer.from(await file.arrayBuffer());
  if (buffer.length > MAX_UPLOAD_BYTES) {
    throw new BadRequestError(
      `File too large: ${(buffer.length / 1024 / 1024).toFixed(1)}MB. Maximum upload size is ${MAX_UPLOAD_BYTES / 1024 / 1024}MB.`,
    );
  }

  const checksum = sha256Hex(buffer);

  return withTenantContext(user.tenantId, async (tx) => {
    const [entity] = await tx.select({ id: entities.id, groupId: entities.groupId }).from(entities)
      .where(and(eq(entities.tenantId, user.tenantId), eq(entities.id, fields.entityId)))
      .limit(1);
    if (!entity) throw new NotFoundError('Entity', fields.entityId);

    const [period] = await tx.select().from(accountingPeriods)
      .where(and(eq(accountingPeriods.tenantId, user.tenantId), eq(accountingPeriods.id, fields.accountingPeriodId)))
      .limit(1);
    if (!period) throw new NotFoundError('Accounting period', fields.accountingPeriodId);

    if (fields.sourceDocumentId) {
      await verifyDocument(tx, user.tenantId, fields.sourceDocumentId);
    }

    const sourceSystem = fields.sourceSystem ?? 'manual-upload';
    const [existing] = await tx.select().from(importBatches).where(and(
      eq(importBatches.tenantId, user.tenantId),
      eq(importBatches.entityId, fields.entityId),
      eq(importBatches.accountingPeriodId, fields.accountingPeriodId),
      eq(importBatches.sourceType, fields.sourceType),
      eq(importBatches.sourceSystem, sourceSystem),
      eq(importBatches.checksum, checksum),
    )).limit(1);

    if (existing) {
      return c.json({ batch: existing, duplicate: true, message: 'An identical batch already exists for this entity and period.' }, 200);
    }

    const [batch] = await tx.insert(importBatches).values({
      tenantId: user.tenantId,
      entityId: fields.entityId,
      accountingPeriodId: fields.accountingPeriodId,
      sourceDocumentId: fields.sourceDocumentId ?? null,
      sourceType: fields.sourceType,
      sourceSystem,
      sourceReference: fields.sourceReference ?? null,
      originalFilename: file.name,
      checksum,
      rowCount: 0,
      status: 'validating',
      createdByUserId: user.userId,
    }).returning();

    await recordBatchEvent(tx, {
      tenantId: user.tenantId, batchId: batch.id, eventType: 'batch.created',
      actorUserId: user.userId, afterState: { status: batch.status, filename: file.name, checksum },
    });

    let parsed;
    try {
      parsed = parseCsv(buffer.toString('utf8'));
    } catch (err) {
      const message = err instanceof Error ? err.message : 'CSV could not be parsed';
      await tx.update(importBatches).set({ status: 'failed', failureReason: message, failedAt: new Date() })
        .where(eq(importBatches.id, batch.id));
      await recordBatchEvent(tx, {
        tenantId: user.tenantId, batchId: batch.id, eventType: 'batch.failed',
        actorUserId: user.userId, reason: message, afterState: { status: 'failed' },
      });
      throw new BadRequestError(message, { batchId: batch.id });
    }

    const ctx = periodContext(period);
    const records = parsed.rows.map((row) => ({
      row,
      record: rowToRecord(parsed.headers, row.values),
      result: validateRow(row, parsed.headers, ctx),
    }));

    const persisted = await persistIntakeEvidence(tx, {
      tenantId: user.tenantId,
      userId: user.userId,
      batchId: batch.id,
      filename: file.name,
      mimeType: file.type || 'text/csv',
      bytes: buffer,
      sourceSystem,
      checksum,
      autoLinkDocument: !fields.sourceDocumentId,
    });

    await emitAgentEvent(tx, {
      tenantId: user.tenantId,
      userId: user.userId,
      workflowName: 'platform',
      correlationId: batch.id,
    }, 'intake.batch_uploaded', {
      batchId: batch.id,
      rows: records.length,
      documentId: persisted?.documentId ?? null,
    });

    for (const { row, record, result } of records) {
      await tx.insert(importBatchRows).values({
        tenantId: user.tenantId,
        batchId: batch.id,
        rowNumber: row.lineNumber,
        raw: record,
        normalized: result.normalized ?? null,
        validation: result.issues.length > 0
          ? { codes: result.issues.map((i) => i.code), issues: result.issues }
          : null,
        status: result.status,
      });
    }

    const summary = buildBatchSummary(records.map(({ row, result }) => ({ lineNumber: row.lineNumber, result })));
    const rowStatus = summary.errorCount === records.length ? 'failed' : 'ready_for_review';
    const [updated] = await tx.update(importBatches).set({
      rowCount: records.length,
      status: rowStatus,
      validationSummary: summary,
      controlTotals: {
        debit: summary.controlTotals.debitTotal,
        credit: summary.controlTotals.creditTotal,
        balanced: summary.controlTotals.balanced,
      },
      headers: parsed.headers,
      failureReason: rowStatus === 'failed' ? 'Every row failed validation' : null,
      failedAt: rowStatus === 'failed' ? new Date() : null,
    }).where(eq(importBatches.id, batch.id)).returning();

    await recordBatchEvent(tx, {
      tenantId: user.tenantId, batchId: batch.id, eventType: 'batch.validated',
      actorType: 'system',
      afterState: { status: rowStatus, errorCount: summary.errorCount, warningCount: summary.warningCount, okCount: summary.okCount },
    });

    return c.json({
      batch: updated,
      duplicate: false,
      summary: {
        rows: records.length,
        ok: summary.okCount,
        errors: summary.errorCount,
        warnings: summary.warningCount,
        controlTotals: summary.controlTotals,
      },
    }, 201);
  });
});

intakeRoutes.get('/batches', async (c) => {
  const user = c.get('user');
  const status = c.req.query('status');
  const entityId = c.req.query('entityId');
  const limit = Math.min(Number(c.req.query('limit') ?? 50), 200);
  const offset = Math.max(Number(c.req.query('offset') ?? 0), 0);

  return withTenantContext(user.tenantId, async (tx) => {
    const conditions = [eq(importBatches.tenantId, user.tenantId)];
    if (status) conditions.push(eq(importBatches.status, status));
    if (entityId) conditions.push(eq(importBatches.entityId, entityId));

    const batches = await tx.select().from(importBatches)
      .where(and(...conditions))
      .orderBy(desc(importBatches.createdAt))
      .limit(limit).offset(offset);

    return c.json({ batches, limit, offset });
  });
});

intakeRoutes.get('/batches/:id', async (c) => {
  const user = c.get('user');
  const batchId = c.req.param('id');

  return withTenantContext(user.tenantId, async (tx) => {
    const batch = await requireBatch(tx, user.tenantId, batchId);
    const events = await listBatchEvents(tx, user.tenantId, batchId);
    const [rowStats] = await tx.select({
      total: sql<number>`count(*)::int`,
      ok: sql<number>`count(*) filter (where status = 'ok')::int`,
      errors: sql<number>`count(*) filter (where status = 'error')::int`,
      warnings: sql<number>`count(*) filter (where status = 'warning')::int`,
    }).from(importBatchRows).where(eq(importBatchRows.batchId, batchId));

    return c.json({ batch, events, rowStats });
  });
});

intakeRoutes.get('/batches/:id/rows', async (c) => {
  const user = c.get('user');
  const batchId = c.req.param('id');
  const status = c.req.query('status');
  const limit = Math.min(Number(c.req.query('limit') ?? 100), 500);
  const offset = Math.max(Number(c.req.query('offset') ?? 0), 0);

  return withTenantContext(user.tenantId, async (tx) => {
    await requireBatch(tx, user.tenantId, batchId);
    const conditions = [eq(importBatchRows.batchId, batchId)];
    if (status) conditions.push(eq(importBatchRows.status, status));

    const rows = await tx.select().from(importBatchRows)
      .where(and(...conditions))
      .orderBy(importBatchRows.rowNumber)
      .limit(limit).offset(offset);

    return c.json({ rows, limit, offset });
  });
});

// ── Validate / fail ──

intakeRoutes.post('/batches/:id/validate', requireMinimumRole('preparer'), async (c) => {
  const user = c.get('user');
  const { id: batchId } = c.req.param();

  return withTenantContext(user.tenantId, async (tx) => {
    const batch = await requireBatch(tx, user.tenantId, batchId);
    if (batch.status === 'committed') throw new ConflictError('Committed batches cannot be re-validated');

    const [period] = await tx.select().from(accountingPeriods).where(eq(accountingPeriods.id, batch.accountingPeriodId)).limit(1);
    const rows = await tx.select().from(importBatchRows).where(eq(importBatchRows.batchId, batchId));
    const headers = (batch.headers as string[]) ?? [];
    const ctx = period ? periodContext(period) : { periodStart: '', periodEnd: '', defaultCurrency: 'GBP' };

    for (const row of rows) {
      const record = row.raw as Record<string, string>;
      const parsedRow = { values: headers.map((h) => record[h] ?? ''), lineNumber: row.rowNumber };
      const result = validateRow(parsedRow, headers, ctx);
      await tx.update(importBatchRows).set({
        status: result.status,
        validation: result.issues.length > 0
          ? { codes: result.issues.map((i) => i.code), issues: result.issues }
          : null,
      }).where(eq(importBatchRows.id, row.id));
    }

    const refreshed = await tx.select().from(importBatchRows).where(eq(importBatchRows.batchId, batchId));
    const results = refreshed.map((row) => ({ lineNumber: row.rowNumber, result: { status: row.status, issues: [] } as any }));
    const summary = buildBatchSummary(results);

    const [updated] = await tx.update(importBatches).set({
      validationSummary: summary,
      status: summary.errorCount === rows.length ? 'failed' : 'ready_for_review',
      controlTotals: {
        debit: summary.controlTotals.debitTotal,
        credit: summary.controlTotals.creditTotal,
        balanced: summary.controlTotals.balanced,
      },
    }).where(eq(importBatches.id, batchId)).returning();

    await recordBatchEvent(tx, {
      tenantId: user.tenantId, batchId, eventType: 'batch.validated',
      actorUserId: user.userId, reason: 'Re-validation requested by reviewer',
      afterState: { status: updated.status, errorCount: summary.errorCount },
    });

    return c.json({ batch: updated, summary });
  });
});

intakeRoutes.post('/batches/:id/fail', requireMinimumRole('preparer'), zValidator('json', failSchema), async (c) => {
  const user = c.get('user');
  const { id: batchId } = c.req.param();
  const { reason } = c.req.valid('json');

  return withTenantContext(user.tenantId, async (tx) => {
    const batch = await requireBatch(tx, user.tenantId, batchId);
    if (batch.status === 'committed') throw new ConflictError('Committed batches cannot be failed');

    const [updated] = await tx.update(importBatches).set({
      status: 'failed', failureReason: reason, failedAt: new Date(),
    }).where(eq(importBatches.id, batchId)).returning();

    await recordBatchEvent(tx, {
      tenantId: user.tenantId, batchId, eventType: 'batch.failed',
      actorUserId: user.userId, reason, beforeState: { status: batch.status }, afterState: { status: 'failed' },
    });

    return c.json({ batch: updated });
  });
});

// ── Suggestions (tax memory + rules, optional AI enrichment) ──

intakeRoutes.post('/batches/:id/suggestions/generate', requireMinimumRole('preparer'), async (c) => {
  const user = c.get('user');
  const { id: batchId } = c.req.param();

  return withTenantContext(user.tenantId, async (tx) => {
    const batch = await requireBatch(tx, user.tenantId, batchId);
    const [entity] = await tx.select({ id: entities.id, groupId: entities.groupId }).from(entities)
      .where(eq(entities.id, batch.entityId)).limit(1);
    const [period] = await tx.select().from(accountingPeriods).where(eq(accountingPeriods.id, batch.accountingPeriodId)).limit(1);
    const periodStart = period?.startDate ?? '';

    const generated = await generateSuggestionsForBatch(
      tx, user.tenantId, batchId, periodStart, entity?.id ?? null, entity?.groupId ?? null,
    );

    let aiGenerated = 0;
    if (isAiConfigured() && generated.length > 0) {
      const candidateRows = generated.map((g) => ({
        batchRowId: g.batchRowId, accountName: g.accountName, accountNumber: '', accountType: '',
      }));
      try {
        const aiSuggestions = await enrichSuggestionsWithAi(tx, {
          tenantId: user.tenantId, userId: user.userId, workflowName: 'intake-suggestions', promptVersion: 'intake-suggestion-v1',
        }, candidateRows);

        for (const s of aiSuggestions) {
          const exists = generated.some((g) => g.batchRowId === s.batchRowId);
          if (exists) continue;
          await tx.insert(mappingSuggestions).values({
            tenantId: user.tenantId, batchId, batchRowId: s.batchRowId,
            entityId: entity?.id ?? null, period: periodStart,
            suggestedTaxAccountType: s.taxAccountType, bookTreatment: s.bookTreatment, timingCategory: s.timingCategory,
            confidenceScore: String(s.confidenceScore), source: 'ai', rationale: s.explanation, status: 'pending',
          }).onConflictDoNothing();
          aiGenerated++;
        }
      } catch (err) {
        logger.warn({ err }, '[Intake] AI enrichment skipped — deterministic suggestions unaffected');
      }
    }

    await recordBatchEvent(tx, {
      tenantId: user.tenantId, batchId, eventType: 'batch.suggestions_generated',
      actorUserId: user.userId, afterState: { deterministic: generated.length, ai: aiGenerated },
    });

    await emitAgentEvent(tx, {
      tenantId: user.tenantId,
      userId: user.userId,
      workflowName: 'intake_agent',
      correlationId: batchId,
    }, 'intake.suggestions_generated', {
      batchId,
      deterministic: generated.length,
      ai: aiGenerated,
    });

    return c.json({ generated: generated.length, aiGenerated, message: 'Mapping suggestions generated. Review them, then commit.' });
  });
});

intakeRoutes.get('/batches/:id/suggestions', async (c) => {
  const user = c.get('user');
  const batchId = c.req.param('id');

  return withTenantContext(user.tenantId, async (tx) => {
    await requireBatch(tx, user.tenantId, batchId);
    const suggestions = await tx.select().from(mappingSuggestions)
      .where(and(eq(mappingSuggestions.tenantId, user.tenantId), eq(mappingSuggestions.batchId, batchId)))
      .orderBy(mappingSuggestions.createdAt);
    return c.json({ suggestions });
  });
});

intakeRoutes.post('/suggestions/:id/decide', requireMinimumRole('preparer'), zValidator('json', decideSchema), async (c) => {
  const user = c.get('user');
  const { id: suggestionId } = c.req.param();
  const { decision, reason, override } = c.req.valid('json');

  return withTenantContext(user.tenantId, async (tx) => {
    const [suggestion] = await tx.select().from(mappingSuggestions)
      .where(and(eq(mappingSuggestions.tenantId, user.tenantId), eq(mappingSuggestions.id, suggestionId)))
      .limit(1);
    if (!suggestion) throw new NotFoundError('Mapping suggestion', suggestionId);
    if (suggestion.status !== 'pending') throw new ConflictError('Suggestion is not pending review');

    const suggestionBatchId = suggestion.batchId;
    const suggestionRowId = suggestion.batchRowId;
    const batch = suggestionBatchId ? await requireBatch(tx, user.tenantId, suggestionBatchId) : null;
    const [period] = batch
      ? await tx.select().from(accountingPeriods).where(eq(accountingPeriods.id, batch.accountingPeriodId)).limit(1)
      : [];
    const [row] = suggestionRowId && suggestionBatchId
      ? await tx.select().from(importBatchRows)
          .where(and(eq(importBatchRows.id, suggestionRowId), eq(importBatchRows.batchId, suggestionBatchId)))
          .limit(1)
      : [];

    const applied = decision === 'override' && override
      ? { taxAccountType: override.taxAccountType, bookTreatment: override.bookTreatment, timingCategory: override.timingCategory ?? null }
      : { taxAccountType: suggestion.suggestedTaxAccountType, bookTreatment: suggestion.bookTreatment, timingCategory: suggestion.timingCategory ?? null };

    const nextStatus = decision === 'accept' ? 'accepted' : decision === 'reject' ? 'rejected' : 'overridden';
    const [updated] = await tx.update(mappingSuggestions).set({
      status: nextStatus,
      decidedByUserId: user.userId,
      decidedAt: new Date(),
      decisionReason: reason ?? null,
      overriddenFrom: decision === 'override'
        ? { suggestedTaxAccountType: suggestion.suggestedTaxAccountType, bookTreatment: suggestion.bookTreatment }
        : null,
    }).where(eq(mappingSuggestions.id, suggestionId)).returning();

    await recordFeedback(tx, {
      tenantId: user.tenantId,
      batchId: suggestionBatchId,
      feedbackType: decision === 'accept' ? 'accepted' : decision === 'reject' ? 'rejected' : 'overridden',
      subjectKind: 'mapping_suggestion',
      subjectId: suggestion.id,
      suggested: { taxAccountType: suggestion.suggestedTaxAccountType, bookTreatment: suggestion.bookTreatment },
      applied,
      reason: reason ?? null,
      createdByUserId: user.userId,
    });

    if (decision !== 'reject' && row) {
      const normalized = row.normalized as any;
      await tx.insert(taxMemoryPrecedents).values({
        tenantId: user.tenantId,
        entityId: suggestion.entityId ?? null,
        jurisdiction: 'UK_FRS102',
        effectiveFrom: period?.startDate ?? suggestion.period ?? '',
        effectiveTo: period?.endDate ?? null,
        accountName: normalized?.accountName ?? suggestion.citedAccountName ?? 'Imported account',
        accountNumber: normalized?.accountNumber ?? null,
        accountType: normalized?.accountType ?? 'Expense',
        detailType: normalized?.detailType ?? null,
        taxAccountType: applied.taxAccountType,
        bookTreatment: applied.bookTreatment,
        timingCategory: applied.timingCategory ?? null,
        source: decision === 'override' ? 'reviewer_corrected' : 'approved_mapping',
        createdByUserId: user.userId,
      }).onConflictDoNothing();
    }

    if (batch) {
      await recordBatchEvent(tx, {
        tenantId: user.tenantId, batchId: batch.id, eventType: `batch.suggestion_${nextStatus}`,
        actorUserId: user.userId, reason: reason ?? null, afterState: { suggestionId: suggestion.id, applied },
      });
    }

    return c.json({ suggestion: updated });
  });
});

// ── Commit gate ──

intakeRoutes.post('/batches/:id/commit', requireMinimumRole('preparer'), async (c) => {
  const user = c.get('user');
  const { id: batchId } = c.req.param();

  return withTenantContext(user.tenantId, async (tx) => {
    const batch = await requireBatch(tx, user.tenantId, batchId);
    if (batch.status === 'committed') throw new ConflictError('Batch is already committed');
    if (batch.status !== 'ready_for_review') {
      throw new ConflictError(`Batch is not ready for review (status: ${batch.status})`);
    }

    const errorRows = await tx.select({ id: importBatchRows.id }).from(importBatchRows)
      .where(and(eq(importBatchRows.batchId, batchId), eq(importBatchRows.status, 'error')));

    if (errorRows.length > 0) {
      const codes = [...new Set(
        (await tx.select({ validation: importBatchRows.validation }).from(importBatchRows)
          .where(and(eq(importBatchRows.batchId, batchId), eq(importBatchRows.status, 'error'))))
          .flatMap((r) => ((r.validation as any)?.codes ?? ['UNKNOWN']) as string[]),
      )];
      throw new ConflictError(`Batch has ${errorRows.length} rows that failed validation (${codes.join(', ')})`);
    }

    const committableRows = await tx.select().from(importBatchRows)
      .where(and(eq(importBatchRows.batchId, batchId), eq(importBatchRows.status, 'ok')));

    // ── Sign-convention gate (Feature 2). Deterministic, human-decided, never
    // silent: INVERTED blocks commit until a reviewer confirms (the transform
    // below then applies once); MIXED raises a warning item and commits as-is.
    let signReport: SignConventionReport | null = null;
    let signTransformByRowId: Map<string, NormalizedRow> | null = null;
    let signBeforeTotals: Record<string, string> | null = null;
    if (isIntakeSignConventionEnabled()) {
      const normals = committableRows
        .filter((r) => (r as { normalized: unknown }).normalized)
        .map((r) => (r as { normalized: unknown }).normalized as NormalizedRow);
      signReport = detectSignConvention(normals);
      if (signReport.classification === 'mixed') {
        await ensureSignReviewItem(tx, user.tenantId, batch, signReport);
        await recordBatchEvent(tx, {
          tenantId: user.tenantId, batchId, eventType: 'batch.sign_convention_mixed',
          actorType: 'system', afterState: { code: signReport.code, totals: signTotalsByType(normals) },
        });
      } else if (signReport.classification === 'inverted') {
        const item = await findLatestSignItem(tx, user.tenantId, batchId, 'SIGN_CONVENTION_INVERTED');
        const confirmed = item?.status === 'resolved' && (item.metadata as { decision?: string } | null)?.decision === 'confirmed';
        if (!confirmed) {
          const openItem = await ensureSignReviewItem(tx, user.tenantId, batch, signReport);
          throw new ConflictError(
            `SIGN_CONVENTION_INVERTED: batch signs are fully inverted (review item ${openItem.id}). A reviewer must confirm (applies a × −1 correction) or reject (fix the source file) before commit.`,
          );
        }
        // Re-verify on the live rows before transforming: the confirmation was
        // recorded against an earlier read, and must only correct data that is
        // still inverted. (No route mutates uncommitted rows today, so this is
        // defense-in-depth against a future row-editing endpoint.)
        const fresh = detectSignConvention(normals);
        if (fresh.classification !== 'inverted') {
          signReport = fresh;
        } else {
          signBeforeTotals = signTotalsByType(normals);
          // Index by row id from the filtered list (not committableRows) so a
          // null-normalized row can never misalign the transform.
          const withIds = committableRows
            .filter((r) => (r as { normalized: unknown }).normalized)
            .map((r) => ({ id: (r as { id: string }).id, normalized: (r as { normalized: unknown }).normalized as NormalizedRow }));
          const transformed = applySignInversion(withIds.map((w) => w.normalized));
          signTransformByRowId = new Map(withIds.map((w, i) => [w.id, transformed[i]]));
        }
      }
    }

    // ── Prior-period bridge gate (Feature 3). New/missing/renamed accounts
    // surface as proposals/warnings (never blocking); an unresolved
    // OPENING_BALANCE_MISMATCH blocks commit — the deferred-tax rollforward
    // must never silently disagree with the prior locked close.
    let bridgeSummary: {
      hasPriorRun: boolean; priorRunId: string | null;
      newAccounts: number; missingAccounts: number; renames: number; mismatches: number;
    } | null = null;
    if (isIntakePriorBridgeEnabled()) {
      const [bridgePeriod] = await tx.select().from(accountingPeriods)
        .where(and(eq(accountingPeriods.tenantId, user.tenantId), eq(accountingPeriods.id, batch.accountingPeriodId)))
        .limit(1);
      if (bridgePeriod) {
        const priorRun = await findPriorLockedRun(tx, user.tenantId, batch.entityId, bridgePeriod.startDate);
        if (priorRun) {
          const effectiveNormals = committableRows
            .map((r) => signTransformByRowId?.get((r as { id: string }).id) ?? ((r as { normalized: unknown }).normalized as NormalizedRow | null))
            .filter((n): n is NormalizedRow => !!n);
          const bridgeResult = diffPriorPeriod(
            await loadPriorBridgeAccounts(tx, user.tenantId, priorRun),
            bridgeCurrentAccounts(effectiveNormals),
          );
          await persistBridgeResult(tx, user.tenantId, batch, bridgeResult, priorRun.id);
          bridgeSummary = {
            hasPriorRun: true,
            priorRunId: priorRun.id,
            newAccounts: bridgeResult.newAccounts.length,
            missingAccounts: bridgeResult.missingAccounts.length,
            renames: bridgeResult.renames.length,
            mismatches: bridgeResult.mismatches.length,
          };
          const blocking = await tx.select({ id: reviewItems.id }).from(reviewItems).where(and(
            eq(reviewItems.tenantId, user.tenantId),
            eq(reviewItems.sourceRef, bridgeSourceRef(batchId)),
            eq(reviewItems.itemType, 'OPENING_BALANCE_MISMATCH'),
            not(inArray(reviewItems.status, [...BRIDGE_FINAL_STATUSES])),
          ));
          if (blocking.length > 0) {
            throw new ConflictError(
              `OPENING_BALANCE_MISMATCH: ${blocking.length} balance-sheet opening(s) disagree with the prior locked close (review item(s) ${blocking.map((b) => b.id).join(', ')}). A reviewer must resolve each with a reason before commit.`,
            );
          }
        } else {
          bridgeSummary = { hasPriorRun: false, priorRunId: null, newAccounts: 0, missingAccounts: 0, renames: 0, mismatches: 0 };
        }
      }
    }

    let committedRows = 0;
    const importedAccountIds = new Set<string>();

    for (const row of committableRows) {
      const normalized = (signTransformByRowId?.get((row as { id: string }).id) ?? (row as { normalized: unknown }).normalized) as any;
      if (!normalized) continue;

      const [entity] = await tx.insert(entities).values({
        tenantId: user.tenantId,
        externalId: normalized.entityExternalId,
        name: normalized.entityName,
        type: 'domestic',
        currency: normalized.currency || 'GBP',
        isConsolidated: true,
        taxJurisdiction: 'UK_FRS102',
      }).onConflictDoUpdate({
        target: [entities.tenantId, entities.externalId],
        set: { name: normalized.entityName, currency: normalized.currency || 'GBP', updatedAt: new Date() },
      }).returning();

      const [account] = await tx.insert(accounts).values({
        tenantId: user.tenantId,
        externalId: normalized.accountExternalId,
        accountNumber: normalized.accountNumber || null,
        name: normalized.accountName,
        type: normalized.accountType,
        detailType: normalized.detailType || null,
        isSummary: false,
      }).onConflictDoUpdate({
        target: [accounts.tenantId, accounts.externalId],
        set: {
          accountNumber: normalized.accountNumber || null,
          name: normalized.accountName,
          type: normalized.accountType,
          detailType: normalized.detailType || null,
          updatedAt: new Date(),
        },
      }).returning();

      const periodDate = new Date(`${normalized.period}T00:00:00.000Z`);
      const [tb] = await tx.insert(trialBalance).values({
        tenantId: user.tenantId,
        entityId: entity.id,
        accountId: account.id,
        period: normalized.period,
        periodEnd: normalized.periodEnd,
        fiscalYear: periodDate.getUTCFullYear(),
        fiscalPeriod: periodDate.getUTCMonth() + 1,
        debit: String(normalized.debit),
        credit: String(normalized.credit),
        balance: String(normalized.balance),
        source: batch.sourceType,
        sourceDocumentId: batch.sourceDocumentId,
      }).onConflictDoUpdate({
        target: [trialBalance.tenantId, trialBalance.entityId, trialBalance.accountId, trialBalance.period, trialBalance.source],
        set: {
          debit: String(normalized.debit),
          credit: String(normalized.credit),
          balance: String(normalized.balance),
          sourceDocumentId: batch.sourceDocumentId,
        },
      }).returning();

      await tx.update(importBatchRows).set({
        status: 'committed',
        accountId: account.id,
        committedTrialBalanceId: tb.id,
        // Sign-corrected normalized values are what the engine consumed; the
        // immutable raw upload (row.raw + source document bytes) is untouched.
        ...(signTransformByRowId ? { normalized } : {}),
      }).where(eq(importBatchRows.id, row.id));

      importedAccountIds.add(account.id);
      committedRows++;

      await tx.insert(dataLineageEdges).values({
        tenantId: user.tenantId,
        sourceKind: 'import_batch', sourceId: batchId,
        targetKind: 'import_batch_row', targetId: row.id,
        relation: 'contains',
      }).onConflictDoNothing();

      await tx.insert(dataLineageEdges).values({
        tenantId: user.tenantId,
        sourceKind: 'import_batch_row', sourceId: row.id,
        targetKind: 'trial_balance', targetId: tb.id,
        relation: 'committed_to',
      }).onConflictDoNothing();
    }

    const superseded = await tx.update(importBatches).set({
      status: 'superseded', supersededByBatchId: batchId,
    }).where(and(
      eq(importBatches.tenantId, user.tenantId),
      eq(importBatches.entityId, batch.entityId),
      eq(importBatches.accountingPeriodId, batch.accountingPeriodId),
      eq(importBatches.sourceType, batch.sourceType),
      eq(importBatches.status, 'committed'),
      sql`${importBatches.id} <> ${batchId}`,
    )).returning({ id: importBatches.id });

    if (batch.sourceDocumentId) {
      await tx.insert(dataLineageEdges).values({
        tenantId: user.tenantId,
        sourceKind: 'source_document', sourceId: batch.sourceDocumentId,
        targetKind: 'import_batch', targetId: batchId,
        relation: 'source_of',
      }).onConflictDoNothing();

      await tx.insert(evidenceLinks).values({
        tenantId: user.tenantId,
        subjectKind: 'import_batch', subjectId: batchId,
        documentId: batch.sourceDocumentId,
        evidenceRole: 'source',
        createdByUserId: user.userId,
      }).onConflictDoNothing();
    }

    const [committed] = await tx.update(importBatches).set({
      status: 'committed', committedAt: new Date(), reviewedByUserId: user.userId,
    }).where(eq(importBatches.id, batchId)).returning();

    for (const s of superseded) {
      await recordBatchEvent(tx, {
        tenantId: user.tenantId, batchId: s.id, eventType: 'batch.superseded',
        actorType: 'system', reason: `Superseded by batch ${batchId}`, afterState: { status: 'superseded' },
      });
    }

    // The reviewer-confirmed × −1 correction is fully auditable: before/after
    // per-type totals land in the batch's append-only event ledger. (Note:
    // provision_events cannot host this — its provision_run_id is NOT NULL
    // and no run exists at intake-commit time. The batch ledger plus the
    // resolved SIGN_CONVENTION_INVERTED review item is the audit trail.)
    if (signTransformByRowId && signBeforeTotals) {
      const afterRows = await tx.select({ normalized: importBatchRows.normalized }).from(importBatchRows)
        .where(and(eq(importBatchRows.batchId, batchId), eq(importBatchRows.status, 'committed')));
      await recordBatchEvent(tx, {
        tenantId: user.tenantId, batchId, eventType: 'batch.sign_convention_applied',
        actorUserId: user.userId,
        beforeState: { totals: signBeforeTotals },
        afterState: { totals: signTotalsByType(afterRows.map((r) => r.normalized as NormalizedRow)) },
        reason: 'Reviewer-confirmed sign inversion applied once at commit time.',
      });
    }

    await recordBatchEvent(tx, {
      tenantId: user.tenantId, batchId, eventType: 'batch.committed',
      actorUserId: user.userId,
      beforeState: { status: 'ready_for_review' },
      afterState: { status: 'committed', committedRows, accounts: importedAccountIds.size },
    });

    await emitAgentEvent(tx, {
      tenantId: user.tenantId,
      userId: user.userId,
      workflowName: 'intake_agent',
      correlationId: batchId,
    }, 'intake.batch_committed', {
      batchId,
      committedRows,
      accounts: importedAccountIds.size,
    });

    logger.info({ batchId, committedRows, accounts: importedAccountIds.size }, '[Intake] Batch committed');

    return c.json({
      batch: committed,
      committedRows,
      accounts: importedAccountIds.size,
      supersededBatches: superseded.map((s) => s.id),
      ...(signReport ? {
        signConvention: {
          classification: signReport.classification,
          code: signReport.code,
          applied: signTransformByRowId !== null,
        },
      } : {}),
      ...(bridgeSummary ? { priorBridge: bridgeSummary } : {}),
    });
  });
});

// ── Evidence links ──

intakeRoutes.post('/evidence-links', requireMinimumRole('preparer'), zValidator('json', evidenceSchema), async (c) => {
  const user = c.get('user');
  const { subjectKind, subjectId, documentId, evidenceRole, note } = c.req.valid('json');

  return withTenantContext(user.tenantId, async (tx) => {
    await verifyDocument(tx, user.tenantId, documentId);
    const [link] = await tx.insert(evidenceLinks).values({
      tenantId: user.tenantId, subjectKind, subjectId, documentId, evidenceRole, note: note ?? null, createdByUserId: user.userId,
    }).returning();
    return c.json({ link }, 201);
  });
});

intakeRoutes.post('/batches/:id/evidence', requireMinimumRole('preparer'), zValidator('json', batchEvidenceSchema), async (c) => {
  const user = c.get('user');
  const { id: batchId } = c.req.param();
  const { documentId, note } = c.req.valid('json');

  return withTenantContext(user.tenantId, async (tx) => {
    await requireBatch(tx, user.tenantId, batchId);
    await verifyDocument(tx, user.tenantId, documentId);
    const [link] = await tx.insert(evidenceLinks).values({
      tenantId: user.tenantId, subjectKind: 'import_batch', subjectId: batchId, documentId, evidenceRole: 'supporting', note: note ?? null, createdByUserId: user.userId,
    }).returning();
    await recordBatchEvent(tx, {
      tenantId: user.tenantId, batchId, eventType: 'batch.evidence_linked', actorUserId: user.userId, afterState: { documentId },
    });
    return c.json({ link }, 201);
  });
});

intakeRoutes.get('/evidence-links', async (c) => {
  const user = c.get('user');
  return withTenantContext(user.tenantId, async (tx) => {
    const links = await listEvidenceLinks(tx, user.tenantId, c.req.query('subjectKind'), c.req.query('subjectId'));
    return c.json({ links });
  });
});

intakeRoutes.delete('/evidence-links/:id', requireMinimumRole('preparer'), async (c) => {
  const user = c.get('user');
  const { id: linkId } = c.req.param();

  return withTenantContext(user.tenantId, async (tx) => {
    const [link] = await tx.select().from(evidenceLinks)
      .where(and(eq(evidenceLinks.tenantId, user.tenantId), eq(evidenceLinks.id, linkId)))
      .limit(1);
    if (!link) throw new NotFoundError('Evidence link', linkId);
    await tx.delete(evidenceLinks).where(eq(evidenceLinks.id, linkId));
    return c.json({ deleted: true });
  });
});

// ── Tax memory / lineage ──

intakeRoutes.get('/memory/precedents', async (c) => {
  const user = c.get('user');
  const query = c.req.query('query');
  const entityId = c.req.query('entityId');
  const limit = Math.min(Number(c.req.query('limit') ?? 50), 200);

  return withTenantContext(user.tenantId, async (tx) => {
    const conditions = [eq(taxMemoryPrecedents.tenantId, user.tenantId)];
    if (entityId) conditions.push(eq(taxMemoryPrecedents.entityId, entityId));
    if (query) conditions.push(sql`lower(${taxMemoryPrecedents.accountName}) LIKE ${`%${query.toLowerCase()}%`}`);
    const precedents = await tx.select().from(taxMemoryPrecedents)
      .where(and(...conditions))
      .orderBy(desc(taxMemoryPrecedents.createdAt))
      .limit(limit);
    return c.json({ precedents });
  });
});

intakeRoutes.get('/lineage/account/:accountId', async (c) => {
  const user = c.get('user');
  const accountId = c.req.param('accountId');

  return withTenantContext(user.tenantId, async (tx) => {
    const graph = await getLineageForAccount(tx, user.tenantId, accountId);
    return c.json(graph);
  });
});

intakeRoutes.get('/lineage/run/:runId', async (c) => {
  const user = c.get('user');
  const runId = c.req.param('runId');

  return withTenantContext(user.tenantId, async (tx) => {
    const graph = await getLineageForRun(tx, user.tenantId, runId);
    return c.json(graph);
  });
});

// ── XLSX ingest with column mapping (Feature 1, behind INTAKE_XLSX) ──

const XLSX_PARSER_VERSION = 'intake-xlsx-v1';

function requireXlsxEnabled(): void {
  if (!isIntakeXlsxEnabled()) {
    throw new ForbiddenError('XLSX ingest is disabled (INTAKE_XLSX off)');
  }
}

async function loadUploadBytes(tx: any, tenantId: string, uploadId: string): Promise<{ bytes: Buffer; filename: string }> {
  const [doc] = await tx.select().from(sourceDocuments)
    .where(and(eq(sourceDocuments.tenantId, tenantId), eq(sourceDocuments.id, uploadId)))
    .limit(1);
  if (!doc) throw new NotFoundError('Upload', uploadId);
  const storage = getStorage();
  try {
    const bytes = await storage.get(doc.storageKey);
    return { bytes: Buffer.from(bytes), filename: doc.filename };
  } catch {
    throw new NotFoundError('Upload bytes', uploadId);
  }
}

intakeRoutes.post('/xlsx-upload', requireMinimumRole('preparer'), async (c) => {
  requireXlsxEnabled();
  const user = c.get('user');
  const form = await c.req.parseBody();
  const file = form['file'];
  if (!(file instanceof File)) {
    throw new BadRequestError('No file uploaded. Use multipart field name "file".');
  }
  const filename = file.name;
  const lower = filename.toLowerCase();
  if ((lower.endsWith('.xls') && !lower.endsWith('.xlsx') && !lower.endsWith('.xlsm')) || (!lower.endsWith('.xlsx') && !lower.endsWith('.xlsm'))) {
    throw new BadRequestError(`UNSUPPORTED_FORMAT: Unsupported file type: ${filename}. XLSX ingest accepts .xlsx and .xlsm only.`, { code: 'UNSUPPORTED_FORMAT' });
  }
  const buffer = Buffer.from(await file.arrayBuffer());
  if (buffer.length > XLSX_MAX_BYTES) {
    throw new BadRequestError(`File too large: ${(buffer.length / 1024 / 1024).toFixed(1)}MB. Maximum XLSX upload size is ${XLSX_MAX_BYTES / 1024 / 1024}MB.`);
  }

  const workbook = await parseXlsxBuffer(buffer, filename);
  const previews = buildSheetPreviews(workbook);
  const checksum = storageSha256(buffer);

  const uploadId = await withTenantContext(user.tenantId, async (tx) => {
    const docId = crypto.randomUUID();
    const storageKey = buildStorageKey({
      tenantId: user.tenantId,
      documentType: 'intake_xlsx',
      docId,
      version: 1,
      filename,
    });
    await getStorage().put(storageKey, buffer);
    try {
      await tx.insert(sourceDocuments).values({
        id: docId,
        tenantId: user.tenantId,
        documentType: 'intake_xlsx',
        filename,
        mimeType: (file as File).type || 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        sizeBytes: buffer.length,
        storageKey,
        sha256: checksum,
        provenance: 'manual_upload',
        sourceSystem: 'xlsx-upload',
        extractionStatus: 'not_required',
        parserVersion: XLSX_PARSER_VERSION,
        uploadedByUserId: user.userId,
      });
    } catch (err) {
      try { await getStorage().delete(storageKey); } catch { /* best effort */ }
      throw err;
    }
    return docId;
  });

  return c.json({
    uploadId,
    filename,
    checksum,
    sheets: previews.map((p) => p.name),
    previews,
  }, 201);
});

const previewSchema = z.object({
  uploadId: z.string().uuid(),
});

intakeRoutes.post('/preview', zValidator('json', previewSchema), async (c) => {
  requireXlsxEnabled();
  const user = c.get('user');
  const { uploadId } = c.req.valid('json');

  return withTenantContext(user.tenantId, async (tx) => {
    const { bytes, filename } = await loadUploadBytes(tx, user.tenantId, uploadId);
    const workbook = await parseXlsxBuffer(bytes, filename);
    const previews = buildSheetPreviews(workbook);

    // Suggest the remembered column map when this client's layout matches.
    const suggestions: Record<string, Record<string, string> | null> = {};
    for (const preview of previews) {
      const firstHeader = preview.headerCandidates[0];
      if (firstHeader === undefined) {
        suggestions[preview.name] = null;
        continue;
      }
      const grid = workbook.sheets.find((s) => s.name === preview.name);
      const headerRow = grid?.rows.find((r) => r.rowNumber === firstHeader);
      const headers = headerRow?.cells ?? [];
      if (headers.length === 0) {
        suggestions[preview.name] = null;
        continue;
      }
      const fingerprint = buildClientFingerprint(preview.name, headers);
      const [saved] = await tx.select().from(intakeColumnMaps)
        .where(and(eq(intakeColumnMaps.tenantId, user.tenantId), eq(intakeColumnMaps.clientFingerprint, fingerprint)))
        .limit(1);
      suggestions[preview.name] = (saved?.columnMap as Record<string, string> | null) ?? null;
    }

    return c.json({
      uploadId,
      sheets: previews.map((p) => p.name),
      previews,
      suggestedColumnMaps: suggestions,
    });
  });
});

const columnMapSchema = z.object({
  uploadId: z.string().uuid(),
  sheetName: z.string().min(1).max(255),
  headerRow: z.number().int().min(1).max(1000),
  columnMap: z.record(z.string(), z.string()),
  entityId: z.string().uuid(),
  accountingPeriodId: z.string().uuid(),
  sourceSystem: z.string().max(100).optional(),
  sourceReference: z.string().max(255).optional(),
});

intakeRoutes.post('/column-map', requireMinimumRole('preparer'), zValidator('json', columnMapSchema), async (c) => {
  requireXlsxEnabled();
  const user = c.get('user');
  const input = c.req.valid('json');

  // Validate canonical targets early for a stable error shape.
  for (const target of Object.values(input.columnMap)) {
    if (!(CANONICAL_FIELDS as readonly string[]).includes(target)) {
      throw new BadRequestError(`UNKNOWN_FIELD: Canonical field "${target}" is not a known intake field (${CANONICAL_FIELDS.join(', ')}).`, { code: 'UNKNOWN_FIELD' });
    }
  }

  return withTenantContext(user.tenantId, async (tx) => {
    const { bytes, filename } = await loadUploadBytes(tx, user.tenantId, input.uploadId);
    const workbook = await parseXlsxBuffer(bytes, filename);
    const sheet = workbook.sheets.find((s) => s.name === input.sheetName);
    if (!sheet) {
      throw new BadRequestError(`UNKNOWN_SHEET: Sheet "${input.sheetName}" was not found in the workbook.`, { code: 'UNKNOWN_SHEET' });
    }

    const { headers, rows } = mapSheetToParsedRows(sheet, input.headerRow, input.columnMap);

    // Cross-tenant guard is intentional, in two layers: the tenantId = filter
    // below turns a foreign id into a 404 (no existence oracle), and RLS
    // (withTenantContext + USING tenant_id = app_current_tenant_id()) is the
    // deeper fail-closed backstop — the runtime role sees zero foreign rows
    // even if a filter were ever dropped.
    const [entity] = await tx.select({ id: entities.id, groupId: entities.groupId }).from(entities)
      .where(and(eq(entities.tenantId, user.tenantId), eq(entities.id, input.entityId)))
      .limit(1);
    if (!entity) throw new NotFoundError('Entity', input.entityId);

    const [period] = await tx.select().from(accountingPeriods)
      .where(and(eq(accountingPeriods.tenantId, user.tenantId), eq(accountingPeriods.id, input.accountingPeriodId)))
      .limit(1);
    if (!period) throw new NotFoundError('Accounting period', input.accountingPeriodId);

    const ctx = periodContext(period);
    const records = rows.map((row) => ({
      row,
      record: rowToRecord(headers, row.values),
      result: validateRow(row, headers, ctx),
    }));

    // Remember the map for next period: key (tenant_id, client_fingerprint).
    const headerGridRow = sheet.rows.find((r) => r.rowNumber === input.headerRow);
    const userHeaders = headerGridRow?.cells ?? Object.keys(input.columnMap);
    const fingerprint = buildClientFingerprint(input.sheetName, userHeaders);
    await tx.insert(intakeColumnMaps).values({
      tenantId: user.tenantId,
      clientFingerprint: fingerprint,
      sheetName: input.sheetName,
      headers: userHeaders,
      columnMap: input.columnMap,
      createdByUserId: user.userId,
    }).onConflictDoUpdate({
      target: [intakeColumnMaps.tenantId, intakeColumnMaps.clientFingerprint],
      set: {
        sheetName: input.sheetName,
        headers: userHeaders,
        columnMap: input.columnMap,
        updatedAt: new Date(),
      },
    });

    const fileChecksum = storageSha256(bytes);
    const mappingChecksum = crypto.createHash('sha256')
      .update(JSON.stringify({ sheetName: input.sheetName, headerRow: input.headerRow, columnMap: input.columnMap }))
      .digest('hex');
    const checksum = crypto.createHash('sha256').update(fileChecksum + mappingChecksum).digest('hex');
    const sourceSystem = input.sourceSystem ?? 'xlsx-upload';

    const [existing] = await tx.select().from(importBatches).where(and(
      eq(importBatches.tenantId, user.tenantId),
      eq(importBatches.entityId, input.entityId),
      eq(importBatches.accountingPeriodId, input.accountingPeriodId),
      eq(importBatches.sourceType, 'xlsx'),
      eq(importBatches.sourceSystem, sourceSystem),
      eq(importBatches.checksum, checksum),
    )).limit(1);
    if (existing) {
      return c.json({ batch: existing, duplicate: true, clientFingerprint: fingerprint, message: 'An identical XLSX batch already exists for this entity and period.' }, 200);
    }

    const [batch] = await tx.insert(importBatches).values({
      tenantId: user.tenantId,
      entityId: input.entityId,
      accountingPeriodId: input.accountingPeriodId,
      sourceDocumentId: input.uploadId,
      sourceType: 'xlsx',
      sourceSystem,
      sourceReference: input.sourceReference ?? `${filename}:${input.sheetName}:row${input.headerRow}`,
      originalFilename: filename,
      checksum,
      storageKey: null,
      parserVersion: XLSX_PARSER_VERSION,
      rowCount: 0,
      status: 'validating',
      createdByUserId: user.userId,
    }).returning();

    await recordBatchEvent(tx, {
      tenantId: user.tenantId, batchId: batch.id, eventType: 'batch.created',
      actorUserId: user.userId,
      afterState: { status: batch.status, filename, sheetName: input.sheetName, headerRow: input.headerRow, checksum, clientFingerprint: fingerprint },
    });

    for (const { row, record, result } of records) {
      await tx.insert(importBatchRows).values({
        tenantId: user.tenantId,
        batchId: batch.id,
        rowNumber: row.lineNumber,
        raw: record,
        normalized: result.normalized ?? null,
        validation: result.issues.length > 0
          ? { codes: result.issues.map((i) => i.code), issues: result.issues }
          : null,
        status: result.status,
      });
    }

    const summary = buildBatchSummary(records.map(({ row, result }) => ({ lineNumber: row.lineNumber, result })));
    const rowStatus = summary.errorCount === records.length && records.length > 0 ? 'failed' : 'ready_for_review';
    const [updated] = await tx.update(importBatches).set({
      rowCount: records.length,
      status: rowStatus,
      validationSummary: summary,
      controlTotals: {
        debit: summary.controlTotals.debitTotal,
        credit: summary.controlTotals.creditTotal,
        balanced: summary.controlTotals.balanced,
      },
      headers,
      failureReason: rowStatus === 'failed' ? 'Every row failed validation' : null,
      failedAt: rowStatus === 'failed' ? new Date() : null,
    }).where(eq(importBatches.id, batch.id)).returning();

    await recordBatchEvent(tx, {
      tenantId: user.tenantId, batchId: batch.id, eventType: 'batch.validated',
      actorType: 'system',
      afterState: { status: rowStatus, errorCount: summary.errorCount, warningCount: summary.warningCount, okCount: summary.okCount, parser: XLSX_PARSER_VERSION },
    });

    await emitAgentEvent(tx, {
      tenantId: user.tenantId,
      userId: user.userId,
      workflowName: 'platform',
      correlationId: batch.id,
    }, 'intake.batch_uploaded', {
      batchId: batch.id,
      rows: records.length,
      documentId: input.uploadId,
      parser: XLSX_PARSER_VERSION,
    });

    return c.json({
      batch: updated,
      duplicate: false,
      clientFingerprint: fingerprint,
      summary: {
        rows: records.length,
        ok: summary.okCount,
        errors: summary.errorCount,
        warnings: summary.warningCount,
        controlTotals: summary.controlTotals,
      },
    }, 201);
  });
});

intakeRoutes.get('/column-maps', async (c) => {
  requireXlsxEnabled();
  const user = c.get('user');
  const fingerprint = c.req.query('fingerprint');
  const sheetName = c.req.query('sheetName');
  const headersParam = c.req.query('headers');

  return withTenantContext(user.tenantId, async (tx) => {
    let fp = fingerprint;
    if (!fp && sheetName && headersParam) {
      const headers = headersParam.split(',').map((h) => h.trim());
      fp = buildClientFingerprint(sheetName, headers);
    }
    if (!fp) {
      throw new BadRequestError('Provide ?fingerprint= or ?sheetName=&headers=a,b,c to look up a remembered map.');
    }
    const [saved] = await tx.select().from(intakeColumnMaps)
      .where(and(eq(intakeColumnMaps.tenantId, user.tenantId), eq(intakeColumnMaps.clientFingerprint, fp)))
      .limit(1);
    if (!saved) throw new NotFoundError('Column map', fp);
    return c.json({ map: saved });
  });
});

// ── Sign-convention detection (Feature 2, behind INTAKE_SIGN_CONVENTION) ──
//
// Debit/credit control totals still balance when a source system flips every
// sign, so validate.ts cannot catch it. Detection is purely deterministic
// (see ./sign-convention.ts — no AI) and never auto-applies: an INVERTED
// batch blocks commit with a 409 until a reviewer confirms (commit then
// multiplies every amount by −1, audited) or rejects (fix the source file).
// A MIXED batch raises a warning review item and commits untransformed.

function requireSignConventionEnabled(): void {
  if (!isIntakeSignConventionEnabled()) {
    throw new ForbiddenError('Sign-convention detection is disabled (INTAKE_SIGN_CONVENTION off)');
  }
}

function signSourceRef(batchId: string): string {
  return `import_batch:${batchId}`;
}

async function findLatestSignItem(tx: any, tenantId: string, batchId: string, code: string) {
  const [item] = await tx.select().from(reviewItems)
    .where(and(
      eq(reviewItems.tenantId, tenantId),
      eq(reviewItems.itemType, code),
      eq(reviewItems.sourceRef, signSourceRef(batchId)),
    ))
    .orderBy(desc(reviewItems.createdAt))
    .limit(1);
  return item ?? null;
}

async function findOpenSignItem(tx: any, tenantId: string, batchId: string, code: string) {
  const [item] = await tx.select().from(reviewItems)
    .where(and(
      eq(reviewItems.tenantId, tenantId),
      eq(reviewItems.itemType, code),
      eq(reviewItems.sourceRef, signSourceRef(batchId)),
      eq(reviewItems.status, 'open'),
    ))
    .orderBy(desc(reviewItems.createdAt))
    .limit(1);
  return item ?? null;
}

function signItemTitle(report: SignConventionReport, batchId: string): string {
  return report.classification === 'inverted'
    ? `Sign convention inverted on import batch ${batchId.slice(0, 8)}`
    : `Sign convention mixed on import batch ${batchId.slice(0, 8)}`;
}

async function ensureSignReviewItem(
  tx: any,
  tenantId: string,
  batch: { id: string; entityId: string },
  report: SignConventionReport,
) {
  const existing = report.classification === 'inverted'
    ? await findOpenSignItem(tx, tenantId, batch.id, 'SIGN_CONVENTION_INVERTED')
    : await findOpenSignItem(tx, tenantId, batch.id, 'SIGN_CONVENTION_MIXED');
  if (existing) return existing;
  const code = report.classification === 'inverted' ? 'SIGN_CONVENTION_INVERTED' : 'SIGN_CONVENTION_MIXED';
  const [item] = await tx.insert(reviewItems).values({
    tenantId,
    provisionRunId: null,
    itemType: code,
    severity: report.severity,
    status: 'open',
    title: signItemTitle(report, batch.id),
    description: report.message,
    entityId: batch.entityId,
    sourceRef: signSourceRef(batch.id),
    metadata: { batchId: batch.id, code, totals: report.totals, signalTypes: report.signalTypes },
  }).returning();
  return item;
}

async function resolveSignReviewItem(
  tx: any,
  tenantId: string,
  userId: string,
  item: { id: string; status: string },
  decision: 'confirmed' | 'rejected',
  reason: string,
  report: SignConventionReport,
  batchId: string,
) {
  const before = { status: item.status };
  const [updated] = await tx.update(reviewItems).set({
    status: decision === 'confirmed' ? 'resolved' : 'rejected',
    resolvedByUserId: userId,
    resolutionNote: reason,
    metadata: { batchId, code: report.code, decision, totals: report.totals, signalTypes: report.signalTypes },
    resolvedAt: new Date(),
    updatedAt: new Date(),
  }).where(eq(reviewItems.id, item.id)).returning();
  await tx.insert(reviewItemEvents).values({
    tenantId,
    reviewItemId: item.id,
    eventType: 'status_changed',
    actorUserId: userId,
    reason,
    beforeState: before,
    afterState: { status: updated.status, decision },
  });
  return updated;
}

async function loadCommittableNormals(tx: any, batchId: string): Promise<{ id: string; normalized: NormalizedRow }[]> {
  const rows = await tx.select().from(importBatchRows)
    .where(and(eq(importBatchRows.batchId, batchId), eq(importBatchRows.status, 'ok')));
  return rows
    .filter((r: { normalized: unknown }) => r.normalized)
    .map((r: { id: string; normalized: unknown }) => ({ id: r.id, normalized: r.normalized as NormalizedRow }));
}

const signDecisionSchema = z.object({
  reason: z.string().max(500).optional(),
});

intakeRoutes.get('/batches/:id/sign-convention', async (c) => {
  requireSignConventionEnabled();
  const user = c.get('user');
  const { id: batchId } = c.req.param();

  return withTenantContext(user.tenantId, async (tx) => {
    await requireBatch(tx, user.tenantId, batchId);
    const normals = await loadCommittableNormals(tx, batchId);
    const report = detectSignConvention(normals.map((r) => r.normalized));
    return c.json({ batchId, report });
  });
});

intakeRoutes.post('/batches/:id/sign-convention/confirm', requireMinimumRole('reviewer'), zValidator('json', signDecisionSchema), async (c) => {
  requireSignConventionEnabled();
  const user = c.get('user');
  const { id: batchId } = c.req.param();
  const { reason } = c.req.valid('json');

  return withTenantContext(user.tenantId, async (tx) => {
    const batch = await requireBatch(tx, user.tenantId, batchId);
    if (batch.status === 'committed') throw new ConflictError('Batch is already committed');
    const normals = await loadCommittableNormals(tx, batchId);
    const report = detectSignConvention(normals.map((r) => r.normalized));
    if (report.classification !== 'inverted') {
      throw new ConflictError(`Nothing to confirm: batch sign convention is ${report.classification} (${report.code})`);
    }
    let item = await findOpenSignItem(tx, user.tenantId, batchId, 'SIGN_CONVENTION_INVERTED');
    if (!item) item = await ensureSignReviewItem(tx, user.tenantId, batch, report);
    const note = reason ?? 'Sign inversion confirmed by reviewer — commit will multiply every amount by −1.';
    const updated = await resolveSignReviewItem(tx, user.tenantId, user.userId, item, 'confirmed', note, report, batchId);
    await recordBatchEvent(tx, {
      tenantId: user.tenantId, batchId, eventType: 'batch.sign_convention_confirmed',
      actorUserId: user.userId, reason: note,
      afterState: { decision: 'confirmed', totals: signTotalsByType(normals.map((r) => r.normalized)) },
    });
    return c.json({ item: updated, report });
  });
});

intakeRoutes.post('/batches/:id/sign-convention/reject', requireMinimumRole('reviewer'), zValidator('json', signDecisionSchema), async (c) => {
  requireSignConventionEnabled();
  const user = c.get('user');
  const { id: batchId } = c.req.param();
  const { reason } = c.req.valid('json');

  return withTenantContext(user.tenantId, async (tx) => {
    const batch = await requireBatch(tx, user.tenantId, batchId);
    if (batch.status === 'committed') throw new ConflictError('Batch is already committed');
    const normals = await loadCommittableNormals(tx, batchId);
    const report = detectSignConvention(normals.map((r) => r.normalized));
    if (report.classification !== 'inverted') {
      throw new ConflictError(`Nothing to reject: batch sign convention is ${report.classification} (${report.code})`);
    }
    let item = await findOpenSignItem(tx, user.tenantId, batchId, 'SIGN_CONVENTION_INVERTED');
    if (!item) item = await ensureSignReviewItem(tx, user.tenantId, batch, report);
    const note = reason ?? 'Sign inversion rejected by reviewer — fix the source file and re-upload.';
    const updated = await resolveSignReviewItem(tx, user.tenantId, user.userId, item, 'rejected', note, report, batchId);
    await recordBatchEvent(tx, {
      tenantId: user.tenantId, batchId, eventType: 'batch.sign_convention_rejected',
      actorUserId: user.userId, reason: note,
      afterState: { decision: 'rejected', totals: signTotalsByType(normals.map((r) => r.normalized)) },
    });
    return c.json({ item: updated, report });
  });
});

// ── Prior-period bridge (Feature 3, behind INTAKE_PRIOR_BRIDGE) ──
//
// Deferred-tax rollforward assumes this period's openings match last
// period's closings. On commit, when a prior locked run exists for the same
// entity, the import is diffed against that run's approved mapped accounts:
// new accounts become mapping proposals (never review items); missing and
// renamed accounts become warning review items (renames also get a
// carry-forward proposal a human must accept — never silent); balance-sheet
// continuity breaks over OPENING_BALANCE_TOLERANCE become error review items
// that block commit until a human resolves them via the narrow endpoint
// below (same review_items table + review_item_events ledger as every other
// flow — no parallel resolution machinery).

const BRIDGE_ITEM_TYPES = ['NEW_ACCOUNT', 'MISSING_PRIOR_ACCOUNT', 'POSSIBLE_RENAME', 'OPENING_BALANCE_MISMATCH'] as const;
const BRIDGE_FINAL_STATUSES = ['resolved', 'rejected', 'waived'];

function requirePriorBridgeEnabled(): void {
  if (!isIntakePriorBridgeEnabled()) {
    throw new ForbiddenError('Prior-period bridge is disabled (INTAKE_PRIOR_BRIDGE off)');
  }
}

function bridgeSourceRef(batchId: string): string {
  return `import_batch:${batchId}`;
}

/** Latest locked run for the entity strictly before the batch's period. */
async function findPriorLockedRun(tx: any, tenantId: string, entityId: string, periodStart: string) {
  const [run] = await tx.select().from(provisionRuns)
    .where(and(
      eq(provisionRuns.tenantId, tenantId),
      eq(provisionRuns.entityId, entityId),
      eq(provisionRuns.status, 'locked'),
      lt(provisionRuns.period, periodStart),
    ))
    .orderBy(desc(provisionRuns.period))
    .limit(1);
  return run ?? null;
}

async function activeMappingForAccount(tx: any, tenantId: string, accountId: string) {
  const [mapping] = await tx.select().from(taxMappings)
    .where(and(
      eq(taxMappings.tenantId, tenantId),
      eq(taxMappings.accountId, accountId),
      eq(taxMappings.isActive, true),
    ))
    .orderBy(desc(taxMappings.version))
    .limit(1);
  return mapping ?? null;
}

/**
 * Batched version of activeMappingForAccount: one query for many accounts
 * (IN + in-memory latest-version join) instead of one round-trip per row.
 * A 500-account chart would otherwise cost 500 sequential queries inside the
 * commit transaction.
 */
async function activeMappingsForAccounts(tx: any, tenantId: string, accountIds: string[]) {
  const ids = [...new Set(accountIds.filter(Boolean))];
  if (ids.length === 0) return new Map<string, never>();
  const rows = await tx.select().from(taxMappings)
    .where(and(
      eq(taxMappings.tenantId, tenantId),
      inArray(taxMappings.accountId, ids),
      eq(taxMappings.isActive, true),
    ))
    .orderBy(desc(taxMappings.version));
  const latest = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    if (!latest.has(row.accountId)) latest.set(row.accountId, row);
  }
  return latest;
}

function toBridgeMapping(mapping: { id: string; taxAccountType: string; bookTreatment: string; timingCategory?: string | null } | null | undefined) {
  return mapping ? {
    id: mapping.id,
    taxAccountType: mapping.taxAccountType,
    bookTreatment: mapping.bookTreatment,
    timingCategory: mapping.timingCategory ?? null,
  } : null;
}

/**
 * Prior locked run's approved mapped accounts: the committed rows of the
 * currently-active batch for the run's accounting period (same "active
 * batch" definition as lib/import-batch-link.ts — committed, non-superseded,
 * latest — i.e. the live prior close the rollforward consumes), falling back
 * to the trial-balance snapshot at the run's period for runs that predate
 * batch linkage. Each carries its active tax mapping (if any) so renames can
 * suggest it as carry-forward.
 */
async function loadPriorBridgeAccounts(tx: any, tenantId: string, run: { accountingPeriodId: string | null; period: string; entityId: string }): Promise<PriorBridgeAccount[]> {
  let batchId: string | null = null;
  if (run.accountingPeriodId && run.entityId) {
    const [active] = await tx.select({ id: importBatches.id }).from(importBatches)
      .where(and(
        eq(importBatches.tenantId, tenantId),
        eq(importBatches.entityId, run.entityId),
        eq(importBatches.accountingPeriodId, run.accountingPeriodId),
        eq(importBatches.status, 'committed'),
        isNull(importBatches.supersededByBatchId),
      ))
      .orderBy(desc(importBatches.createdAt))
      .limit(1);
    batchId = active?.id ?? null;
  }

  if (batchId) {
    const rows = await tx.select().from(importBatchRows)
      .where(and(eq(importBatchRows.batchId, batchId), eq(importBatchRows.status, 'committed')));
    const mappings = await activeMappingsForAccounts(tx, tenantId, rows.map((r: { accountId: string | null }) => r.accountId).filter(Boolean) as string[]);
    const out: PriorBridgeAccount[] = [];
    for (const row of rows) {
      const normalized = row.normalized as {
        accountExternalId?: string; accountName?: string; accountType?: string; balance?: number;
      } | null;
      if (!normalized) continue;
      out.push({
        externalId: normalized.accountExternalId ?? '',
        name: normalized.accountName ?? '',
        accountType: normalized.accountType ?? '',
        closingBalance: normalized.balance ?? 0,
        mapping: toBridgeMapping(row.accountId ? mappings.get(row.accountId) : null),
      });
    }
    return out;
  }

  const tbRows = await tx.select({
    balance: trialBalance.balance,
    period: trialBalance.period,
    accountId: accounts.id,
    externalId: accounts.externalId,
    name: accounts.name,
    type: accounts.type,
  }).from(trialBalance)
    .innerJoin(accounts, eq(accounts.id, trialBalance.accountId))
    .where(and(
      eq(trialBalance.tenantId, tenantId),
      eq(trialBalance.entityId, run.entityId),
      eq(trialBalance.period, run.period),
    ));
  const tbMappings = await activeMappingsForAccounts(tx, tenantId, tbRows.map((r: { accountId: string }) => r.accountId));
  const out: PriorBridgeAccount[] = [];
  for (const row of tbRows) {
    out.push({
      externalId: row.externalId ?? '',
      name: row.name,
      accountType: row.type,
      closingBalance: row.balance,
      mapping: toBridgeMapping(tbMappings.get(row.accountId)),
    });
  }
  return out;
}

function bridgeCurrentAccounts(normals: NormalizedRow[]): CurrentBridgeAccount[] {
  return normals.map((n) => ({
    externalId: n.accountExternalId ?? '',
    name: n.accountName ?? '',
    accountType: n.accountType ?? '',
    balance: n.balance ?? 0,
  }));
}

async function openBridgeItemsForBatch(tx: any, tenantId: string, batchId: string) {
  return tx.select().from(reviewItems)
    .where(and(
      eq(reviewItems.tenantId, tenantId),
      eq(reviewItems.sourceRef, bridgeSourceRef(batchId)),
      inArray(reviewItems.itemType, [...BRIDGE_ITEM_TYPES]),
      not(inArray(reviewItems.status, [...BRIDGE_FINAL_STATUSES])),
    ));
}

async function pendingProposalExists(tx: any, tenantId: string, entityId: string, source: string, externalId: string): Promise<boolean> {
  const [existing] = await tx.select({ id: mappingProposals.id }).from(mappingProposals)
    .where(and(
      eq(mappingProposals.tenantId, tenantId),
      eq(mappingProposals.entityId, entityId),
      eq(mappingProposals.proposalSource, source),
      eq(mappingProposals.sourceAccountExternalId, externalId),
      eq(mappingProposals.status, 'pending'),
    ))
    .limit(1);
  return !!existing;
}

/**
 * Persist the pure diff through existing machinery (idempotent: open items
 * and pending proposals are reused, never duplicated). Returns the created /
 * reused review items and proposals.
 */
async function persistBridgeResult(
  tx: any,
  tenantId: string,
  batch: { id: string; entityId: string },
  result: PriorPeriodBridgeResult,
  priorRunId: string,
) {
  const items: Array<{ id: string; itemType: string; status: string }> = [];
  const proposals: Array<{ id: string; proposalSource: string }> = [];
  const openItems = await openBridgeItemsForBatch(tx, tenantId, batch.id);
  const openKey = new Set(openItems.map((i: { itemType: string; metadata: unknown }) =>
    `${i.itemType}:${((i.metadata as { externalId?: string } | null)?.externalId ?? '').toLowerCase()}`));

  async function ensureItem(itemType: string, severity: string, title: string, description: string, externalId: string, metadata: Record<string, unknown>) {
    const key = `${itemType}:${externalId.toLowerCase()}`;
    const reused = openItems.find((i: { itemType: string; metadata: unknown }) =>
      `${i.itemType}:${(((i.metadata as { externalId?: string } | null)?.externalId ?? '').toLowerCase())}` === key);
    if (reused) {
      items.push({ id: reused.id, itemType, status: reused.status });
      return reused;
    }
    const [item] = await tx.insert(reviewItems).values({
      tenantId,
      provisionRunId: null,
      itemType,
      severity,
      status: 'open',
      title,
      description,
      entityId: batch.entityId,
      sourceRef: bridgeSourceRef(batch.id),
      metadata: { batchId: batch.id, priorRunId, externalId, ...metadata },
    }).returning();
    items.push({ id: item.id, itemType, status: item.status });
    void openKey.add(key);
    return item;
  }

  for (const m of result.missingAccounts) {
    await ensureItem(
      'MISSING_PRIOR_ACCOUNT', 'warning',
      `Account "${m.prior.name}" from the prior locked period is missing`,
      `Account "${m.prior.name}" (${m.prior.externalId || 'no external id'}, ${m.prior.accountType}) was in the prior locked run but has no row in this import. Confirm it was closed/merged, or fix the export.`,
      m.prior.externalId || m.prior.name,
      { code: 'MISSING_PRIOR_ACCOUNT', priorName: m.prior.name, priorType: m.prior.accountType, priorClosing: String(m.prior.closingBalance) },
    );
  }

  for (const r of result.renames) {
    const priorMapping = r.prior.mapping;
    const fallback = fallbackClassifyByName(r.current.name, r.current.accountType);
    const target = validateUkClassification(priorMapping?.taxAccountType ?? fallback.taxAccountType);
    let proposalId: string | null = null;
    if (!await pendingProposalExists(tx, tenantId, batch.entityId, 'carry_forward', r.current.externalId || r.current.name)) {
      const [proposal] = await tx.insert(mappingProposals).values({
        tenantId,
        entityId: batch.entityId,
        accountId: null,
        sourceAccountExternalId: (r.current.externalId || r.current.name).slice(0, 100),
        sourceAccountName: r.current.name.slice(0, 255),
        targetTaxClassification: target,
        bookTreatment: (priorMapping?.bookTreatment ?? fallback.bookTreatment) as 'permanent' | 'temporary' | 'no_diff' | 'manual_review',
        timingCategory: priorMapping?.timingCategory ?? fallback.timingCategory ?? null,
        confidenceScore: String(Math.min(0.95, 0.5 + r.similarity * 0.4)),
        proposalSource: 'carry_forward',
        status: 'pending',
        version: 1,
        carriesForward: true,
        priorMappingId: priorMapping?.id ?? null,
        decisionReason: priorMapping
          ? `Possible rename of "${r.prior.name}" (similarity ${Math.round(r.similarity * 100)}%); carries forward mapping ${priorMapping.taxAccountType}. A human must accept before it applies.`
          : `Possible rename of "${r.prior.name}" (similarity ${Math.round(r.similarity * 100)}%); no prior mapping found, rule-based suggestion. A human must accept before it applies.`,
      }).returning();
      proposalId = proposal.id;
      proposals.push({ id: proposal.id, proposalSource: 'carry_forward' });
    }
    await ensureItem(
      'POSSIBLE_RENAME', 'warning',
      `Possible rename: "${r.prior.name}" → "${r.current.name}"`,
      `"${r.current.name}" looks like a rename of prior-period "${r.prior.name}" (token similarity ${Math.round(r.similarity * 100)}%, threshold ${Math.round(RENAME_SIMILARITY_THRESHOLD * 100)}%). A carry-forward mapping proposal was raised — accept it to apply, or fix the export.`,
      r.current.externalId || r.current.name,
      {
        code: 'POSSIBLE_RENAME', similarity: r.similarity,
        priorName: r.prior.name, priorExternalId: r.prior.externalId,
        priorMapping: priorMapping ? { id: priorMapping.id, taxAccountType: priorMapping.taxAccountType } : null,
        proposalId,
      },
    );
  }

  for (const n of result.newAccounts) {
    const fallback = fallbackClassifyByName(n.current.name, n.current.accountType);
    if (!await pendingProposalExists(tx, tenantId, batch.entityId, 'import', n.current.externalId || n.current.name)) {
      const [proposal] = await tx.insert(mappingProposals).values({
        tenantId,
        entityId: batch.entityId,
        accountId: null,
        sourceAccountExternalId: (n.current.externalId || n.current.name).slice(0, 100),
        sourceAccountName: n.current.name.slice(0, 255),
        targetTaxClassification: validateUkClassification(fallback.taxAccountType),
        bookTreatment: fallback.bookTreatment,
        timingCategory: fallback.timingCategory ?? null,
        confidenceScore: String(fallback.confidence),
        proposalSource: 'import',
        status: 'pending',
        version: 1,
        carriesForward: false,
        priorMappingId: null,
        decisionReason: `First seen in this period's import — no prior-period account to inherit from. Rule-based suggestion; a human must decide.`,
      }).returning();
      proposals.push({ id: proposal.id, proposalSource: 'import' });
    }
  }

  for (const m of result.mismatches) {
    await ensureItem(
      'OPENING_BALANCE_MISMATCH', 'error',
      `Opening balance mismatch on "${m.current.name}" (£${m.delta})`,
      `Balance-sheet account "${m.current.name}": prior locked closing ${m.priorClosing} vs this import ${m.currentOpening} (delta £${m.delta}, tolerance £${OPENING_BALANCE_TOLERANCE}). Commit is blocked until a reviewer resolves this item with a reason.`,
      m.current.externalId || m.current.name,
      {
        code: 'OPENING_BALANCE_MISMATCH',
        priorClosing: m.priorClosing, currentOpening: m.currentOpening, delta: m.delta,
        priorName: m.prior.name,
      },
    );
  }

  return { items, proposals };
}

const bridgeResolveSchema = z.object({
  reason: z.string().min(1, 'A resolution reason is required for the audit trail').max(2000),
});

const ROLE_ORDER: Record<string, number> = {
  client_readonly: 0, auditor: 1, preparer: 2, reviewer: 3, partner: 4, admin: 5,
};

intakeRoutes.get('/batches/:id/prior-bridge', async (c) => {
  requirePriorBridgeEnabled();
  const user = c.get('user');
  const { id: batchId } = c.req.param();

  return withTenantContext(user.tenantId, async (tx) => {
    const batch = await requireBatch(tx, user.tenantId, batchId);
    const [period] = await tx.select().from(accountingPeriods)
      .where(and(eq(accountingPeriods.tenantId, user.tenantId), eq(accountingPeriods.id, batch.accountingPeriodId)))
      .limit(1);
    if (!period) throw new NotFoundError('Accounting period', batch.accountingPeriodId);
    const priorRun = await findPriorLockedRun(tx, user.tenantId, batch.entityId, period.startDate);
    if (!priorRun) {
      return c.json({ batchId, priorRunId: null, result: { newAccounts: [], missingAccounts: [], renames: [], mismatches: [] } });
    }
    const normals = await loadCommittableNormals(tx, batchId);
    const result = diffPriorPeriod(
      await loadPriorBridgeAccounts(tx, user.tenantId, priorRun),
      bridgeCurrentAccounts(normals.map((r) => r.normalized)),
    );
    return c.json({ batchId, priorRunId: priorRun.id, result });
  });
});

// Narrow resolve action for bridge items (the provision run-scoped resolve
// endpoint cannot touch run-less intake items). Mandatory reason, append-only
// history, batch-ledger note — the same lifecycle, not a parallel flow.
intakeRoutes.post('/batches/:id/bridge/items/:itemId/resolve', requireMinimumRole('preparer'), zValidator('json', bridgeResolveSchema), async (c) => {
  requirePriorBridgeEnabled();
  const user = c.get('user');
  const { id: batchId, itemId } = c.req.param();
  const { reason } = c.req.valid('json');

  return withTenantContext(user.tenantId, async (tx) => {
    await requireBatch(tx, user.tenantId, batchId);
    const [item] = await tx.select().from(reviewItems)
      .where(and(
        eq(reviewItems.tenantId, user.tenantId),
        eq(reviewItems.id, itemId),
        eq(reviewItems.sourceRef, bridgeSourceRef(batchId)),
      ))
      .limit(1);
    if (!item) throw new NotFoundError('Bridge review item', itemId);
    if (!(BRIDGE_ITEM_TYPES as readonly string[]).includes(item.itemType)) {
      throw new BadRequestError(`Item ${itemId} is not a prior-period bridge item (type: ${item.itemType})`);
    }
    if (BRIDGE_FINAL_STATUSES.includes(item.status)) {
      throw new ConflictError(`Bridge item is already ${item.status}`);
    }
    if (item.itemType === 'OPENING_BALANCE_MISMATCH' && (ROLE_ORDER[user.role as string] ?? -1) < ROLE_ORDER.reviewer) {
      throw new ForbiddenError('Resolving an opening-balance mismatch requires at least the reviewer role');
    }

    const before = { status: item.status };
    const [updated] = await tx.update(reviewItems).set({
      status: 'resolved',
      resolvedByUserId: user.userId,
      resolutionNote: reason,
      resolvedAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(reviewItems.id, item.id)).returning();
    await tx.insert(reviewItemEvents).values({
      tenantId: user.tenantId,
      reviewItemId: item.id,
      eventType: 'status_changed',
      actorUserId: user.userId,
      reason,
      beforeState: before,
      afterState: { status: 'resolved' },
    });
    await recordBatchEvent(tx, {
      tenantId: user.tenantId, batchId, eventType: 'batch.bridge_item_resolved',
      actorUserId: user.userId, reason, afterState: { itemId: item.id, itemType: item.itemType },
    });
    return c.json({ item: updated });
  });
});

// ── Metrics ──

intakeRoutes.get('/metrics', async (c) => {
  const user = c.get('user');

  return withTenantContext(user.tenantId, async (tx) => {
    const [totals] = await tx.select({
      total: sql<number>`count(*)::int`,
      committed: sql<number>`count(*) filter (where status = 'committed')::int`,
      failed: sql<number>`count(*) filter (where status = 'failed')::int`,
      pendingReview: sql<number>`count(*) filter (where status = 'ready_for_review')::int`,
      avgRows: sql<number>`coalesce(avg(row_count), 0)::numeric(10,2)`,
    }).from(importBatches).where(eq(importBatches.tenantId, user.tenantId));

    const [suggestionStats] = await tx.select({
      accepted: sql<number>`count(*) filter (where status = 'accepted')::int`,
      rejected: sql<number>`count(*) filter (where status = 'rejected')::int`,
      overridden: sql<number>`count(*) filter (where status = 'overridden')::int`,
      applied: sql<number>`count(*) filter (where status = 'applied')::int`,
      decided: sql<number>`count(*) filter (where decided_at is not null)::int`,
      avgTimeToReviewHours: sql<number>`coalesce(avg(extract(epoch from (decided_at - created_at)) / 3600), 0)::numeric(10,2)`,
    }).from(mappingSuggestions).where(eq(mappingSuggestions.tenantId, user.tenantId));

    const decided = Number(suggestionStats?.decided ?? 0);
    const accepted = Number(suggestionStats?.accepted ?? 0);
    const overridden = Number(suggestionStats?.overridden ?? 0);
    const totalBatches = Number(totals?.total ?? 0);

    return c.json({
      batches: {
        total: totalBatches,
        committed: Number(totals?.committed ?? 0),
        failed: Number(totals?.failed ?? 0),
        pendingReview: Number(totals?.pendingReview ?? 0),
        exceptionRate: totalBatches > 0 ? Number((Number(totals?.failed ?? 0) / totalBatches).toFixed(4)) : 0,
        avgRowsPerBatch: Number(totals?.avgRows ?? 0),
      },
      suggestions: {
        accepted,
        rejected: Number(suggestionStats?.rejected ?? 0),
        overridden,
        applied: Number(suggestionStats?.applied ?? 0),
        decided,
        acceptanceRate: decided > 0 ? Number((accepted / decided).toFixed(4)) : 0,
        overrideRate: decided > 0 ? Number((overridden / decided).toFixed(4)) : 0,
        avgTimeToReviewHours: Number(suggestionStats?.avgTimeToReviewHours ?? 0),
      },
    });
  });
});

// ── Governed manual adjustments ──

intakeRoutes.post('/adjustments', requireMinimumRole('preparer'), zValidator('json', adjustmentSchema), async (c) => {
  const user = c.get('user');
  const input = c.req.valid('json');

  return withTenantContext(user.tenantId, async (tx) => {
    if (input.provisionRunId) {
      const [run] = await tx.select({ id: provisionRuns.id }).from(provisionRuns)
        .where(and(eq(provisionRuns.tenantId, user.tenantId), eq(provisionRuns.id, input.provisionRunId)))
        .limit(1);
      if (!run) throw new NotFoundError('Provision run', input.provisionRunId);
    }

    const [adjustment] = await tx.insert(taxAdjustments).values({
      tenantId: user.tenantId,
      provisionRunId: input.provisionRunId ?? null,
      accountId: input.accountId ?? null,
      adjustmentType: input.adjustmentType,
      amount: input.amount,
      description: input.description ?? null,
      reason: input.reason,
      evidenceDocumentId: input.evidenceDocumentId ?? null,
      createdByUserId: user.userId,
      effectivePeriod: input.effectivePeriod ?? null,
    }).returning();

    return c.json({ adjustment }, 201);
  });
});

intakeRoutes.get('/adjustments', async (c) => {
  const user = c.get('user');
  const runId = c.req.query('runId');

  return withTenantContext(user.tenantId, async (tx) => {
    const conditions = [eq(taxAdjustments.tenantId, user.tenantId)];
    if (runId) conditions.push(eq(taxAdjustments.provisionRunId, runId));
    const adjustments = await tx.select().from(taxAdjustments)
      .where(and(...conditions))
      .orderBy(desc(taxAdjustments.createdAt));
    return c.json({ adjustments });
  });
});

const adjustmentReviewSchema = z.object({
  reason: z.string().max(500).optional(),
});

intakeRoutes.post('/adjustments/:id/approve', requireMinimumRole('reviewer'), zValidator('json', adjustmentReviewSchema), async (c) => {
  const user = c.get('user');
  const { id: adjustmentId } = c.req.param();
  const { reason } = c.req.valid('json');

  return withTenantContext(user.tenantId, async (tx) => {
    const adjustment = await reviewAdjustment(tx, {
      tenantId: user.tenantId, adjustmentId, decision: 'approved', userId: user.userId, reason,
    });
    return c.json({ adjustment });
  });
});

intakeRoutes.post('/adjustments/:id/reject', requireMinimumRole('reviewer'), zValidator('json', adjustmentReviewSchema), async (c) => {
  const user = c.get('user');
  const { id: adjustmentId } = c.req.param();
  const { reason } = c.req.valid('json');

  return withTenantContext(user.tenantId, async (tx) => {
    const adjustment = await reviewAdjustment(tx, {
      tenantId: user.tenantId, adjustmentId, decision: 'rejected', userId: user.userId, reason,
    });
    return c.json({ adjustment });
  });
});
