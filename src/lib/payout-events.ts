import * as crypto from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

// Met en file un webhook payout.* (meme enveloppe que payment.* : id,
// type, created, livemode, data.object). La livraison HTTP signee est
// faite par /api/cron/deliver-webhooks, comme pour les paiements entrants.
export async function enqueuePayoutEvent(
  admin: SupabaseClient,
  merchantId: string,
  type: 'payout.succeeded' | 'payout.expired' | 'payout.cancelled',
  object: Record<string, unknown>,
  livemode: boolean,
) {
  const { error } = await admin.rpc('enqueue_webhook_delivery', {
    p_merchant_id: merchantId,
    p_event_type: type,
    p_payload: {
      id: `evt_${crypto.randomBytes(12).toString('hex')}`,
      type,
      created: Math.floor(Date.now() / 1000),
      livemode,
      data: { object },
    },
  });
  if (error) console.error('[payout-events] enqueue failed', type, error);
}
