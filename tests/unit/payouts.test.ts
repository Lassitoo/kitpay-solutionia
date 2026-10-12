import { describe, expect, it } from 'vitest';
import { generatePayoutRef, normalizeMauritanianPhone, validatePayoutInput } from '@/lib/api/payouts';

describe('payouts : validation', () => {
  it('accepte un paiement sortant complet et normalise le numero', () => {
    const r = validatePayoutInput({
      amount: 9500, amount_with_fees: 9595, method: 'Bankily', recipient_phone: '+222 36 12 34 56',
      recipient_name: 'Grossiste K', metadata: { souk_id: 1 },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.input.recipient_phone).toBe('36123456');
      expect(r.input.amount_with_fees).toBe(9595);
    }
  });

  it('accepte un paiement par code marchand (sans numero)', () => {
    const r = validatePayoutInput({ amount: 3000, method: 'Sedad', recipient_phone: '' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.input.recipient_phone).toBe('');
  });

  it('refuse un numero non mauritanien', () => {
    const r = validatePayoutInput({ amount: 10, method: 'Bankily', recipient_phone: '12345678' });
    expect(r).toMatchObject({ ok: false, code: 'invalid_phone' });
  });

  it('refuse des frais inferieurs au montant', () => {
    const r = validatePayoutInput({ amount: 100, amount_with_fees: 90, method: 'Bankily', recipient_phone: '36123456' });
    expect(r).toMatchObject({ ok: false, param: 'amount_with_fees' });
  });

  it('refuse un operateur inconnu', () => {
    const r = validatePayoutInput({ amount: 100, method: 'Wave', recipient_phone: '36123456' });
    expect(r).toMatchObject({ ok: false, code: 'unknown_method' });
  });

  it('numeros', () => {
    expect(normalizeMauritanianPhone('0022244112233')).toBe('44112233');
    expect(normalizeMauritanianPhone('22236123456')).toBe('36123456');
    expect(normalizeMauritanianPhone('5612')).toBeNull();
  });

  it('reference KPO-', () => {
    expect(generatePayoutRef()).toMatch(/^KPO-[A-Z2-9]{6}$/);
  });
});
