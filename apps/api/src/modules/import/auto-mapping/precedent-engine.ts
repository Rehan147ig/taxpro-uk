import { and, eq, inArray, sql } from 'drizzle-orm';
import { accounts } from '../../../db/schema/accounts.js';
import { taxMappings } from '../../../db/schema/tax-mappings.js';
import { classificationPatterns } from '../../../db/schema/classification-patterns.js';
import { fallbackClassify } from '../../mapping/ai/mapper.js';
import { logger } from '../../../lib/logger.js';

export interface SuggestionResult {
  accountId: string;
  accountName: string;
  accountNumber: string;
  accountType: string;
  taxAccountType: string;
  bookTreatment: 'permanent' | 'temporary' | 'no_diff';
  timingCategory?: 'deductible_temporary' | 'taxable_temporary';
  confidenceScore: number;
  confidenceLabel: 'high' | 'medium' | 'low';
  rationale: string;
  citedPrecedentId?: string;
  citedAccountName?: string;
  matchedBy: 'exact' | 'pattern' | 'fallback';
}

export interface PrecedentMatch {
  mapping: typeof taxMappings.$inferSelect;
  account: typeof accounts.$inferSelect;
  similarity: number;
}

const HIGH_CONFIDENCE = 0.80;
const MEDIUM_CONFIDENCE = 0.60;

