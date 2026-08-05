import { Hono } from 'hono';
import { withTenantContext } from '../../config/db.js';
import { authMiddleware } from '../../lib/middleware/auth.js';
import { getProvenanceForDocument, getProvenanceForResult } from './provenance.service.js';
import { listAgents } from '../../eve/agent.js';
import { defineIntelligenceAgents } from './agents.js';

defineIntelligenceAgents();

export const provenanceRoutes = new Hono();
provenanceRoutes.use('*', authMiddleware);

/**
 * Provenance — how a result was calculated, from which balances, via which
 * batches, backed by which documents and agents. The audit answer to
 * "why does this number exist?".
 */
provenanceRoutes.get('/results/:resultId', async (c) => {
  const user = c.get('user');
  const resultId = c.req.param('resultId');
  return withTenantContext(user.tenantId, async (tx) => {
    const provenance = await getProvenanceForResult(tx, user.tenantId, resultId);
    return c.json({ provenance });
  });
});

provenanceRoutes.get('/documents/:documentId', async (c) => {
  const user = c.get('user');
  const documentId = c.req.param('documentId');
  return withTenantContext(user.tenantId, async (tx) => {
    const provenance = await getProvenanceForDocument(tx, user.tenantId, documentId);
    return c.json({ provenance });
  });
});

/** The agent registry: what agents exist, what they emit and consume. */
provenanceRoutes.get('/agents', async (c) => {
  return c.json({ agents: listAgents() });
});
