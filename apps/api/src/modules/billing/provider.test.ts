import { describe, expect, it } from 'vitest';
import { getBillingProvider, getBillingProviderName, LocalBillingProvider, ProviderNotConfiguredError } from './provider.js';

describe('getBillingProviderName', () => {
  it('defaults to local', () => {
    expect(getBillingProviderName({} as any)).toBe('local');
  });

  it('accepts stripe and dodo as reserved names', () => {
    expect(getBillingProviderName({ BILLING_PROVIDER: 'stripe' } as any)).toBe('stripe');
    expect(getBillingProviderName({ BILLING_PROVIDER: 'dodo' } as any)).toBe('dodo');
  });

  it('falls back to local on unknown values', () => {
    expect(getBillingProviderName({ BILLING_PROVIDER: 'bogus' } as any)).toBe('local');
  });
});

describe('LocalBillingProvider', () => {
  it('creates stable manual customer ids without network', async () => {
    const p = new LocalBillingProvider();
    const res = await p.createCustomer({ tenantId: 't1' });
    expect(res.providerCustomerId).toBe('local_t1');
  });

  it('returns manual checkout (no URL, sales instructions)', async () => {
    const p = new LocalBillingProvider();
    const res = await p.createCheckout({ tenantId: 't1', planCode: 'professional' });
    expect(res.mode).toBe('manual');
    expect(res.checkoutUrl).toBeNull();
    expect(res.message).toMatch(/manual billing/i);
  });

  it('returns manual portal (no URL)', async () => {
    const p = new LocalBillingProvider();
    const res = await p.createPortalSession({ tenantId: 't1' });
    expect(res.mode).toBe('manual');
    expect(res.portalUrl).toBeNull();
  });
});

describe('getBillingProvider', () => {
  it('returns local provider by default', () => {
    expect(getBillingProvider({} as any).name).toBe('local');
  });

  it('fails loudly for unimplemented vendors (never silent success)', () => {
    expect(() => getBillingProvider({ BILLING_PROVIDER: 'stripe' } as any))
      .toThrow(ProviderNotConfiguredError);
    expect(() => getBillingProvider({ BILLING_PROVIDER: 'dodo' } as any))
      .toThrow(ProviderNotConfiguredError);
  });
});
