import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  DodoBillingProvider,
  DodoBillingError,
  DODO_TEST_HOST,
  DODO_LIVE_HOST,
} from './dodo.js';
import { ProviderNotConfiguredError } from './provider.js';

const ENV = {
  BILLING_PROVIDER: 'dodo',
  DODO_PAYMENTS_API_KEY: 'dodo_test_key',
  DODO_PAYMENTS_PRODUCT_PROFESSIONAL_MONTHLY: 'pdt_pro_monthly',
  DODO_PAYMENTS_PRODUCT_FIRM_ANNUAL: 'pdt_firm_annual',
} as any;

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function stubFetch(impl: (url: string, init?: any) => Promise<Response> | Response) {
  const fn = vi.fn(async (url: string, init?: any) => impl(url, init));
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('DodoBillingProvider — customers', () => {
  it('creates a customer and returns the raw vendor id for the caller to persist', async () => {
    const fetchFn = stubFetch(async (url) => {
      expect(url).toBe(`${DODO_TEST_HOST}/customers`);
      return jsonResponse(200, { customer_id: 'cus_123', email: 'a@firm.co.uk' });
    });
    const p = new DodoBillingProvider({ env: ENV, fetchImpl: fetchFn as any });
    const res = await p.createCustomer({ tenantId: 't1', email: 'a@firm.co.uk', name: 'Acme' });
    expect(res).toEqual({ providerCustomerId: 'cus_123' });
    const [, init] = fetchFn.mock.calls[0];
    expect(init.headers.Authorization).toBe('Bearer dodo_test_key');
    expect(JSON.parse(init.body).metadata).toMatchObject({ tenant_id: 't1' });
  });

  it('refuses customer creation without any identity (fail loudly, no network)', async () => {
    const fetchFn = stubFetch(async () => jsonResponse(200, { customer_id: 'cus_x' }));
    const p = new DodoBillingProvider({ env: ENV, fetchImpl: fetchFn as any });
    await expect(p.createCustomer({ tenantId: 't1' })).rejects.toThrow(/email or a name/);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe('DodoBillingProvider — checkout', () => {
  it('posts the mapped product cart and returns a hosted URL', async () => {
    const fetchFn = stubFetch(async (url) => {
      expect(url).toBe(`${DODO_TEST_HOST}/checkouts`);
      return jsonResponse(200, { session_id: 'ses_1', checkout_url: 'https://checkout.dodo/pay/ses_1' });
    });
    const p = new DodoBillingProvider({ env: ENV, fetchImpl: fetchFn as any });
    const res = await p.createCheckout({
      tenantId: 't1', planCode: 'professional', billingInterval: 'monthly',
      successUrl: 'https://app/success', cancelUrl: 'https://app/cancel',
    });
    expect(res).toMatchObject({ provider: 'dodo', mode: 'hosted', checkoutUrl: 'https://checkout.dodo/pay/ses_1' });
    const sent = JSON.parse(fetchFn.mock.calls[0][1].body);
    expect(sent.product_cart).toEqual([{ product_id: 'pdt_pro_monthly', quantity: 1 }]);
    expect(sent.return_url).toBe('https://app/success');
    expect(sent.cancel_url).toBe('https://app/cancel');
    expect(sent.metadata).toMatchObject({ tenant_id: 't1', plan_code: 'professional' });
  });

  it('defaults an omitted interval to monthly', async () => {
    const fetchFn = stubFetch(async () => jsonResponse(200, { session_id: 's', checkout_url: 'https://x' }));
    const p = new DodoBillingProvider({ env: ENV, fetchImpl: fetchFn as any });
    await p.createCheckout({ tenantId: 't1', planCode: 'professional' });
    expect(JSON.parse(fetchFn.mock.calls[0][1].body).product_cart).toEqual([{ product_id: 'pdt_pro_monthly', quantity: 1 }]);
  });

  it('names the exact env var when a plan/interval has no product mapping', async () => {
    const fetchFn = stubFetch(async () => jsonResponse(200, {}));
    const p = new DodoBillingProvider({ env: ENV, fetchImpl: fetchFn as any });
    await expect(p.createCheckout({ tenantId: 't1', planCode: 'pilot', billingInterval: 'monthly' }))
      .rejects.toThrow(/DODO_PAYMENTS_PRODUCT_PILOT_MONTHLY/);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('maps 502 with status (never the key) on upstream rejection', async () => {
    const fetchFn = stubFetch(async () => jsonResponse(422, { message: 'Unknown product' }));
    const p = new DodoBillingProvider({ env: ENV, fetchImpl: fetchFn as any });
    const err = await p.createCheckout({ tenantId: 't1', planCode: 'professional' }).catch((e) => e);
    expect(err).toBeInstanceOf(DodoBillingError);
    expect((err as DodoBillingError).statusCode).toBe(502);
    expect((err as Error).message).toContain('HTTP 422');
    expect((err as Error).message).not.toContain('dodo_test_key');
  });
});

describe('DodoBillingProvider — portal', () => {
  it('creates a portal session through the stored customer id', async () => {
    const fetchFn = stubFetch(async (url) => {
      expect(url).toBe(`${DODO_TEST_HOST}/customers/cus_123/customer-portal/session?return_url=https%3A%2F%2Fapp%2Fbilling`);
      return jsonResponse(200, { link: 'https://portal.dodo/s/cus_123' });
    });
    const p = new DodoBillingProvider({
      env: ENV, fetchImpl: fetchFn as any, resolveCustomerId: async () => 'cus_123',
    });
    const res = await p.createPortalSession({ tenantId: 't1', returnUrl: 'https://app/billing' });
    expect(res).toMatchObject({ provider: 'dodo', mode: 'hosted', portalUrl: 'https://portal.dodo/s/cus_123' });
  });

  it('fails loudly when no customer mapping exists (never guesses)', async () => {
    const fetchFn = stubFetch(async () => jsonResponse(200, { link: 'https://x' }));
    const p = new DodoBillingProvider({ env: ENV, fetchImpl: fetchFn as any });
    await expect(p.createPortalSession({ tenantId: 't1' })).rejects.toThrow(/stored Dodo customer id/);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe('DodoBillingProvider — configuration', () => {
  it('throws 501 without an API key (same contract as before the adapter)', async () => {
    const p = new DodoBillingProvider({ env: { BILLING_PROVIDER: 'dodo' } as any });
    await expect(p.createCheckout({ tenantId: 't1', planCode: 'professional' }))
      .rejects.toThrow(ProviderNotConfiguredError);
  });

  it('uses the live host only on explicit live_mode (safe default is test)', async () => {
    const seen: string[] = [];
    const fetchFn = stubFetch(async (url) => {
      seen.push(url);
      return jsonResponse(200, { customer_id: 'cus_1' });
    });
    await new DodoBillingProvider({ env: ENV, fetchImpl: fetchFn as any })
      .createCustomer({ tenantId: 't1', email: 'a@b.co' });
    expect(seen[0].startsWith(DODO_TEST_HOST)).toBe(true);

    await new DodoBillingProvider({
      env: { ...ENV, DODO_PAYMENTS_ENVIRONMENT: 'live_mode' }, fetchImpl: fetchFn as any,
    }).createCustomer({ tenantId: 't1', email: 'a@b.co' });
    expect(seen[1].startsWith(DODO_LIVE_HOST)).toBe(true);
  });
});
