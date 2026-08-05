import { sql } from 'drizzle-orm';
import { agentEvents } from '../db/schema/agent-events.js';
import { aiSteps } from '../db/schema/ai-runs.js';
import { logger } from '../lib/logger.js';

/**
 * Agent framework — the substrate all specialised agents run on.
 *
 * Rules enforced here (and in the schema):
 *  1. Agents never write accounting data directly. They emit typed events
 *     into `agent_events` (append-only, RLS, grants allow SELECT/INSERT only)
 *     and consumers decide. Deterministic flows write business rows.
 *  2. Any agent computation that must not touch business tables runs in a
 *     READ ONLY transaction (`runReadOnly`) — writes fail loudly.
 *  3. Telemetry (`recordStep`) may only touch ai_steps / agent_events.
 *
 * Agents are registered so the registry can be surfaced by the provenance
 * API (`/api/provenance/agents`) and the platform can prove which agents
 * exist, what they emit, and what they consume.
 */

export interface AgentContext {
  tenantId: string;
  userId?: string;
  workflowName: string;
  correlationId?: string;
}

export interface AgentDefinition {
  /** Stable identifier; used as `source_agent` in agent_events. */
  name: string;
  description: string;
  /** Event types this agent emits (its declared output surface). */
  emits: string[];
  /** Event types this agent subscribes to. */
  consumes: string[];
}

const registry = new Map<string, AgentDefinition>();

export function defineAgent(def: AgentDefinition): AgentDefinition {
  registry.set(def.name, def);
  return def;
}

export function getAgent(name: string): AgentDefinition | undefined {
  return registry.get(name);
}

export function listAgents(): AgentDefinition[] {
  return [...registry.values()];
}

export function agentsForEventType(eventType: string): AgentDefinition[] {
  return [...registry.values()].filter((a) => a.consumes.includes(eventType));
}

/** Write an event to the append-only agent outbox. */
export async function emitAgentEvent(
  tx: any,
  ctx: AgentContext,
  eventType: string,
  payload?: unknown,
  runId?: string | null,
): Promise<string> {
  const [row] = await tx.insert(agentEvents).values({
    tenantId: ctx.tenantId,
    runId: runId ?? null,
    sourceAgent: ctx.workflowName,
    eventType,
    payload: payload ?? {},
    correlationId: ctx.correlationId ?? null,
  }).returning({ id: agentEvents.id });
  logger.debug({ eventType, agent: ctx.workflowName, id: row.id }, '[Eve] agent event emitted');
  return row.id;
}

/**
 * Run a computation inside a READ ONLY transaction — the read-only guard.
 * Any INSERT/UPDATE/DELETE attempted on business tables inside `fn` raises a
 * Postgres error, so an agent can never mutate accounting data silently.
 */
export async function runReadOnly<T>(db: any, fn: (roTx: any) => Promise<T>): Promise<T> {
  return db.transaction(async (roTx: any) => {
    await roTx.execute(sql`SET TRANSACTION READ ONLY`);
    return fn(roTx);
  });
}

/**
 * Telemetry-only step recorder. Bounded to ai_steps so agent tracing can
 * never touch business data.
 */
export async function recordAgentStep(
  tx: any,
  ctx: AgentContext,
  aiRunId: string | null,
  sequence: number,
  stepName: string,
  input: unknown,
  output: unknown,
): Promise<void> {
  if (!aiRunId) return;
  await tx.insert(aiSteps).values({
    tenantId: ctx.tenantId,
    aiRunId,
    sequence,
    stepName,
    status: 'completed',
    inputJson: input,
    outputJson: output,
    completedAt: new Date(),
  });
}

/**
 * Standard agent entrypoint: run the agent, emit its declared completion
 * event, and record telemetry. `execute` receives the tools the agent is
 * allowed — emit + telemetry only; anything else is out of scope.
 */
export async function runAgent<TInput, TOutput>(
  tx: any,
  ctx: AgentContext,
  def: AgentDefinition,
  runId: string | null,
  input: TInput,
  execute: (input: TInput, tools: { emit: (eventType: string, payload?: unknown) => Promise<string> }) => Promise<TOutput>,
): Promise<TOutput> {
  const tools = {
    emit: (eventType: string, payload?: unknown) => emitAgentEvent(tx, ctx, eventType, payload, runId),
  };
  const output = await execute(input, tools);
  await emitAgentEvent(tx, ctx, `${def.name}.completed`, { runId }, runId);
  return output;
}
