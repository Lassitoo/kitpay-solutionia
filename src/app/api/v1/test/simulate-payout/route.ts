import { NextRequest, NextResponse } from 'next/server';
import { createSupabaseAdminClient } from '@/lib/supabase/server';
import { authenticateApi } from '@/lib/api/auth';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { logApiCall } from '@/lib/api/audit';
import { serializePayout, type PayoutRecord } from '@/lib/api/payouts';
import {
  errUnauthorized, errBadRequest, errForbidden, errNotFound, errConflict, errRateLimit, errInternal,
} from '@/lib/api/errors';
import { enqueuePayoutEvent } from '@/lib/payout-events';

// POST /api/v1/test/simulate-payout { ref, operator_reference? } :
// cles kp_test_ uniquement. Simule la lecture du SMS de debit d'un
// paiement sortant de test et envoie le webhook payout.succeeded, pour
// tester l'integration sans envoyer d'argent.
export async function POST(request: NextRequest) {
  const endpoint = '/v1/test/simulate-payout';
  const auth = await authenticateApi(request);
  if (!auth.ok) return errUnauthorized();
  const ctx = auth.ctx;
  if (ctx.mode !== 'test') {
    logApiCall({ request, merchantId: ctx.merchantId, apiKeyId: ctx.apiKeyId, endpoint, method: 'POST', statusCode: 403 });
    return errForbidden('test_mode_only', 'simulate-payout is only available with kp_test_ keys');
  }
  const rl = await checkRateLimit(ctx.apiKeyId, ctx.merchantId, ctx.mode);
  if (!rl.ok) return rl.serviceError ? errInternal('rate_limit_unavailable') : errRateLimit(rl.resetIn);

  let body: { ref?: string; operator_reference?: string } = {};
  try {
    body = await request.json();
  } catch {
    return errBadRequest('invalid_param', 'Body must be valid JSON');
  }
  if (!body.ref) return errBadRequest('missing_param', '`ref` is required', 'ref');

  const admin = createSupabaseAdminClient();
  const operatorRef = (body.operator_reference ?? `SIM${Date.now().toString().slice(-6)}`).slice(0, 40);
  const { data: updated, error } = await admin
    .from('payout_intents')
    .update({
      status: 'paid',
      matched_tier: 1,
      operator_reference: operatorRef,
      sms_received: `[SIMULATED] debit ref=${operatorRef}`,
      paid_at: new Date().toISOString(),
    })
    .eq('ref', body.ref)
    .eq('merchant_id', ctx.merchantId)
    .eq('mode', 'test')
    .eq('status', 'pending')
    .select('*')
    .maybeSingle();

  if (error) return errInternal();
  if (!updated) {
    const { data: existing } = await admin
      .from('payout_intents').select('status')
      .eq('ref', body.ref).eq('merchant_id', ctx.merchantId).eq('mode', 'test').maybeSingle();
    if (!existing) return errNotFound('Test-mode payout');
    return errConflict('payout_not_pending', `Payout is in status \`${existing.status}\` and cannot be simulated.`);
  }

  const responseBody = serializePayout(updated as PayoutRecord);
  await enqueuePayoutEvent(admin, ctx.merchantId, 'payout.succeeded', responseBody, false);
  logApiCall({ request, merchantId: ctx.merchantId, apiKeyId: ctx.apiKeyId, endpoint, method: 'POST', statusCode: 200 });
  return NextResponse.json(responseBody);
}
