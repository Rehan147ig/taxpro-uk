import { z } from 'zod';

/**
 * QuickBooks Online is a UK accounting-data source: the connector is always
 * mounted and sync defaults produce a UK FRS 102 entity in GBP.
 */
export const DEFAULT_SYNC_JURISDICTION = 'UK_FRS102';
export const DEFAULT_SYNC_CURRENCY = 'GBP';

export const syncParamsSchema = z.object({
  periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  entityName: z.string().max(255).optional(),
  jurisdiction: z
    .string()
    .max(100)
    .regex(/^[A-Za-z0-9_-]+$/, 'Jurisdiction may only contain letters, numbers, underscores and hyphens')
    .default(DEFAULT_SYNC_JURISDICTION),
  currency: z
    .string()
    .length(3)
    .regex(/^[A-Z]{3}$/, 'Currency must be a three-letter ISO code')
    .default(DEFAULT_SYNC_CURRENCY),
});
