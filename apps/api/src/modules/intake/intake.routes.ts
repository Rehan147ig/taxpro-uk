import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import crypto from 'crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
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
import { BadRequestError, ConflictError, NotFoundError } from '../../lib/errors.js';
import { parseCsv, rowToRecord } from './csv.js';
import { validateRow, buildBatchSummary } from './validate.js';
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

    let committedRows = 0;
    const importedAccountIds = new Set<string>();

    for (const row of committableRows) {
      const normalized = row.normalized as any;
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
