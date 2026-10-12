import { notFound } from 'next/navigation';
import { createSupabaseAdminClient } from '@/lib/supabase/server';
import { formatMRU } from '@/lib/format';
import { PayoutActions } from './PayoutActions';

export const metadata = { title: 'Paiement sortant · KitPay' };
export const dynamic = 'force-dynamic';

type PayoutRow = {
  ref: string;
  merchant_id: string;
  mode: string;
  method: string;
  amount: number;
  amount_with_fees: number | null;
  recipient_phone: string;
  recipient_name: string | null;
  description: string | null;
  metadata: Record<string, unknown> | null;
  status: string;
  operator_reference: string | null;
  client_secret: string | null;
  created_at: string;
  expires_at: string;
  paid_at: string | null;
};

const STATUS_LABELS: Record<string, { label: string; color: string }> = {
  pending: { label: 'En attente du SMS de débit', color: 'var(--bronze)' },
  paid: { label: 'Paiement confirmé', color: 'var(--forest)' },
  expired: { label: 'Expiré', color: 'var(--stone-500)' },
  cancelled: { label: 'Annulé', color: 'var(--stone-500)' },
};

const METHOD_LOGOS: Record<string, string> = {
  bankily: '/payments/bankily.png',
  masrvi: '/payments/masrvi.png',
  sedad: '/payments/sedad.png',
  bim: '/payments/bim.png',
  click: '/payments/click.png',
  bcipay: '/payments/bcipay.png',
};

// 36123456 -> 36 12 34 56 (plus facile a recopier dans l'appli operateur).
function formatPhone(phone: string): string {
  return phone.replace(/(\d{2})(?=\d)/g, '$1 ');
}

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('fr-FR', {
    dateStyle: 'short', timeStyle: 'short', timeZone: 'Africa/Nouakchott',
  }).format(new Date(iso));
}

