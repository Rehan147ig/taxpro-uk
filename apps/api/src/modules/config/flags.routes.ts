import { Hono } from 'hono';
import { getIntakeFlags } from '../../config/features.js';
import { authMiddleware } from '../../lib/middleware/auth.js';

/**
 * Feature-flag surface for the intake hardening pass.
 *
 * GET /api/config/flags → { INTAKE_XLSX, INTAKE_SIGN_CONVENTION,
 *   INTAKE_PRIOR_BRIDGE, INTAKE_ASSET_REGISTER }
 *
 * All flags default off. Enable per-tenant via environment
 * (INTAKE_XLSX=true, …). Auth required; read-only for all roles.
 */
export const flagsRoutes = new Hono();
flagsRoutes.use('*', authMiddleware);

flagsRoutes.get('/flags', async (c) => {
  return c.json(getIntakeFlags());
});
