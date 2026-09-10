/**
 * Provider-neutral billing seam (P0-neutral).
 *
 * The product does not commit to Stripe or Dodo Payments yet. All checkout,
 * portal, and webhook logic must go through this interface so either vendor
 * can plug in later without touching provision, entitlement, or invoice code.
 *
 * - `local`: manual/offline billing for dev + paid pilots (no vendor SDK,
 *   no network calls). Checkout returns instructions, never a URL.
 * - `stripe` / `dodo`: reserved names. Requesting one before its adapter
 *   is implemented throws a clear 501 (not a silent fallback), so a
 *   misconfiguration can never look like a successful payment.
 */

export type BillingProviderName = 'local' | 'stripe' | 'dodo';

export interface BillingCustomerInput {
  tenantId: string;
  email?: string | null;
  name?: string | null;
}

export interface BillingCheckoutInput {
  tenantId: string;
  planCode: string;
  billingInterval?: 'monthly' | 'annual';
  successUrl?: string;
  cancelUrl?: string;
}

export interface BillingCheckoutResult {
  provider: BillingProviderName;
  /** Vendor-hosted URL when the provider supports hosted checkout, else null. */
  checkoutUrl: string | null;
  /** Machine-readable mode the frontend branches on. */
  mode: 'hosted' | 'manual';
  message: string;
}

export interface BillingPortalInput {
  tenantId: string;
  returnUrl?: string;
}

export interface BillingPortalResult {
  provider: BillingProviderName;
  portalUrl: string | null;
  mode: 'hosted' | 'manual';
  message: string;
}

export interface BillingProvider {
  readonly name: BillingProviderName;
  createCustomer(input: BillingCustomerInput): Promise<{ providerCustomerId: string }>;
  createCheckout(input: BillingCheckoutInput): Promise<BillingCheckoutResult>;
  createPortalSession(input: BillingPortalInput): Promise<BillingPortalResult>;
}

export class ProviderNotConfiguredError extends Error {
  readonly statusCode = 501;
  constructor(provider: string) {
    super(
      `Billing provider "${provider}" is not implemented. Set BILLING_PROVIDER=local for manual pilot billing, or implement the "${provider}" adapter behind BillingProvider with its API key + webhook secret.`,
    );
    this.name = 'ProviderNotConfiguredError';
  }
}

/** Manual/offline billing: no vendor, no network, no SDK. */
export class LocalBillingProvider implements BillingProvider {
  readonly name: BillingProviderName = 'local';

  async createCustomer(input: BillingCustomerInput): Promise<{ providerCustomerId: string }> {
    // Stable local id so billing_accounts can store a mapping before a
    // vendor exists. Format makes the origin obvious in every downstream log.
    return { providerCustomerId: `local_${input.tenantId}` };
  }

  async createCheckout(input: BillingCheckoutInput): Promise<BillingCheckoutResult> {
    return {
      provider: 'local',
      checkoutUrl: null,
      mode: 'manual',
      message: `Manual billing: contact sales to activate ${input.planCode} (${input.billingInterval ?? 'monthly'}). No online checkout is configured.`,
    };
  }

  async createPortalSession(_input: BillingPortalInput): Promise<BillingPortalResult> {
    return {
      provider: 'local',
      portalUrl: null,
      mode: 'manual',
      message: 'Manual billing: no self-serve portal. Contact your billing administrator to change plan or payment details.',
    };
  }
}

export function getBillingProviderName(env: NodeJS.ProcessEnv = process.env): BillingProviderName {
  const raw = String(env.BILLING_PROVIDER ?? 'local').toLowerCase();
  if (raw === 'stripe' || raw === 'dodo' || raw === 'local') return raw;
  return 'local';
}

/** Factory: the single place that maps a name to an implementation. */
export function getBillingProvider(env: NodeJS.ProcessEnv = process.env): BillingProvider {
  const name = getBillingProviderName(env);
  if (name === 'local') return new LocalBillingProvider();
  // Stripe / Dodo adapters plug in here later (vendor SDK + webhook
  // verification isolated to those classes). Until then, fail loudly.
  throw new ProviderNotConfiguredError(name);
}
