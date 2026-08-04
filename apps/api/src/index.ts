import './telemetry.js';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { compress } from 'hono/compress';
import { env } from './config/env.js';
import { testConnection, closeDb, validateRuntimeRoleSecurity, logSecurityValidation } from './config/db.js';
import { errorHandler } from './lib/middleware/error-handler.js';
import { rateLimiter } from './lib/middleware/rate-limiter.js';
import { requestIdMiddleware } from './lib/request-id.js';
import { healthRoutes } from './modules/health/health.routes.js';
import { authRoutes } from './modules/auth/auth.routes.js';
import { netsuiteRoutes } from './modules/netsuite/netsuite.routes.js';
import { mappingRoutes } from './modules/mapping/mapping.routes.js';
import { provisionRoutes } from './modules/provision/provision.routes.js';
import { importRoutes } from './modules/import/import.routes.js';
import { startAllWorkers } from './workers.js';
import { agentRoutes } from './modules/agent/agent.routes.js';
import { demoRoutes } from './modules/demo/demo.routes.js';
import { uploadRoutes } from './modules/upload/upload.routes.js';
import { billingRoutes } from './modules/billing/billing.routes.js';
import { xeroRoutes } from './modules/integrations/xero/xero.routes.js';
import { qboRoutes } from './modules/integrations/quickbooks/quickbooks.routes.js';
import { documentRoutes } from './modules/documents/documents.routes.js';
import { periodRoutes } from './modules/periods/periods.routes.js';
import { mappingProposalRoutes } from './modules/mapping/proposals.routes.js';
import { ruleRoutes } from './modules/rules/rules.routes.js';
import { reviewLifecycleRoutes } from './modules/review/review.routes.js';
import { workbenchRoutes } from './modules/workbench/workbench.routes.js';
import { handoffRoutes } from './modules/handoff/handoff.routes.js';
import { logger } from './lib/logger.js';
import { shutdownTelemetry } from './telemetry.js';

const app = new Hono();

// ── Global middleware ──
app.use('*', requestIdMiddleware);
app.use('*', cors({
  origin: env.CORS_ORIGIN === '*' ? '*' : env.CORS_ORIGIN,
}));
app.use('*', compress({
  encoding: 'gzip',
}));
app.onError(errorHandler);

// Rate limiting — universal across all environments
app.use('/api/*', rateLimiter);

// ── Health ──
app.route('/api/health', healthRoutes);
// Legacy health path (no auth, simple)
app.get('/health', (c) => c.json({ status: 'ok', timestamp: new Date().toISOString() }));

// ── Routes ──
app.route('/api/auth', authRoutes);
app.route('/api/netsuite', netsuiteRoutes);
app.route('/api/mapping', mappingRoutes);
app.route('/api/provision', provisionRoutes);
app.route('/api/import', importRoutes);
app.route('/api/agent', agentRoutes);
app.route('/api/demo', demoRoutes);
app.route('/api/upload', uploadRoutes);
app.route('/api/billing', billingRoutes);
app.route('/api/documents', documentRoutes);
app.route('/api/periods', periodRoutes);
app.route('/api/mappings', mappingProposalRoutes);
app.route('/api/rules', ruleRoutes);
app.route('/api/review-items', reviewLifecycleRoutes);
app.route('/api/workbench', workbenchRoutes);
app.route('/api/handoff', handoffRoutes);
app.route('/api/xero', xeroRoutes);
// QuickBooks Online is a UK accounting-data source too: the connector is
// always mounted. Sync defaults to a UK FRS 102 entity in GBP.
app.route('/api/qbo', qboRoutes);

// ── Start ──
async function main() {
  await testConnection();

  // Validate runtime role security in non-development or when explicitly requested
  if (env.NODE_ENV !== 'development') {
    const securityResult = await validateRuntimeRoleSecurity();
    logSecurityValidation(securityResult);
    if (!securityResult.valid) {
      logger.error('[Security] Runtime role validation FAILED — refusing to start');
      process.exit(1);
    }
  }

  logger.info({ port: env.PORT, env: env.NODE_ENV }, `[API] Starting`);

  const server = serve({
    fetch: app.fetch,
    port: env.PORT,
  });

  // Start background workers unless delegated to a dedicated worker process
  const workerHandles = env.RUN_WORKERS === 'true' ? startAllWorkers() : null;

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info({ signal }, '[API] Shutdown signal received');
    await workerHandles?.closeAll();
    server.close(async () => {
      logger.info('[API] Server closed');
      await closeDb();
      logger.info('[API] Database pool closed');
      await shutdownTelemetry();
      process.exit(0);
    });

    // Force close after 10s
    setTimeout(() => {
      logger.error('[API] Forced shutdown after timeout');
      process.exit(1);
    }, 10_000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  logger.error({ err }, '[API] Failed to start');
  process.exit(1);
});

export default app;
