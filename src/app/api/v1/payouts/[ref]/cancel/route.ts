import { NextRequest, NextResponse } from 'next/server';
import { createSupabaseAdminClient } from '@/lib/supabase/server';
import { authenticateApi } from '@/lib/api/auth';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { logApiCall } from '@/lib/api/audit';
import { serializePayout, type PayoutRecord } from '@/lib/api/payouts';
import { errUnauthorized, errNotFound, errConflict, errRateLimit, errInternal } from '@/lib/api/errors';
import { enqueuePayoutEvent } from '@/lib/payout-events';

// POST /api/v1/payouts/{ref}/cancel : le marchand renonce a ce transfert
// (ou le relance autrement). Webhook payout.cancelled.
export async function POST(request: NextRequest, { params }: { params: { ref: string } }) {
  const auth = await authenticateApi(request);
  if (!auth.ok) return errUnauthorized();
  const ctx = auth.ctx;

  const rl = await checkRateLimit(ctx.apiKeyId, ctx.merchantId, ctx.mode);
  if (!rl.ok) return rl.serviceError ? errInternal('rate_limit_unavailable') : errRateLimit(rl.resetIn);

  const endpoint = `/v1/payouts/${params.ref}/cancel`;
  const admin = createSupabaseAdminClient();
  // Mise a jour conditionnelle : un SMS de debit lu au meme moment
  // (match_payout) ne peut pas etre ecrase par l'annulation.
  const { data: updated, error } = await admin
    .from('payout_intents')
    .update({ status: 'cancelled', cancelled_at: new Date().toISOString() })
    .eq('ref', params.ref)
    .eq('merchant_id', ctx.merchantId)
    .eq('status', 'pending')
    .select('*')
    .maybeSingle();

  if (error) {
    logApiCall({ request, merchantId: ctx.merchantId, apiKeyId: ctx.apiKeyId, endpoint, method: 'POST', statusCode: 500 });
    return errInternal();
  }
  if (!updated) {
    const { data: existing } = await admin
      .from('payout_intents')
      .select('status')
      .eq('ref', params.ref)
      .eq('merchant_id', ctx.merchantId)
      .maybeSingle();
    if (!existing) {
      logApiCall({ request, merchantId: ctx.merchantId, apiKeyId: ctx.apiKeyId, endpoint, method: 'POST', statusCode: 404 });
      return errNotFound('Payout');
    }
    logApiCall({ request, merchantId: ctx.merchantId, apiKeyId: ctx.apiKeyId, endpoint, method: 'POST', statusCode: 409 });
    return errConflict('payout_not_pending', `Payout is in status \`${existing.status}\` and cannot be cancelled.`);
  }

  const body = serializePayout(updated as PayoutRecord);
  await enqueuePayoutEvent(admin, ctx.merchantId, 'payout.cancelled', body, ctx.mode === 'live');
  logApiCall({ request, merchantId: ctx.merchantId, apiKeyId: ctx.apiKeyId, endpoint, method: 'POST', statusCode: 200 });
  return NextResponse.json(body);
}
