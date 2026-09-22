import { useEffect, useState } from 'react';
import { billing, type QuotaDetails } from '../api/client';

// Next plan up from the current one. Plans: pilot → professional → firm.
// Already on firm: no higher tier — point at the portal / sales instead.
function upgradeTarget(planCode?: string): string | null {
  if (planCode === 'professional') return 'firm';
  if (planCode === 'firm') return null;
  return 'professional';
}

export default function QuotaWall({ quota, onClose }: { quota: QuotaDetails; onClose: () => void }) {
  const [capabilities, setCapabilities] = useState<Record<string, boolean> | null>(null);
  const [checkout, setCheckout] = useState<{ checkoutUrl: string | null; mode: string; message: string } | null>(null);
  const [portal, setPortal] = useState<{ portalUrl: string | null; mode: string; message: string } | null>(null);
  const [working, setWorking] = useState<'checkout' | 'portal' | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    billing.provider().then((p) => setCapabilities(p.capabilities)).catch(() => setCapabilities(null));
  }, []);

  const target = upgradeTarget(quota.planCode);
  const pct = quota.includedRunsPerMonth && quota.includedRunsPerMonth > 0 && quota.usedRuns !== undefined
    ? Math.min(100, Math.round((quota.usedRuns / quota.includedRunsPerMonth) * 100))
    : 100;

  const startCheckout = async () => {
    if (!target) return;
    setWorking('checkout');
    setError(null);
    try {
      const res = await billing.checkout(target, 'monthly');
      setCheckout({ checkoutUrl: res.checkoutUrl ?? null, mode: res.mode, message: res.message });
    } catch (e: any) {
      setError(e?.message || 'Checkout failed');
    } finally {
      setWorking(null);
    }
  };

  const openPortal = async () => {
    setWorking('portal');
    setError(null);
    try {
      const res = await billing.portal();
      setPortal({ portalUrl: res.portalUrl ?? null, mode: res.mode, message: res.message });
    } catch (e: any) {
      setError(e?.message || 'Portal failed');
    } finally {
      setWorking(null);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" role="dialog" aria-modal="true" aria-label="Billing quota wall">
      <div className="bg-white rounded-card border border-gray-200 shadow-lg p-6 w-full max-w-lg space-y-4">
        <div className="flex justify-between items-start gap-4">
          <div>
            <h3 className="text-lg font-serif font-semibold text-[#0A192F] tracking-tight">Monthly runs used up</h3>
            <p className="text-xs text-gray-500 mt-1">{quota.message}</p>
          </div>
          <button onClick={onClose} aria-label="Close" className="text-gray-400 hover:text-[#0A192F] text-lg leading-none">×</button>
        </div>

        <div>
          <div className="flex justify-between text-[11px] text-gray-500 mb-1">
            <span>{quota.usedRuns ?? '?'} of {quota.includedRunsPerMonth ?? '?'} included runs</span>
            <span>{quota.planCode ? `${quota.planCode} plan` : ''}{quota.subscriptionStatus ? ` · ${quota.subscriptionStatus}` : ''}</span>
          </div>
          <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
            <div className="h-full bg-[#0A192F] rounded-full" style={{ width: `${pct}%` }} />
          </div>
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 rounded-card p-3 text-xs">{error}</div>
        )}

        {target ? (
          <div className="border border-gray-200 rounded-card p-4 space-y-2">
            <p className="text-xs font-semibold text-[#0A192F]">Upgrade to {target} for more included runs</p>
            {!checkout && (
              <button onClick={startCheckout} disabled={working !== null}
                className="text-xs font-semibold bg-[#0A192F] text-white px-4 py-2 rounded-button disabled:opacity-50">
                {working === 'checkout' ? 'Preparing checkout…' : `Upgrade to ${target}`}
              </button>
            )}
            {checkout?.mode === 'hosted' && checkout.checkoutUrl && (
              <a href={checkout.checkoutUrl} className="inline-block text-xs font-semibold bg-green-700 text-white px-4 py-2 rounded-button">
                Continue to secure checkout →
              </a>
            )}
            {checkout && checkout.mode !== 'hosted' && (
              <p className="text-xs text-gray-600">{checkout.message}</p>
            )}
          </div>
        ) : (
          <p className="text-xs text-gray-500">You're on the top plan — manage seats and billing below.</p>
        )}

        <div className="border-t border-gray-100 pt-3 space-y-2">
          {!portal && (
            <button onClick={openPortal} disabled={working !== null}
              className="text-xs text-[#0A192F] font-semibold hover:underline disabled:opacity-50">
              {working === 'portal' ? 'Opening…' : 'Manage billing / update payment details'}
            </button>
          )}
          {portal?.mode === 'hosted' && portal.portalUrl && (
            <a href={portal.portalUrl} className="block text-xs text-[#0A192F] font-semibold hover:underline">
              Open billing portal →
            </a>
          )}
          {portal && portal.mode !== 'hosted' && (
            <p className="text-xs text-gray-600">{portal.message}</p>
          )}
          {capabilities?.manualBilling && !checkout && !portal && (
            <p className="text-[11px] text-gray-400">Online checkout isn't configured for this workspace — upgrade and portal actions show sales-contact instructions.</p>
          )}
        </div>

        <p className="text-[11px] text-gray-400">After upgrading, close this dialog and retry your run.</p>
      </div>
    </div>
  );
}
