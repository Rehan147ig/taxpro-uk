// ─────────────────────────────────────────────────────────────────────────────
// Export module routes.
//
// Automated journal entry workpapers: transform a calculated provision_result
// into structured debits/credits (UK FRS 102 S29) and serve them as JSON or
// ERP-import CSV (Xero / QuickBooks Online / NetSuite).
// ─────────────────────────────────────────────────────────────────────────────

import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { withTenantContext } from '../../config/db.js';
import { authMiddleware } from '../../lib/middleware/auth.js';
import { requireRole } from '../../lib/middleware/rbac.js';
import { NotFoundError } from '../../lib/errors.js';
import { provisionResults } from '../../db/schema/provision-results.js';
import { provisionRuns } from '../../db/schema/provision-runs.js';
import { buildJournalExport, journalsToCsv, journalExportFileName, type JournalFormat } from './journals.js';

export const exportRoutes = new Hono();
exportRoutes.use('*', authMiddleware);

const FORMATS: JournalFormat[] = ['json', 'csv', 'xero', 'qbo', 'netsuite'];

exportRoutes.get('/journals/:resultId',
  requireRole('preparer', 'reviewer', 'partner', 'admin'),
  async (c) => {
    const user = c.get('user');
    const resultId = c.req.param('resultId') ?? '';
    const requested = (c.req.query('format') ?? 'json') as JournalFormat;
    const format = FORMATS.includes(requested) ? requested : 'json';

    return withTenantContext(user.tenantId, async (tx) => {
      const [result] = await tx.select().from(provisionResults)
        .where(and(eq(provisionResults.tenantId, user.tenantId), eq(provisionResults.id, resultId)))
        .limit(1);
      if (!result) throw new NotFoundError('Provision result', resultId);

      const [run] = result.provisionRunId
        ? await tx.select().from(provisionRuns).where(eq(provisionRuns.id, result.provisionRunId)).limit(1)
        : [];

      const doc = buildJournalExport({
        id: result.id,
        provisionRunId: result.provisionRunId,
        period: result.period,
        status: result.status ?? 'draft',
        currentTaxExpense: result.currentTaxExpense,
        deferredTaxExpense: result.deferredTaxExpense,
        totalTaxExpense: result.totalTaxExpense,
        bookIncome: result.bookIncome,
        taxPayable: result.taxPayable,
        detail: result.detail,
        createdAt: result.createdAt,
      }, run ? {
        id: run.id,
        period: run.period,
        endPeriod: run.endPeriod,
        entityId: run.entityId,
        status: run.status,
        engineVersion: run.engineVersion,
      } : null);

      if (format === 'json') {
        return c.json(doc, 200, {
          'Content-Disposition': `attachment; filename="${journalExportFileName(doc, 'json')}"`,
        });
      }

      const csv = journalsToCsv(doc, format);
      return c.text(csv, 200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${journalExportFileName(doc, format)}"`,
      });
    });
  });
