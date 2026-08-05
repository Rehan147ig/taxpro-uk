// ─────────────────────────────────────────────────────────────────────────────
// Legacy subagent → eve/agent.ts framework adapters.
//
// The legacy subagents (`runMappingAgent`, `draftAuditMemo`, `mineCredits`)
// are pure inference functions: they never write to business tables. These
// adapters put them on the unified framework so every subagent run:
//
//   1. executes inside the read-only guard (`runReadOnly` — SET TRANSACTION
//      READ ONLY; any accidental write fails loudly),
//   2. runs through `runAgent` so its completion event
//      (`<agent>.completed`) lands in the append-only `agent_events`
//      outbox,
//   3. emits its declared discovery event (`mapping.proposals_generated`,
//      `audit.memo_drafted`, `credits.opportunities_surfaced`) — matching
//      the roster in `modules/intelligence/agents.ts`.
//
// Note: `agent_events.run_id` is an FK to `ai_runs`, so the provision run id
// travels in the event payload, never in the run_id column.
// ─────────────────────────────────────────────────────────────────────────────

import { db } from '../../config/db.js';
import { runAgent, runReadOnly, getAgent, type AgentContext } from '../../eve/agent.js';
import { defineIntelligenceAgents } from '../../modules/intelligence/agents.js';
import { runMappingAgent, type MappingAgentInput, type MappingAgentResult } from './mapping-agent.js';
import { draftAuditMemo, type AuditDefenseInput, type AuditDefenseResult } from './audit-defense.js';
import { mineCredits, type CreditMinerInput, type CreditMinerResult } from './credit-miner.js';

function ensureRoster(): void {
  if (!getAgent('mapping_agent')) defineIntelligenceAgents();
}

/** Framework wrapper for the mapping agent (stage 1 + stage 2 classification). */
export async function runMappingAgentAsAgent(
  tx: any,
  ctx: AgentContext,
  provisionRunId: string,
  input: MappingAgentInput,
): Promise<MappingAgentResult> {
  ensureRoster();
  const def = getAgent('mapping_agent')!;
  return runAgent(tx, ctx, def, null, input, async (inp, tools) => {
    const result = await runReadOnly(db, () => runMappingAgent(inp));
    if (result.success) {
      await tools.emit('mapping.proposals_generated', {
        provisionRunId,
        proposals: result.taxMappings.length,
        classifications: result.typeClassifications.length,
      });
    }
    return result;
  });
}

/** Framework wrapper for the audit defence agent (ETR walk + technical memos). */
export async function draftAuditMemoAsAgent(
  tx: any,
  ctx: AgentContext,
  provisionRunId: string,
  input: AuditDefenseInput,
): Promise<AuditDefenseResult> {
  ensureRoster();
  const def = getAgent('audit_defense_agent')!;
  return runAgent(tx, ctx, def, null, input, async (inp, tools) => {
    const result = await runReadOnly(db, () => draftAuditMemo(inp));
    // The failure shape is a memo with qualityScore 0 and an error banner.
    if (result.qualityScore > 0) {
      await tools.emit('audit.memo_drafted', {
        provisionRunId,
        technicalMemos: result.technicalMemos.length,
        riskFlags: result.riskFlags.length,
        qualityScore: result.qualityScore,
      });
    }
    return result;
  });
}

/** Framework wrapper for the credit miner agent (deterministic credit math). */
export async function mineCreditsAsAgent(
  tx: any,
  ctx: AgentContext,
  provisionRunId: string,
  input: CreditMinerInput,
): Promise<CreditMinerResult> {
  ensureRoster();
  const def = getAgent('credit_miner')!;
  return runAgent(tx, ctx, def, null, input, async (inp, tools) => {
    const result = await runReadOnly(db, () => mineCredits(inp));
    if (result.success) {
      await tools.emit('credits.opportunities_surfaced', {
        provisionRunId,
        opportunities: result.summary.creditCount,
        totalIdentifiedCredits: result.summary.totalIdentifiedCredits,
      });
    }
    return result;
  });
}
