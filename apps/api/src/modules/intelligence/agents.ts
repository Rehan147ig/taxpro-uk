import { defineAgent } from '../../eve/agent.js';

/**
 * The platform's agent roster — the registry the provenance API exposes so
 * the platform can prove what agents exist and what each one emits/consumes.
 *
 * NOTE: registration is declarative; the actual agent execution lives in the
 * respective modules (intake agent, mapping agent, credit miner, ...). The
 * registry is the single source of truth for names — never string-literal
 * agents elsewhere.
 */
export function defineIntelligenceAgents(): void {
  defineAgent({
    name: 'platform',
    description: 'The deterministic application core. Emits the raw system events that specialised agents subscribe to; never consumes.',
    emits: ['intake.batch_uploaded', 'provision.run_created', 'provision.result_calculated'],
    consumes: [],
  });

  defineAgent({
    name: 'intake_agent',
    description: 'Suggests UK tax classifications for imported trial balance accounts (advisory only, always human-reviewed).',
    emits: ['intake.suggestions_generated', 'intake.batch_committed'],
    consumes: ['intake.batch_uploaded'],
  });

  defineAgent({
    name: 'mapping_agent',
    description: 'Proposes tax mappings for unmapped accounts when a provision run starts.',
    emits: ['mapping.proposals_generated'],
    consumes: ['provision.run_created'],
  });

  defineAgent({
    name: 'audit_defense_agent',
    description: 'Drafts an audit defence memo for a provision result.',
    emits: ['audit.memo_drafted'],
    consumes: ['provision.result_calculated'],
  });

  defineAgent({
    name: 'credit_miner',
    description: 'Surfaces tax credit opportunities (R&D, CTA 2010 s.1098 etc.) for a run.',
    emits: ['credits.opportunities_surfaced'],
    consumes: ['provision.result_calculated'],
  });

  defineAgent({
    name: 'learning_system',
    description: 'Deterministic feedback consumer. Turns reviewer decisions into tax memory and drift signals.',
    emits: ['learning.adjustment_approved', 'learning.adjustment_rejected', 'learning.suggestion_decided'],
    consumes: ['learning.adjustment_approved', 'learning.adjustment_rejected'],
  });
}
