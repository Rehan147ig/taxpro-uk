import { and, desc, eq, sql } from 'drizzle-orm';
import { taxMemoryPrecedents, mappingSuggestions } from '../../db/schema/tax-memory.js';
import { importBatchRows } from '../../db/schema/import-batches.js';
import { nameSimilarity } from '../import/auto-mapping/precedent-engine.js';
import type { NormalizedRow } from './validate.js';

/**
 * Deterministic tax memory.
 *
 * Suggestions are scored by an explicit, explainable rule — never by an
 * opaque trained model:
 *
 *   score = name similarity (Jaccard over tokens, ≥ 0.5 to qualify)
 *           + scope bonus (entity > group > tenant)
 *           + vintage bonus (recently approved precedents)
 *
 * A precedent is never applied silently: it is surfaced as a pending
 * mapping_suggestion that a reviewer accepts, rejects or overrides.
 * Reviewer decisions are persisted to reviewer_feedback_events, which is
 * the only input the scorer learns from.
 */

const NAME_SIMILARITY_THRESHOLD = 0.5;
const MIN_CONFIDENCE = 0.5;
const MAX_CONFIDENCE = 0.98;

export interface TaxMemoryMatch {
  precedent: typeof taxMemoryPrecedents.$inferSelect;
  similarity: number;
  scopeBonus: number;
  vintageBonus: number;
  confidence: number;
}

export function scorePrecedent(
  precedent: typeof taxMemoryPrecedents.$inferSelect,
  accountName: string,
  accountType: string,
  entityId: string | null,
  groupId: string | null,
  batchPeriod: string,
): TaxMemoryMatch | null {
  if (precedent.accountType !== accountType) return null;
  if (precedent.jurisdiction && precedent.jurisdiction !== 'UK_FRS102') return null;

  if (precedent.effectiveFrom && batchPeriod < precedent.effectiveFrom) return null;
  if (precedent.effectiveTo && batchPeriod > precedent.effectiveTo) return null;

  const similarity = nameSimilarity(accountName, precedent.accountName);
  if (similarity < NAME_SIMILARITY_THRESHOLD) return null;

  let scopeBonus = 0;
  if (precedent.entityId && precedent.entityId === entityId) scopeBonus = 0.15;
  else if (precedent.groupId && groupId && precedent.groupId === groupId) scopeBonus = 0.10;

  const ageDays = (Date.now() - new Date(precedent.createdAt).getTime()) / 86_400_000;
  const vintageBonus = Math.max(0, 0.05 - ageDays / 3650); // full 0.05 for fresh, decays over ~10 years

  const confidence = Math.min(MAX_CONFIDENCE, Math.max(MIN_CONFIDENCE, 0.5 + similarity * 0.3 + scopeBonus + vintageBonus));

  return { precedent, similarity, scopeBonus, vintageBonus, confidence };
}

export async function findBestTaxMemoryMatch(
  tx: any,
  tenantId: string,
  row: NormalizedRow,
  entityId: string | null,
  groupId: string | null,
  period: string,
): Promise<TaxMemoryMatch | null> {
  const candidates = await tx.select().from(taxMemoryPrecedents)
    .where(and(
      eq(taxMemoryPrecedents.tenantId, tenantId),
      eq(taxMemoryPrecedents.accountType, row.accountType),
    ))
    .orderBy(desc(taxMemoryPrecedents.createdAt));

  let best: TaxMemoryMatch | null = null;
  for (const precedent of candidates) {
    const scored = scorePrecedent(precedent, row.accountName, row.accountType, entityId, groupId, period);
    if (!scored) continue;
    if (!best || scored.confidence > best.confidence) best = scored;
  }
  return best;
}

const FALLBACK_RULES: Array<{
  keywords: string[];
  taxAccountType: string;
  bookTreatment: 'permanent' | 'temporary' | 'no_diff';
  timingCategory?: 'deductible_temporary' | 'taxable_temporary';
}> = [
  { keywords: ['cash', 'bank'], taxAccountType: 'NODIFF_CASH', bookTreatment: 'no_diff' },
  { keywords: ['receivable', 'debtor'], taxAccountType: 'NODIFF_AR', bookTreatment: 'no_diff' },
  { keywords: ['payable', 'creditor'], taxAccountType: 'NODIFF_AP', bookTreatment: 'no_diff' },
  { keywords: ['salary', 'wage', 'payroll'], taxAccountType: 'NODIFF_SALARIES', bookTreatment: 'no_diff' },
  { keywords: ['depreciation'], taxAccountType: 'TEMP_DEPRECIATION', bookTreatment: 'temporary', timingCategory: 'taxable_temporary' },
  { keywords: ['amortisation', 'amortization'], taxAccountType: 'TEMP_AMORTISATION', bookTreatment: 'temporary', timingCategory: 'taxable_temporary' },
  { keywords: ['bad debt', 'doubtful', 'allowance'], taxAccountType: 'TEMP_BAD_DEBT_RESERVE', bookTreatment: 'temporary', timingCategory: 'deductible_temporary' },
  { keywords: ['research', 'development', 'rd'], taxAccountType: 'PERM_RD_ADDITION', bookTreatment: 'permanent' },
];

