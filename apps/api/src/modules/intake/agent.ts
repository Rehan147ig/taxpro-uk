import { eq } from 'drizzle-orm';
import { aiRuns, aiSteps } from '../../db/schema/ai-runs.js';
import { stableHash } from '../../eve/hash.js';
import { callJsonModel } from '../../eve/model-client.js';
import { logger } from '../../lib/logger.js';
import { z } from 'zod';

/**
 * Intake agent tracing.
 *
 * The existing trace store is provision-run scoped: startAiRun also writes a
 * provision_events row whose provision_run_id is NOT NULL. Intake agents run
 * BEFORE any provision run exists, so this module writes ai_runs / ai_steps
 * directly (provision_run_id stays null) and never touches provision_events.
 *
 * AI proposals are advisory only: they are persisted as pending
 * mapping_suggestions with source='ai' and are never applied without an
 * explicit reviewer decision.
 */

export interface IntakeRunContext {
  tenantId: string;
  userId?: string;
  workflowName: string;
  promptVersion?: string;
}

export async function startIntakeAiRun(
  tx: any,
  context: IntakeRunContext,
  input: unknown,
  meta: { provider?: string; model?: string } = {},
) {
  const [run] = await tx.insert(aiRuns).values({
    tenantId: context.tenantId,
    userId: context.userId ?? null,
    provisionRunId: null,
    workflowName: context.workflowName,
    provider: meta.provider ?? null,
    model: meta.model ?? null,
    promptVersion: context.promptVersion ?? 'unversioned',
    inputHash: stableHash(input),
    inputSummary: summarizeInput(input),
    status: 'started',
    agentName: context.workflowName,
  }).returning();

  await recordIntakeStep(tx, context.tenantId, run.id, 1, 'agent.start', input, { note: 'intake agent started' });
  return run;
}

export async function completeIntakeAiRun(tx: any, tenantId: string, runId: string, output: unknown) {
  await tx.update(aiRuns).set({
    status: 'completed',
    outputJson: output,
    completedAt: new Date(),
  }).where(eq(aiRuns.id, runId));
  await recordIntakeStep(tx, tenantId, runId, 99, 'agent.complete', output, { note: 'intake agent completed' });
}

export async function failIntakeAiRun(tx: any, tenantId: string, runId: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  await tx.update(aiRuns).set({
    status: 'failed',
    errorMessage: message,
    completedAt: new Date(),
  }).where(eq(aiRuns.id, runId));
  await recordIntakeStep(tx, tenantId, runId, 98, 'agent.fail', { message }, { note: 'intake agent failed' });
}

export async function recordIntakeStep(tx: any, tenantId: string, aiRunId: string, sequence: number, stepName: string, input: unknown, output: unknown) {
  await tx.insert(aiSteps).values({
    tenantId,
    aiRunId,
    sequence,
    stepName,
    status: 'completed',
    inputJson: input,
    outputJson: output,
    completedAt: new Date(),
  });
}

const suggestionSchema = z.object({
  suggestions: z.array(z.object({
    batchRowId: z.string(),
    taxAccountType: z.string(),
    bookTreatment: z.enum(['permanent', 'temporary', 'no_diff']),
    timingCategory: z.enum(['deductible_temporary', 'taxable_temporary']).optional(),
    confidenceScore: z.number(),
    explanation: z.string(),
  })),
});

const SYSTEM_PROMPT = [
  'You are an expert UK corporate tax accountant (FRS 102, Corporation Tax Act 2010).',
  'For each trial balance account, propose a UK tax classification.',
  'Rules: proposals are advisory and always reviewed by a human.',
  'Use consistent canonical tax account type codes. Prefer no book-tax difference (no_diff)',
  'for accounts that are deductible in the same period.',
  'Return ONLY a JSON object with a "suggestions" array.',
].join(' ');

export async function enrichSuggestionsWithAi(
  tx: any,
  context: IntakeRunContext,
  rows: Array<{ batchRowId: string; accountName: string; accountNumber: string; accountType: string }>,
): Promise<Array<{
  batchRowId: string;
  taxAccountType: string;
  bookTreatment: 'permanent' | 'temporary' | 'no_diff';
  timingCategory?: 'deductible_temporary' | 'taxable_temporary';
  confidenceScore: number;
  explanation: string;
}>> {
  if (rows.length === 0) return [];

  const run = await startIntakeAiRun(tx, context, { accountCount: rows.length, accounts: rows.slice(0, 20) });

  try {
    const response = await callJsonModel({
      schema: suggestionSchema,
      system: SYSTEM_PROMPT,
      user: `Classify these ${rows.length} UK accounts (one per line):\n` +
        rows.map((r) => `${r.batchRowId}\t${r.accountNumber}\t${r.accountName}\t${r.accountType}`).join('\n'),
      promptVersion: context.promptVersion ?? 'intake-suggestion-v1',
      temperature: 0.1,
    });

    const valid = response.parsed.suggestions.filter((s: any) =>
      rows.some((r) => r.batchRowId === s.batchRowId) && s.confidenceScore >= 0 && s.confidenceScore <= 1,
    );
    await completeIntakeAiRun(tx, context.tenantId, run.id, { suggestionCount: valid.length, provider: response.provider, model: response.model });
    return valid;
  } catch (err) {
    logger.warn({ err }, '[Intake] AI suggestion enrichment failed — deterministic suggestions still apply');
    await failIntakeAiRun(tx, context.tenantId, run.id, err);
    return [];
  }
}

function summarizeInput(input: unknown) {
  if (!input || typeof input !== 'object') return { valueType: typeof input };
  if (Array.isArray(input)) return { valueType: 'array', count: input.length };
  const record = input as Record<string, unknown>;
  return Object.fromEntries(Object.entries(record).map(([key, value]) => {
    if (Array.isArray(value)) return [key, { type: 'array', count: value.length }];
    if (value && typeof value === 'object') return [key, { type: 'object', keys: Object.keys(value as Record<string, unknown>).length }];
    return [key, value];
  }));
}