// Page d'un paiement SORTANT (le marchand envoie de l'argent) : equivalent
// de /pay/{ref} pour les paiements entrants. Accessible uniquement avec le
// client_secret du paiement (?cs=...), donne au marchand par l'API.
export default async function PayoutPage({
  params, searchParams,
}: { params: { ref: string }; searchParams: { cs?: string } }) {
  const admin = createSupabaseAdminClient();
  const { data: payout } = await admin
    .from('payout_intents')
    .select('ref, merchant_id, mode, method, amount, amount_with_fees, recipient_phone, recipient_name, description, metadata, status, operator_reference, client_secret, created_at, expires_at, paid_at')
    .eq('ref', params.ref)
    .maybeSingle<PayoutRow>();

  if (!payout || !payout.client_secret || searchParams.cs !== payout.client_secret) {
    notFound();
  }

  const { data: merchant } = await admin
    .from('merchants')
    .select('name')
    .eq('id', payout.merchant_id)
    .maybeSingle<{ name: string }>();

  const status = STATUS_LABELS[payout.status] ?? { label: payout.status, color: 'var(--stone-500)' };
  const logo = METHOD_LOGOS[payout.method.toLowerCase()] ?? null;
  // Moyen choisi par le marchand : code marchand du destinataire (paiement
  // par code, sans frais) ou son numero -- envoye par l'application
  // marchande dans metadata.code_marchand (voir docs/payouts.md).
  const rawCode = payout.metadata?.code_marchand;
  const merchantCode = typeof rawCode === 'string' && rawCode.trim() ? rawCode.trim() : null;
  const rows: Array<[string, string]> = [
    ['Bénéficiaire', payout.recipient_name || '—'],
    ...(merchantCode ? [['Code marchand', merchantCode] as [string, string]] : []),
    ...(payout.recipient_phone ? [['Numéro', formatPhone(payout.recipient_phone)] as [string, string]] : []),
    ['Opérateur', payout.method],
    ...(payout.amount_with_fees && payout.amount_with_fees !== payout.amount
      ? [['Débité frais compris', formatMRU(payout.amount_with_fees)] as [string, string]]
      : []),
    ['Référence', payout.ref],
    ...(payout.operator_reference ? [['Réf. opérateur', payout.operator_reference] as [string, string]] : []),
    ['Annoncé le', formatDate(payout.created_at)],
    [payout.status === 'paid' ? 'Confirmé le' : 'Expire le', formatDate(payout.status === 'paid' ? payout.paid_at : payout.expires_at)],
  ];

  return (
    <main className="min-h-screen bg-[var(--paper)] py-10 sm:py-16 px-4">
      <div className="mx-auto max-w-md">
        {payout.mode === 'test' && (
          <div className="mb-4 flex items-center gap-2 border border-[var(--bronze)]/40 bg-[var(--gold-soft)]/40 rounded-sm px-4 py-2.5">
            <p className="kp-eyebrow text-[var(--bronze)]">— Mode test · paiement simulé</p>
          </div>
        )}

        <div className="bg-white border border-[var(--stone-200)] rounded-sm p-7 sm:p-9 shadow-[0_1px_2px_rgba(0,0,0,0.02),0_24px_60px_-24px_rgba(58,52,42,0.18)]">
          <p className="kp-eyebrow text-[var(--stone-500)] mb-2">— Paiement sortant · {merchant?.name ?? 'Marchand'}</p>
          <div className="flex items-center justify-between gap-4">
            <p className="serif text-5xl font-medium text-[var(--ink)] leading-none tracking-tight">{formatMRU(payout.amount)}</p>
            {logo && <img src={logo} alt={payout.method} width={44} height={44} className="rounded-sm" />}
          </div>
          {payout.description && <p className="mt-3 text-[var(--stone-600)]">{payout.description}</p>}

          <div
            className="mt-6 inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm font-medium"
            style={{ color: status.color, borderColor: status.color }}
          >
            {payout.status === 'pending' && <span className="kp-pulse" aria-hidden="true" />}
            {status.label}
          </div>

          <div className="mt-6 border border-[var(--bronze)]/40 bg-[var(--gold-soft)]/30 rounded-sm px-5 py-4">
            <p className="kp-eyebrow text-[var(--bronze)] mb-2">
              — {merchantCode ? `Payer par code marchand ${payout.method}` : `Payer au numéro ${payout.method}`}
            </p>
            <p className="font-mono text-3xl font-semibold text-[var(--ink)] tracking-wider">
              {merchantCode ?? (payout.recipient_phone ? formatPhone(payout.recipient_phone) : '—')}
            </p>
            <p className="mt-1 text-sm text-[var(--stone-600)]">
              {formatMRU(payout.amount)}
              {payout.recipient_name ? ` à ${payout.recipient_name}` : ''}
              {merchantCode ? ' · sans frais de transfert' : ''}
            </p>
          </div>

          <dl className="mt-7 bg-[var(--paper-warm)] border border-[var(--stone-200)] rounded-sm divide-y divide-[var(--stone-200)]">
            {rows.map(([label, value]) => (
              <div key={label} className="flex items-center justify-between gap-4 px-4 py-3 text-sm">
                <dt className="text-[var(--stone-600)]">{label}</dt>
                <dd className="font-mono text-[var(--ink)] text-right">{value}</dd>
              </div>
            ))}
          </dl>

          {payout.status === 'pending' && payout.mode !== 'test' && (
            <p className="mt-5 text-sm text-[var(--stone-600)] leading-relaxed">
              Faites le transfert depuis le compte {payout.method}
              {merchantCode ? ` avec le code marchand ${merchantCode}` : ''} : le paiement sera
              confirmé automatiquement à la réception du SMS de débit.
            </p>
          )}

          <PayoutActions
            refValue={payout.ref}
            clientSecret={payout.client_secret}
            status={payout.status}
            canSimulate={payout.mode === 'test' && payout.status === 'pending'}
          />
        </div>

        <p className="mt-6 text-center kp-eyebrow text-[var(--stone-500)]">— Sécurisé par KitPay · Mauritanie</p>
      </div>
    </main>
  );
}
