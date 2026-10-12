import { NextRequest, NextResponse } from 'next/server';
import { createSupabaseAdminClient } from '@/lib/supabase/server';
import { authenticateApi } from '@/lib/api/auth';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { logApiCall } from '@/lib/api/audit';
import { serializePayout, type PayoutRecord } from '@/lib/api/payouts';
import { errUnauthorized, errNotFound, errRateLimit, errInternal } from '@/lib/api/errors';

// GET /api/v1/payouts/{ref} : un paiement sortant (statut, reference
// operateur et SMS de debit lu une fois confirme).
export async function GET(request: NextRequest, { params }: { params: { ref: string } }) {
  const auth = await authenticateApi(request);
  if (!auth.ok) return errUnauthorized();
  const ctx = auth.ctx;

  const rl = await checkRateLimit(ctx.apiKeyId, ctx.merchantId, ctx.mode);
  if (!rl.ok) return rl.serviceError ? errInternal('rate_limit_unavailable') : errRateLimit(rl.resetIn);

  const admin = createSupabaseAdminClient();
  const { data, error } = await admin
    .from('payout_intents')
    .select('*')
    .eq('ref', params.ref)
    .eq('merchant_id', ctx.merchantId)
    .maybeSingle();

  const endpoint = `/v1/payouts/${params.ref}`;
  if (error) {
    logApiCall({ request, merchantId: ctx.merchantId, apiKeyId: ctx.apiKeyId, endpoint, method: 'GET', statusCode: 500 });
    return errInternal();
  }
  if (!data) {
    logApiCall({ request, merchantId: ctx.merchantId, apiKeyId: ctx.apiKeyId, endpoint, method: 'GET', statusCode: 404 });
    return errNotFound('Payout');
  }
  logApiCall({ request, merchantId: ctx.merchantId, apiKeyId: ctx.apiKeyId, endpoint, method: 'GET', statusCode: 200 });
  return NextResponse.json(serializePayout(data as PayoutRecord));
}
