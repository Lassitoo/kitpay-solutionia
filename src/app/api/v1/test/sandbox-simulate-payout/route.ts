import { NextRequest, NextResponse } from 'next/server';
import { createSupabaseAdminClient } from '@/lib/supabase/server';
import { serializePayout, type PayoutRecord } from '@/lib/api/payouts';
import { errBadRequest, errForbidden, errNotFound, errConflict, errInternal } from '@/lib/api/errors';
import { enqueuePayoutEvent } from '@/lib/payout-events';

// Bouton "Simuler le paiement" de la page /payout/{ref} (mode test) :
// meme principe que /api/v1/test/sandbox-simulate pour les paiements
// entrants. Autorise par le client_secret du paiement sortant, et
// uniquement pour un paiement sortant en mode test : le paiement passe a
// `paid` et le webhook payout.succeeded part vers le marchand.
export async function POST(request: NextRequest) {
  let body: { ref?: string; client_secret?: string } = {};
  try { body = await request.json(); } catch { return errBadRequest('invalid_param', 'Body must be JSON'); }

  if (!body.ref || !body.client_secret) {
    return errBadRequest('missing_param', '`ref` and `client_secret` are required');
  }

  const admin = createSupabaseAdminClient();
  const { data: payout } = await admin
    .from('payout_intents')
    .select('ref, status, mode, client_secret')
    .eq('ref', body.ref)
    .maybeSingle();

  if (!payout) return errNotFound('Payout');
  if (!payout.client_secret || payout.client_secret !== body.client_secret) {
    return errForbidden('invalid_param', 'Invalid client_secret');
  }
  if (payout.mode !== 'test') return errForbidden('test_mode_only', 'sandbox-simulate-payout works only in test mode');
  if (payout.status !== 'pending') return errConflict('payout_not_pending', `Payout is in status \`${payout.status}\``);

  const operatorRef = `SIM${Date.now().toString().slice(-6)}`;
  const { data: updated, error } = await admin
    .from('payout_intents')
    .update({
      status: 'paid',
      matched_tier: 1,
      operator_reference: operatorRef,
      sms_received: '[SIMULATED via sandbox-simulate-payout]',
      paid_at: new Date().toISOString(),
    })
    .eq('ref', body.ref)
    .eq('status', 'pending')
    .select('*')
    .maybeSingle();

  if (error) return errInternal();
  if (!updated) return errConflict('payout_not_pending', 'Payout is no longer pending');

  const row = updated as PayoutRecord;
  await enqueuePayoutEvent(admin, row.merchant_id, 'payout.succeeded', serializePayout(row), false);
  return NextResponse.json({ ok: true, ref: row.ref });
}
