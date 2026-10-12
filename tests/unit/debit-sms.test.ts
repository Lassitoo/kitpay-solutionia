import { describe, expect, it } from 'vitest';
import {
  extractAmount,
  extractOperatorRef,
  extractRecipientPhone,
  isDebitSms,
  parseDebitSms,
} from '@/lib/sms/debit';

// SMS de CREDIT documentes dans docs/operators.md : ils ne doivent JAMAIS
// etre lus comme des debits (sinon un paiement recu confirmerait un
// paiement sortant).
const CREDITS: Array<[string, string]> = [
  ['Click', 'Transfert reçu : 5  de +22236123456 (BANKILY)\n#REF8899'],
  ['BMCI', 'Client +222 36 12 34 56 (REF123456) a payé 50.00 MRU pour la facture #.'],
  ['Sedad', 'vous avez reçu 10.0 MRU de 36123456'],
  ['BIM', 'Vous avez reçu 40 MRU du 36123456'],
  ['Click', 'Client +222 36 12 34 56 a payé 5.00 MRU\nNouveau solde 120 MRU'],
  ['Click', 'Client *0015 a payé 5.00 MRU. (REFXXXXXXX).'],
  ['BCIPAY', 'Vous avez reçu 5.0 MRU du 36123456'],
];

describe('SMS de credit : jamais lus comme debit', () => {
  for (const [from, sms] of CREDITS) {
    it(`${from} : ${sms.slice(0, 30)}`, () => {
      expect(isDebitSms(sms)).toBe(false);
      expect(parseDebitSms(from, sms)).toBeNull();
    });
  }
});

describe('SMS de debit (formes usuelles, a completer avec des SMS reels)', () => {
  it('Bankily : envoi au numero, avec frais et solde', () => {
    const r = parseDebitSms(
      'Bankily',
      'Vous avez envoyé 9 500 MRU au +222 36 12 34 56. Frais : 95 MRU. Nouveau solde : 120 400 MRU. Ref : BK778899'
    );
    expect(r).toEqual({ method: 'Bankily', amount: 9500, recipientPhone: '36123456', operatorRef: 'BK778899' });
  });

  it('Masrvi (BMCI) : transfert effectue vers un numero', () => {
    const r = parseDebitSms('BMCI', 'Transfert effectué de 1200.00 MRU vers 44556677. Transaction N° TX4455.');
    expect(r).toEqual({ method: 'Masrvi', amount: 1200, recipientPhone: '44556677', operatorRef: 'TX4455' });
  });

  it('paiement par code marchand : pas de numero, montant quand meme lu', () => {
    const r = parseDebitSms('Sedad', 'Vous avez payé 3000 MRU au marchand 12345. ID: SD99887');
    expect(r?.method).toBe('Sedad');
    expect(r?.amount).toBe(3000);
    expect(r?.recipientPhone).toBe('');
  });

  it('montant ecrit avant MRU ou apres', () => {
    expect(extractAmount('Debit de MRU 2 500 vers 36123456')).toBe(2500);
    expect(extractAmount('Vous avez transféré 2500,00 MRU')).toBe(2500);
  });

  it('un montant suivi de MRU n est pas pris pour un numero', () => {
    expect(extractRecipientPhone('Vous avez envoyé 22334455 MRU au 36123456')).toBe('36123456');
  });

  it('reference operateur', () => {
    expect(extractOperatorRef('Envoi a 36123456 reussi #AB12CD')).toBe('AB12CD');
    expect(extractOperatorRef('Vous avez envoyé 10 MRU')).toBeNull();
  });

  it('operateur inconnu : ignore', () => {
    expect(parseDebitSms('Inconnu', 'Vous avez envoyé 10 MRU au 36123456')).toBeNull();
  });
});
