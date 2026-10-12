import { NextRequest, NextResponse } from 'next/server';
import { createSupabaseAdminClient } from '@/lib/supabase/server';
import { authenticateApi, ensureKycForLive } from '@/lib/api/auth';
import { hashBody, lookupIdempotency, saveIdempotency } from '@/lib/api/idempotency';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { logApiCall } from '@/lib/api/audit';
import {
  PAYOUT_DEFAULT_EXPIRES_IN, generatePayoutRef, payoutHostedUrl, serializePayout, validatePayoutInput,
  type PayoutRecord,
} from '@/lib/api/payouts';
import { generateClientSecret } from '@/lib/api/intents';
import {
  errBadRequest, errUnauthorized, errForbidden, errConflict, errUnprocessable, errRateLimit, errInternal,
  type ApiErrorCode,
} from '@/lib/api/errors';

// POST /api/v1/payouts : annonce un paiement SORTANT que le marchand va
// faire depuis son compte operateur. Il passera a `paid` (webhook
// payout.succeeded) quand KitPay lira le SMS de debit correspondant.
export async function POST(request: NextRequest) {
  const endpoint = '/v1/payouts';
  const auth = await authenticateApi(request);
  if (!auth.ok) {
    logApiCall({ request, merchantId: null, apiKeyId: null, endpoint, method: 'POST', statusCode: 401 });
    return errUnauthorized();
  }
  const ctx = auth.ctx;

  const kyc = await ensureKycForLive(ctx);
  if (!kyc.ok) {
    logApiCall({ request, merchantId: ctx.merchantId, apiKeyId: ctx.apiKeyId, endpoint, method: 'POST', statusCode: 403 });
    return errForbidden('kyc_required', 'Live mode requires KYC validation. Use kp_test_ keys until your KYC is approved.');
  }

  const rl = await checkRateLimit(ctx.apiKeyId, ctx.merchantId, ctx.mode);
  if (!rl.ok) {
    logApiCall({ request, merchantId: ctx.merchantId, apiKeyId: ctx.apiKeyId, endpoint, method: 'POST', statusCode: rl.serviceError ? 503 : 429 });
    return rl.serviceError ? errInternal('rate_limit_unavailable') : errRateLimit(rl.resetIn);
  }

  const rawBody = await request.text();
  let body: Record<string, unknown> = {};
  try {
    body = rawBody.trim() ? JSON.parse(rawBody) : {};
  } catch {
    logApiCall({ request, merchantId: ctx.merchantId, apiKeyId: ctx.apiKeyId, endpoint, method: 'POST', statusCode: 400, body: rawBody });
    return errBadRequest('invalid_param', 'Body must be valid JSON');
  }

  const idemKey = request.headers.get('idempotency-key');
  if (idemKey) {
    const lookup = await lookupIdempotency(ctx.merchantId, idemKey, hashBody(rawBody));
    if (lookup.kind === 'conflict') {
      logApiCall({ request, merchantId: ctx.merchantId, apiKeyId: ctx.apiKeyId, endpoint, method: 'POST', statusCode: 409, body: rawBody });
      return errConflict('idempotency_conflict', 'Idempotency-Key was reused with a different body');
    }
    if (lookup.kind === 'hit') {
      logApiCall({ request, merchantId: ctx.merchantId, apiKeyId: ctx.apiKeyId, endpoint, method: 'POST', statusCode: lookup.payload.status });
      return NextResponse.json(lookup.payload.body, { status: lookup.payload.status });
    }
  }

  const valid = validatePayoutInput(body);
  if (!valid.ok) {
    logApiCall({ request, merchantId: ctx.merchantId, apiKeyId: ctx.apiKeyId, endpoint, method: 'POST', statusCode: 422, body: rawBody });
    return errUnprocessable(valid.code as ApiErrorCode, valid.message, valid.param);
  }
  const input = valid.input;

  const admin = createSupabaseAdminClient();
  const expiresAt = new Date(Date.now() + (input.expires_in ?? PAYOUT_DEFAULT_EXPIRES_IN) * 1000);
  const { data: inserted, error } = await admin
    .from('payout_intents')
    .insert({
      ref: generatePayoutRef(),
      merchant_id: ctx.merchantId,
      mode: ctx.mode,
      method: input.method,
      amount: input.amount,
      amount_with_fees: input.amount_with_fees ?? null,
      recipient_phone: input.recipient_phone,
      recipient_name: input.recipient_name ?? null,
      description: input.description ?? null,
      metadata: input.metadata ?? {},
      status: 'pending',
      idempotency_key: idemKey ?? null,
      expires_at: expiresAt.toISOString(),
      client_secret: generateClientSecret(),
    })
    .select('*')
    .single();

  if (error || !inserted) {
    console.error('[v1/payouts POST] insert failed', error);
    logApiCall({ request, merchantId: ctx.merchantId, apiKeyId: ctx.apiKeyId, endpoint, method: 'POST', statusCode: 500, body: rawBody });
    return errInternal();
  }

  const row = inserted as PayoutRecord;
  // hosted_url : page du paiement sortant (statut ; simulation en mode
  // test), a ouvrir depuis l'application du marchand.
  const responseBody = {
    ...serializePayout(row),
    hosted_url: payoutHostedUrl(new URL(request.url).origin, row),
  };
  if (idemKey) await saveIdempotency(ctx.merchantId, idemKey, hashBody(rawBody), 201, responseBody);
  logApiCall({ request, merchantId: ctx.merchantId, apiKeyId: ctx.apiKeyId, endpoint, method: 'POST', statusCode: 201, body: rawBody });
  return NextResponse.json(responseBody, { status: 201 });
}

// GET /api/v1/payouts?status=&method=&limit= : historique des paiements
// sortants du marchand (le plus recent en premier).
export async function GET(request: NextRequest) {
  const auth = await authenticateApi(request);
  if (!auth.ok) return errUnauthorized();
  const ctx = auth.ctx;

  const rl = await checkRateLimit(ctx.apiKeyId, ctx.merchantId, ctx.mode);
  if (!rl.ok) return rl.serviceError ? errInternal('rate_limit_unavailable') : errRateLimit(rl.resetIn);

  const sp = new URL(request.url).searchParams;
  const limit = Math.min(100, Math.max(1, parseInt(sp.get('limit') ?? '25', 10) || 25));
  const admin = createSupabaseAdminClient();
  let query = admin
    .from('payout_intents')
    .select('*')
    .eq('merchant_id', ctx.merchantId)
    .eq('mode', ctx.mode)
    .order('created_at', { ascending: false })
    .limit(limit);
  const status = sp.get('status');
  const method = sp.get('method');
  if (status) query = query.eq('status', status);
  if (method) query = query.eq('method', method);

  const { data, error } = await query;
  if (error) return errInternal();
  logApiCall({ request, merchantId: ctx.merchantId, apiKeyId: ctx.apiKeyId, endpoint: '/v1/payouts', method: 'GET', statusCode: 200 });
  return NextResponse.json({ data: (data ?? []).map((r) => serializePayout(r as PayoutRecord)) });
}
