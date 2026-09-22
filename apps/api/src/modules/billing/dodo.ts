/**
 * Dodo Payments adapter (merchant of record).
 *
 * Plugs into BillingProvider without touching routes, entitlements, or
 * invoices: the routes keep calling the same three methods, and the frontend
 * keeps branching on `mode: 'hosted' | 'manual'`.
 *
 * Design constraints (do not weaken):
 * - No vendor SDK: direct HTTPS REST against the documented endpoints, so no
 *   new dependency enters the lockfile (no OSV surface, no supply-chain).
 * - Fail loudly: missing API key → 501 via ProviderNotConfiguredError (same
 *   contract as before this adapter existed); missing product mapping names
 *   the exact env var; upstream failures surface as 502 with a truncated,
 *   key-free message. Nothing degrades to a fake success.
 * - Safe defaults: test_mode host unless DODO_PAYMENTS_ENVIRONMENT=live_mode
 *   explicitly — a misconfiguration can never live-charge.
 * - Secrets never logged: the Bearer key travels in exactly one header and
 *   is never interpolated into messages, metadata, or error details.
 *
 * Verified against the public Dodo Payments OpenAPI (v1.113.x):
 * - POST {host}/customers {email?, name?, metadata?} → {customer_id, ...}
 * - POST {host}/checkouts {product_cart:[{product_id, quantity}],
 *   customer?, return_url?, cancel_url?, metadata?}
 *   → {session_id, checkout_url} (single-use, 24h expiry — never cached)
 * - POST {host}/customers/{customer_id}/customer-portal/session
 *   (?return_url=) → {link, ...}
 *
 * Out of scope (follow-up, needs a webhook route + secret verification):
 * inbound Dodo webhooks. BILLING_PROVIDER_WEBHOOK_SECRET is already reserved
 * in .env.example for that step.
 */

import {
  ProviderNotConfiguredError,
  type BillingCheckoutInput,
  type BillingCheckoutResult,
  type BillingCustomerInput,
  type BillingPortalInput,
  type BillingPortalResult,
  type BillingProvider,
  type BillingProviderName,
} from './provider.js';

export const DODO_TEST_HOST = 'https://test.dodopayments.com';
export const DODO_LIVE_HOST = 'https://live.dodopayments.com';
export const DODO_REQUEST_TIMEOUT_MS = 15_000;
export const DODO_PRODUCT_ENV_PREFIX = 'DODO_PAYMENTS_PRODUCT_';

export type DodoEnvironment = 'test_mode' | 'live_mode';

export interface DodoBillingOptions {
  /** Defaults to process.env at call time (keeps tests hermetic). */
  env?: NodeJS.ProcessEnv;
  /** Override for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /**
   * Resolves a stored Dodo customer id for a tenant (from wherever the
   * caller persisted createCustomer's providerCustomerId). Portal sessions
   * require it; without one, createPortalSession fails loudly with an
   * actionable message instead of guessing.
   */
  resolveCustomerId?: (tenantId: string) => Promise<string | null>;
}

export class DodoBillingError extends Error {
  readonly statusCode = 502;
  constructor(message: string) {
    super(message);
    this.name = 'DodoBillingError';
  }
}

function readEnv(options: DodoBillingOptions | undefined): NodeJS.ProcessEnv {
  return options?.env ?? process.env;
}

function resolveApiKey(env: NodeJS.ProcessEnv): string {
  const key = (env.DODO_PAYMENTS_API_KEY ?? '').trim();
  if (!key) {
    // Same 501 contract the seam had before this adapter existed.
    throw new ProviderNotConfiguredError('dodo');
  }
  return key;
}

function resolveHost(env: NodeJS.ProcessEnv): string {
  return String(env.DODO_PAYMENTS_ENVIRONMENT ?? 'test_mode').toLowerCase() === 'live_mode'
    ? DODO_LIVE_HOST
    : DODO_TEST_HOST;
}

/** "<PLAN>_<INTERVAL>" (uppercased) → Dodo product id, from env. */
function resolveProducts(env: NodeJS.ProcessEnv): Record<string, string> {
  const map: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith(DODO_PRODUCT_ENV_PREFIX) && value?.trim()) {
      map[key.slice(DODO_PRODUCT_ENV_PREFIX.length)] = value.trim();
    }
  }
  return map;
}

function productEnvVar(planCode: string, interval: string): string {
  return `${DODO_PRODUCT_ENV_PREFIX}${planCode.trim().toUpperCase()}_${interval.trim().toUpperCase()}`;
}

