'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

type Props = {
  refValue: string;
  clientSecret: string;
  status: string;
  canSimulate: boolean;
};

// Rafraichit la page tant que le paiement sortant attend son SMS de debit
// (statut mis a jour cote serveur), et, en mode test, propose de simuler
// ce SMS -- meme bouton que "Simuler le paiement" des paiements entrants.
export function PayoutActions({ refValue, clientSecret, status, canSimulate }: Props) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (status !== 'pending') return;
    const timer = setInterval(() => router.refresh(), 5000);
    return () => clearInterval(timer);
  }, [status, router]);

  async function simulate() {
    setPending(true);
    setErr(null);
    try {
      const res = await fetch('/api/v1/test/sandbox-simulate-payout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ref: refValue, client_secret: clientSecret }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => null);
        setErr(j?.error?.message ?? `HTTP ${res.status}`);
        return;
      }
      router.refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Network error');
    } finally {
      setPending(false);
    }
  }

  if (!canSimulate) return null;

  return (
    <div className="mt-6 pt-5 border-t border-[var(--stone-200)]">
      <p className="kp-eyebrow text-[var(--bronze)] mb-3 text-center">— Outil sandbox</p>
      <button
        type="button"
        onClick={simulate}
        disabled={pending}
        className="w-full inline-flex items-center justify-center gap-2 font-mono text-[11px] tracking-wider uppercase border border-[var(--bronze)]/40 text-[var(--bronze)] bg-[var(--gold-soft)]/40 hover:bg-[var(--gold-soft)]/70 hover:border-[var(--bronze)] rounded-sm px-4 py-2.5 cursor-pointer transition-colors duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {pending ? 'Simulation…' : 'Simuler le paiement'}
      </button>
      {err && (
        <p className="mt-2 text-sm text-[#9b1c1c] border-l-2 border-[#9b1c1c] pl-3" role="alert">
          {err}
        </p>
      )}
    </div>
  );
}