export function fallbackClassifyByName(accountName: string, accountType: string): {
  taxAccountType: string;
  bookTreatment: 'permanent' | 'temporary' | 'no_diff';
  timingCategory?: 'deductible_temporary' | 'taxable_temporary';
  confidence: number;
} {
  const name = accountName.toLowerCase();
  for (const rule of FALLBACK_RULES) {
    if (rule.keywords.some((k) => name.includes(k))) {
      return { ...rule, confidence: 0.6 };
    }
  }
  if (accountType === 'Income') {
    return { taxAccountType: 'NODIFF_REVENUE', bookTreatment: 'no_diff', confidence: 0.55 };
  }
  return { taxAccountType: 'NODIFF_EXPENSE', bookTreatment: 'no_diff', confidence: 0.5 };
}

export interface GeneratedSuggestion {
  batchRowId: string;
  lineNumber: number;
  accountName: string;
  taxAccountType: string;
  bookTreatment: 'permanent' | 'temporary' | 'no_diff';
  timingCategory?: 'deductible_temporary' | 'taxable_temporary';
  confidence: number;
  source: 'tax_memory' | 'rules';
  citedPrecedentId?: string;
  citedAccountName?: string;
  rationale: string;
}

/**
 * Generate mapping suggestions for every valid row of a batch.
 * Deterministic only — AI enrichment is an explicit, separate step.
 */
export async function generateSuggestionsForBatch(
  tx: any,
  tenantId: string,
  batchId: string,
  batchPeriod: string,
  entityId: string | null,
  groupId: string | null,
): Promise<GeneratedSuggestion[]> {
  const rows = await tx.select().from(importBatchRows)
    .where(and(eq(importBatchRows.batchId, batchId), eq(importBatchRows.status, 'ok')))
    .orderBy(importBatchRows.rowNumber);

  const suggestions: GeneratedSuggestion[] = [];

  for (const row of rows) {
    const normalized = row.normalized as NormalizedRow | null;
    if (!normalized) continue;

    const match = await findBestTaxMemoryMatch(tx, tenantId, normalized, entityId, groupId, batchPeriod);

    if (match) {
      suggestions.push({
        batchRowId: row.id,
        lineNumber: row.rowNumber,
        accountName: normalized.accountName,
        taxAccountType: match.precedent.taxAccountType,
        bookTreatment: match.precedent.bookTreatment as GeneratedSuggestion['bookTreatment'],
        timingCategory: match.precedent.timingCategory as GeneratedSuggestion['timingCategory'] | undefined,
        confidence: match.confidence,
        source: 'tax_memory',
        citedPrecedentId: match.precedent.id,
        citedAccountName: match.precedent.accountName,
        rationale:
          `Matched tax memory precedent "${match.precedent.accountName}"` +
          ` (${Math.round(match.similarity * 100)}% name match, ${Math.round(match.scopeBonus * 100)}% scope, ` +
          `${Math.round(match.vintageBonus * 100)}% vintage) approved ` +
          `${match.precedent.effectiveFrom}${match.precedent.effectiveTo ? `..${match.precedent.effectiveTo}` : ''}`,
      });
      continue;
    }

    const fallback = fallbackClassifyByName(normalized.accountName, normalized.accountType);
    suggestions.push({
      batchRowId: row.id,
      lineNumber: row.lineNumber,
      accountName: normalized.accountName,
      taxAccountType: fallback.taxAccountType,
      bookTreatment: fallback.bookTreatment,
      timingCategory: fallback.timingCategory,
      confidence: fallback.confidence,
      source: 'rules',
      rationale: `Rule-based classification: ${fallback.taxAccountType}`,
    });
  }

  if (suggestions.length > 0) {
    await tx.insert(mappingSuggestions).values(
      suggestions.map((s) => ({
        tenantId,
        batchId,
        batchRowId: s.batchRowId,
        entityId,
        period: batchPeriod,
        suggestedTaxAccountType: s.taxAccountType,
        bookTreatment: s.bookTreatment,
        timingCategory: s.timingCategory,
        confidenceScore: String(s.confidence),
        source: s.source,
        citedPrecedentId: s.citedPrecedentId,
        citedAccountName: s.citedAccountName,
        rationale: s.rationale,
        status: 'pending',
      })),
    ).onConflictDoNothing();
  }

  return suggestions;
}

export async function listTaxMemoryPrecedents(
  tx: any,
  tenantId: string,
  query: string | undefined,
  limit: number,
) {
  const q = query?.trim();
  const conditions = [eq(taxMemoryPrecedents.tenantId, tenantId)];
  if (q) {
    const like = `%${q.toLowerCase()}%`;
    conditions.push(
      sql`lower(${taxMemoryPrecedents.accountName}) LIKE ${like} OR lower(${taxMemoryPrecedents.taxAccountType}) LIKE ${like}`,
    );
  }
  return tx.select()
    .from(taxMemoryPrecedents)
    .where(and(...conditions))
    .orderBy(desc(taxMemoryPrecedents.createdAt))
    .limit(limit);
}

export async function countPendingSuggestions(tx: any, tenantId: string, batchId: string): Promise<number> {
  const [row] = await tx.select({ count: sql<number>`count(*)::int` })
    .from(mappingSuggestions)
    .where(and(eq(mappingSuggestions.tenantId, tenantId), eq(mappingSuggestions.batchId, batchId), eq(mappingSuggestions.status, 'pending')));
  return Number(row?.count ?? 0);
}

export async function listSuggestionsForBatch(tx: any, tenantId: string, batchId: string, limit = 500) {
  return tx.select()
    .from(mappingSuggestions)
    .where(and(eq(mappingSuggestions.tenantId, tenantId), eq(mappingSuggestions.batchId, batchId)))
    .orderBy(desc(mappingSuggestions.createdAt))
    .limit(limit);
}