async function dodoRequest(
  options: DodoBillingOptions | undefined,
  env: NodeJS.ProcessEnv,
  path: string,
  body: Record<string, unknown>,
): Promise<any> {
  const impl = options?.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await impl(`${resolveHost(env)}${path}`, {
      method: 'POST',
      headers: {
        // The key travels in this header only — never in logs or messages.
        Authorization: `Bearer ${resolveApiKey(env)}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(DODO_REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw new DodoBillingError(
      `Dodo Payments is unreachable (${err instanceof Error ? err.name : 'network error'}). Retry or check DODO_PAYMENTS_ENVIRONMENT.`,
    );
  }
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 300);
    throw new DodoBillingError(
      `Dodo Payments rejected the request (HTTP ${res.status})${detail ? `: ${detail}` : ''}.`,
    );
  }
  return res.json().catch(() => ({}));
}

export class DodoBillingProvider implements BillingProvider {
  readonly name: BillingProviderName = 'dodo';

  constructor(private readonly options?: DodoBillingOptions) {}

  async createCustomer(input: BillingCustomerInput): Promise<{ providerCustomerId: string }> {
    const env = readEnv(this.options);
    resolveApiKey(env);
    if (!input.email?.trim() && !input.name?.trim()) {
      throw new DodoBillingError('Dodo customer creation needs an email or a name.');
    }
    const body = await dodoRequest(this.options, env, '/customers', {
      ...(input.email?.trim() ? { email: input.email.trim() } : {}),
      ...(input.name?.trim() ? { name: input.name.trim() } : {}),
      metadata: { tenant_id: input.tenantId },
    });
    const customerId = typeof body?.customer_id === 'string' ? body.customer_id.trim() : '';
    if (!customerId) {
      throw new DodoBillingError('Dodo Payments returned no customer_id.');
    }
    // Raw vendor id (no prefix): the portal path needs it verbatim, and the
    // `provider: 'dodo'` field on every result already states the origin.
    // Callers must persist this against the tenant for portal sessions.
    return { providerCustomerId: customerId };
  }

  async createCheckout(input: BillingCheckoutInput): Promise<BillingCheckoutResult> {
    const env = readEnv(this.options);
    resolveApiKey(env);
    const interval = input.billingInterval ?? 'monthly';
    const products = resolveProducts(env);
    const key = `${input.planCode.trim().toUpperCase()}_${interval.trim().toUpperCase()}`;
    const productId = products[key];
    if (!productId) {
      throw new DodoBillingError(
        `No Dodo product is mapped for plan "${input.planCode}" (${interval}). Set ${productEnvVar(input.planCode, interval)} to the dashboard product id.`,
      );
    }
    const body = await dodoRequest(this.options, env, '/checkouts', {
      product_cart: [{ product_id: productId, quantity: 1 }],
      ...(input.successUrl ? { return_url: input.successUrl } : {}),
      ...(input.cancelUrl ? { cancel_url: input.cancelUrl } : {}),
      metadata: { tenant_id: input.tenantId, plan_code: input.planCode, billing_interval: interval },
    });
    // checkout_url is single-use with 24h expiry — returned fresh, never cached.
    if (typeof body?.checkout_url !== 'string' || !body.checkout_url) {
      throw new DodoBillingError('Dodo Payments returned no checkout_url.');
    }
    return {
      provider: 'dodo',
      checkoutUrl: body.checkout_url,
      mode: 'hosted',
      message: `Hosted Dodo checkout for ${input.planCode} (${interval}).`,
    };
  }

  async createPortalSession(input: BillingPortalInput): Promise<BillingPortalResult> {
    const env = readEnv(this.options);
    resolveApiKey(env);
    const customerId = await this.options?.resolveCustomerId?.(input.tenantId) ?? null;
    if (!customerId?.trim()) {
      throw new DodoBillingError(
        'Dodo portal sessions need the stored Dodo customer id for this tenant (returned by createCustomer). ' +
        'Persist it and pass resolveCustomerId to DodoBillingProvider.',
      );
    }
    const query = input.returnUrl ? `?return_url=${encodeURIComponent(input.returnUrl)}` : '';
    const body = await dodoRequest(
      this.options,
      env,
      `/customers/${encodeURIComponent(customerId.trim())}/customer-portal/session${query}`,
      {},
    );
    if (typeof body?.link !== 'string' || !body.link) {
      throw new DodoBillingError('Dodo Payments returned no portal link.');
    }
    return {
      provider: 'dodo',
      portalUrl: body.link,
      mode: 'hosted',
      message: 'Hosted Dodo customer portal session.',
    };
  }
}
