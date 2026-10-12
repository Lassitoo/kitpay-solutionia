import { randomBytes } from 'crypto';
import { VALID_METHODS, type Method } from '@/lib/api/intents';

// Paiements sortants suivis : le marchand annonce un transfert qu'il va
// faire depuis son compte operateur, KitPay le confirme a la lecture du
// SMS de debit (voir supabase/v38_payout_intents.sql et src/lib/sms/debit.ts).

const REF_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function generatePayoutRef(): string {
  const bytes = randomBytes(6);
  let chars = '';
  for (let i = 0; i < 6; i++) chars += REF_ALPHABET[bytes[i] % REF_ALPHABET.length];
  return `KPO-${chars}`;
}

// Un transfert se fait quand le marchand a le temps : 24 h par defaut,
// jusqu'a 3 jours.
export const PAYOUT_DEFAULT_EXPIRES_IN = 24 * 3600;
const PAYOUT_MIN_EXPIRES_IN = 300;
const PAYOUT_MAX_EXPIRES_IN = 3 * 24 * 3600;

export type PayoutInput = {
  amount: number;
  amount_with_fees?: number;
  method: Method;
  recipient_phone: string;
  recipient_name?: string;
  description?: string;
  metadata?: Record<string, unknown>;
  expires_in?: number;
};

export type PayoutRecord = {
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
  matched_tier: number | null;
  operator_reference: string | null;
  actual_recipient_phone: string | null;
  sms_received: string | null;
  created_at: string;
  expires_at: string;
  paid_at: string | null;
  cancelled_at: string | null;
};

// Les 8 chiffres d'un numero mauritanien, sans +222 / 00222 ni espaces.
export function normalizeMauritanianPhone(raw: string): string | null {
  let digits = (raw || '').replace(/\D/g, '');
  if (digits.length > 8 && digits.startsWith('00222')) digits = digits.slice(5);
  else if (digits.length > 8 && digits.startsWith('222')) digits = digits.slice(3);
  return /^[234]\d{7}$/.test(digits) ? digits : null;
}

export function serializePayout(row: PayoutRecord) {
  return {
    object: 'payout',
    ref: row.ref,
    amount: row.amount,
    amount_with_fees: row.amount_with_fees,
    method: row.method,
    recipient_phone: row.recipient_phone,
    recipient_name: row.recipient_name,
    description: row.description,
    metadata: row.metadata ?? {},
    status: row.status,
    mode: row.mode,
    matched_tier: row.matched_tier,
    operator_reference: row.operator_reference,
    actual_recipient_phone: row.actual_recipient_phone,
    sms_received: row.sms_received,
    created_at: row.created_at,
    expires_at: row.expires_at,
    paid_at: row.paid_at,
    cancelled_at: row.cancelled_at,
  };
}

type ValidationResult =
  | { ok: true; input: PayoutInput }
  | { ok: false; code: string; message: string; param?: string };

export function validatePayoutInput(body: Record<string, unknown>): ValidationResult {
  const amount = body.amount;
  if (typeof amount !== 'number' || !Number.isInteger(amount)) {
    return { ok: false, code: 'missing_param', message: '`amount` is required (positive integer in MRU)', param: 'amount' };
  }
  if (amount < 1) return { ok: false, code: 'amount_too_low', message: 'Amount must be >= 1 MRU', param: 'amount' };
  if (amount > 10_000_000) {
    return { ok: false, code: 'amount_too_high', message: 'Amount must be <= 10,000,000 MRU', param: 'amount' };
  }
  const withFees = body.amount_with_fees;
  if (withFees !== undefined && withFees !== null) {
    if (typeof withFees !== 'number' || !Number.isInteger(withFees) || withFees < amount) {
      return {
        ok: false, code: 'invalid_param',
        message: '`amount_with_fees` must be an integer >= `amount`', param: 'amount_with_fees',
      };
    }
  }
  const method = body.method;
  if (typeof method !== 'string' || !VALID_METHODS.includes(method as Method)) {
    return { ok: false, code: 'unknown_method', message: `\`method\` must be one of: ${VALID_METHODS.join(', ')}`, param: 'method' };
  }
  // Un numero vide est permis : paiement par code marchand (le SMS de
  // debit ne contient alors pas de numero, rapprochement au montant).
  const rawPhone = typeof body.recipient_phone === 'string' ? body.recipient_phone : '';
  const phone = rawPhone.trim() === '' ? '' : normalizeMauritanianPhone(rawPhone);
  if (phone === null) {
    return { ok: false, code: 'invalid_phone', message: '`recipient_phone` must be a Mauritanian number (8 digits)', param: 'recipient_phone' };
  }
  const expiresIn = body.expires_in;
  if (expiresIn !== undefined && (typeof expiresIn !== 'number' || expiresIn < PAYOUT_MIN_EXPIRES_IN || expiresIn > PAYOUT_MAX_EXPIRES_IN)) {
    return {
      ok: false, code: 'invalid_param',
      message: `\`expires_in\` must be between ${PAYOUT_MIN_EXPIRES_IN} and ${PAYOUT_MAX_EXPIRES_IN} seconds`, param: 'expires_in',
    };
  }
  const metadata = body.metadata;
  if (metadata !== undefined && (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata))) {
    return { ok: false, code: 'invalid_param', message: '`metadata` must be an object', param: 'metadata' };
  }
  return {
    ok: true,
    input: {
      amount,
      amount_with_fees: typeof withFees === 'number' ? withFees : undefined,
      method: method as Method,
      recipient_phone: phone,
      recipient_name: typeof body.recipient_name === 'string' ? body.recipient_name.slice(0, 120) : undefined,
      description: typeof body.description === 'string' ? body.description.slice(0, 300) : undefined,
      metadata: metadata as Record<string, unknown> | undefined,
      expires_in: typeof expiresIn === 'number' ? expiresIn : undefined,
    },
  };
}