function tokenize(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/[&,./()'-]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 2)
    .filter((t) => !['the', 'and', 'for', 'expense', 'income', 'revenue', 'account'].includes(t));
}

function jaccardSimilarity(a: string[], b: string[]): number {
  const setA = new Set(a);
  const setB = new Set(b);
  const intersection = new Set([...setA].filter((x) => setB.has(x)));
  const union = new Set([...setA, ...setB]);
  return union.size === 0 ? 0 : intersection.size / union.size;
}

export function nameSimilarity(nameA: string, nameB: string): number {
  const tokensA = tokenize(nameA);
  const tokensB = tokenize(nameB);
  if (tokensA.length === 0 || tokensB.length === 0) return 0;
  return jaccardSimilarity(tokensA, tokensB);
}

export async function findPrecedentMappings(
  tx: any,
  tenantId: string,
  accountType: string,
): Promise<PrecedentMatch[]> {
  const approvedMappings: (typeof taxMappings.$inferSelect)[] = await tx.select()
    .from(taxMappings)
    .where(and(
      eq(taxMappings.tenantId, tenantId),
      eq(taxMappings.status, 'active'),
      eq(taxMappings.isActive, true),
    ));

  if (approvedMappings.length === 0) return [];

  const mappingAccountIds = [...new Set(approvedMappings.map((m) => m.accountId))];

  const mappingAccounts: (typeof accounts.$inferSelect)[] = await tx.select()
    .from(accounts)
    .where(and(
      eq(accounts.tenantId, tenantId),
      inArray(accounts.id, mappingAccountIds as string[]),
    ));

  const accountMap = new Map<string, typeof accounts.$inferSelect>(
    mappingAccounts.map((a) => [a.id, a]),
  );

  const results: PrecedentMatch[] = [];
  for (const mapping of approvedMappings) {
    const acct = accountMap.get(mapping.accountId);
    if (!acct) continue;
    if (acct.type !== accountType) continue;
    results.push({ mapping, account: acct, similarity: 1.0 });
  }

  return results;
}

export async function findPatternMatches(
  tx: any,
  tenantId: string,
  accountName: string,
): Promise<Array<{ pattern: typeof classificationPatterns.$inferSelect; score: number }>> {
  const tokens = tokenize(accountName);
  if (tokens.length === 0) return [];

  const results = await tx.execute(sql`
    SELECT * FROM classification_patterns
    WHERE tenant_id = ${tenantId}
      AND (
        account_name_tokens @> ${JSON.stringify(tokens)}::jsonb
        OR ${JSON.stringify(tokens)}::jsonb @> account_name_tokens
      )
    ORDER BY created_at DESC
    LIMIT 15
  `);

  const rows = results.rows as any[];
  if (rows.length === 0) return [];

  const scored = rows.map((p: any) => ({
    pattern: p as typeof classificationPatterns.$inferSelect,
    score: jaccardSimilarity(tokens, (p.account_name_tokens as string[]) ?? []),
  }));

  return scored.filter((s) => s.score > 0.2).sort((a, b) => b.score - a.score).slice(0, 5);
}

export function determineConfidence(
  matchedBy: 'exact' | 'pattern' | 'fallback',
  similarity: number,
  patternBoost: number,
): number {
  switch (matchedBy) {
    case 'exact':
      return Math.min(0.85 + similarity * 0.1 + patternBoost, 0.99);
    case 'pattern':
      return Math.min(0.60 + similarity * 0.2 + patternBoost, 0.85);
    case 'fallback':
      return Math.min(0.40 + patternBoost, 0.60);
  }
}

export function confidenceLabel(score: number): 'high' | 'medium' | 'low' {
  if (score >= HIGH_CONFIDENCE) return 'high';
  if (score >= MEDIUM_CONFIDENCE) return 'medium';
  return 'low';
}

export function buildRationale(
  matchedBy: 'exact' | 'pattern' | 'fallback',
  accountName: string,
  taxAccountType: string,
  precedent?: PrecedentMatch,
  patternMatches?: Array<{ pattern: typeof classificationPatterns.$inferSelect; score: number }>,
): string {
  switch (matchedBy) {
    case 'exact':
      return `Matched approved precedent "${precedent!.account.name}" → ${taxAccountType}`;
    case 'pattern':
      if (patternMatches && patternMatches.length > 0) {
        const top = patternMatches[0];
        return `Similar to "${top.pattern.accountName}" (${Math.round(top.score * 100)}% match, approved as ${top.pattern.mappedType}) → ${taxAccountType}`;
      }
      return `Pattern match from ${patternMatches?.length ?? 0} similar accounts → ${taxAccountType}`;
    case 'fallback':
      return `Rule-based classification: ${taxAccountType}`;
  }
}

export function buildCitedPrecedent(precedent?: PrecedentMatch): { id?: string; accountName?: string } {
  if (!precedent) return {};
  return { id: precedent.mapping.id, accountName: precedent.account.name };
}

export async function suggestMapping(
  tx: any,
  tenantId: string,
  account: typeof accounts.$inferSelect,
  precedents: PrecedentMatch[],
): Promise<SuggestionResult> {
  const acctName = account.name;
  const acctType = account.type;

  let bestMatch: { matchedBy: 'exact' | 'pattern' | 'fallback'; taxAccountType: string; bookTreatment: 'permanent' | 'temporary' | 'no_diff'; timingCategory?: 'deductible_temporary' | 'taxable_temporary'; confidenceScore: number; precedent?: PrecedentMatch; patternMatches?: Array<{ pattern: typeof classificationPatterns.$inferSelect; score: number }> } | null = null;

  if (precedents.length > 0) {
    let bestSimilarity = 0;
    let bestPrecedent: PrecedentMatch | undefined;

    for (const p of precedents) {
      const sim = nameSimilarity(acctName, p.account.name);
      if (sim > bestSimilarity) {
        bestSimilarity = sim;
        bestPrecedent = p;
      }
    }

    if (bestPrecedent && bestSimilarity > 0.3) {
      const isExact = bestSimilarity >= 0.8;
      const patternMatches = isExact ? [] : await findPatternMatches(tx, tenantId, acctName);
      const patternBoost = patternMatches.length > 0 ? Math.min(patternMatches[0].score * 0.08, 0.08) : 0;

      const confidence = determineConfidence(isExact ? 'exact' : 'pattern', bestSimilarity, patternBoost);

      bestMatch = {
        matchedBy: isExact ? 'exact' : 'pattern',
        taxAccountType: bestPrecedent.mapping.taxAccountType,
        bookTreatment: bestPrecedent.mapping.bookTreatment as 'permanent' | 'temporary' | 'no_diff',
        timingCategory: bestPrecedent.mapping.timingCategory as any,
        confidenceScore: confidence,
        precedent: bestPrecedent,
        patternMatches,
      };
    }
  }

  if (!bestMatch) {
    const patternMatches = await findPatternMatches(tx, tenantId, acctName);
    if (patternMatches.length > 0) {
      const top = patternMatches[0];
      const confidence = determineConfidence('pattern', top.score, 0);
      bestMatch = {
        matchedBy: 'pattern',
        taxAccountType: top.pattern.mappedType,
        bookTreatment: top.pattern.bookTreatment as 'permanent' | 'temporary' | 'no_diff',
        timingCategory: top.pattern.timingCategory as any,
        confidenceScore: confidence,
        patternMatches,
      };
    }
  }

  if (!bestMatch) {
    const fallback = fallbackClassify([{
      id: account.id,
      accountNumber: account.accountNumber ?? '',
      name: account.name,
      type: account.type,
      detailType: account.detailType ?? undefined,
    }])[0];

    bestMatch = {
      matchedBy: 'fallback',
      taxAccountType: fallback.taxAccountType,
      bookTreatment: fallback.bookTreatment,
      timingCategory: fallback.timingCategory,
      confidenceScore: fallback.confidenceScore,
    };
  }

  return {
    accountId: account.id,
    accountName: account.name,
    accountNumber: account.accountNumber ?? '',
    accountType: acctType,
    taxAccountType: bestMatch.taxAccountType,
    bookTreatment: bestMatch.bookTreatment,
    timingCategory: bestMatch.timingCategory,
    confidenceScore: bestMatch.confidenceScore,
    confidenceLabel: confidenceLabel(bestMatch.confidenceScore),
    rationale: buildRationale(bestMatch.matchedBy, acctName, bestMatch.taxAccountType, bestMatch.precedent, bestMatch.patternMatches),
    citedPrecedentId: bestMatch.precedent?.mapping.id,
    citedAccountName: bestMatch.precedent?.account.name,
    matchedBy: bestMatch.matchedBy,
  };
}
