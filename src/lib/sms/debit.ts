// Lecture des SMS de DEBIT (paiements sortants du marchand).
//
// Les SMS de credit (paiements recus) sont lus par parseSms() dans
// src/app/api/sms-ingest/route.ts. Ce module lit l'inverse : le SMS que
// l'operateur envoie au telephone du marchand quand LE MARCHAND envoie de
// l'argent (paiement d'un fournisseur, d'un livreur, remboursement...).
// Il sert a rapprocher ce SMS d'un paiement sortant attendu (table
// payout_intents, voir supabase/v38_payout_intents.sql).
//
// Les formats exacts des SMS de debit ne sont pas encore documentes
// (docs/operators.md, section "SMS de debit"). La lecture est donc prudente :
//  - un SMS n'est un debit que s'il contient une formulation d'envoi
//    (DEBIT_PATTERNS) et AUCUNE formulation de reception (CREDIT_PATTERNS) ;
//  - le montant est le premier montant suivi (ou precede) de MRU/UM ;
//  - le destinataire est le premier numero mauritanien a 8 chiffres
//    (commencant par 2, 3 ou 4), avec ou sans +222 ;
//  - un SMS de debit non rapproche n'est jamais perdu : il part en
//    orphan_sms (direction 'out') et sur Telegram.
// Des que des SMS reels sont disponibles, ajouter un exemple par operateur
// dans tests/unit/debit-sms.test.ts et ajuster les motifs ci-dessous.

export type DebitParseResult = {
  method: string;
  amount: number;
  recipientPhone: string;
  operatorRef: string | null;
};

export function normalizeSms(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[\n\r]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Formulations d'envoi (texte normalise, sans accents, en minuscules).
const DEBIT_PATTERNS: RegExp[] = [
  /\bvous avez (envoye|transfere|paye|effectue|retire|debite)\b/,
  /\btransfert (envoye|effectue|emis|reussi)\b/,
  /\btransfert de [\d\s.,]+ ?(mru|um)\b.{0,40}\b(a|au|vers)\b/,
  /\b(a|ont) ete (debite|debites|envoye|envoyes|transfere|transferes)\b/,
  /\b(envoye|transfere|envoi|paiement) (a|au|vers)\b/,
  /\bdebit\b/,
  /\bpaiement effectue\b/,
];

// Formulations de reception : si l'une d'elles est presente, ce n'est pas
// un SMS de debit (voir parseSms pour les credits).
const CREDIT_PATTERNS: RegExp[] = [
  /\brecu\b/,
  /\bclient .{0,40}\ba paye\b/,
  /\bpour la facture\b/,
  /\bvous avez ete credite\b/,
];

export function isDebitSms(raw: string): boolean {
  const sms = normalizeSms(raw).toLowerCase();
  if (CREDIT_PATTERNS.some((p) => p.test(sms))) return false;
  return DEBIT_PATTERNS.some((p) => p.test(sms));
}

// Meme reconnaissance de l'operateur que parseSms (expediteur + corps).
export function detectMethod(from: string, raw: string): string | null {
  const sms = normalizeSms(raw);
  const f = (from || "").toLowerCase();
  if (f.includes("bankily") || /\(bankily\)/i.test(sms)) return "Bankily";
  if (f.includes("bmci") || f.includes("masrvi")) return "Masrvi";
  if (f.includes("sedad")) return "Sedad";
  if (f.includes("bci") || f.includes("bcipay")) return "BCIPAY";
  if (f.includes("bim")) return "BIM";
  if (f.includes("click")) return "Click";
  return null;
}

function toInt(amount: string): number {
  const cleaned = amount.replace(/[\s ]/g, "").replace(",", ".");
  return Math.round(parseFloat(cleaned));
}

export function extractAmount(raw: string): number | null {
  const sms = normalizeSms(raw);
  const number = "(\\d{1,3}(?:[\\s\\u00a0]\\d{3})+(?:[.,]\\d+)?|\\d+(?:[.,]\\d+)?)";
  const after = sms.match(new RegExp(number + "\\s*(?:MRU|UM|MRO)\\b", "i"));
  const before = sms.match(new RegExp("\\b(?:MRU|UM|MRO)\\s*:?\\s*" + number, "i"));
  // Le premier montant du SMS (les frais et le solde viennent apres).
  const candidates = [after, before]
    .filter((m): m is RegExpMatchArray => m !== null && m.index !== undefined)
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  if (candidates.length === 0) return null;
  const value = toInt(candidates[0][1]);
  return Number.isFinite(value) && value > 0 ? value : null;
}

// Numero mauritanien a 8 chiffres (2x, 3x, 4x), avec ou sans +222/00222,
// eventuellement ecrit par groupes de 2 chiffres.
export function extractRecipientPhone(raw: string): string | null {
  const sms = normalizeSms(raw);
  const re = /(?<![\d*])(?:(?:\+|00)?222[\s.-]?)?([234]\d)[\s.-]?(\d{2})[\s.-]?(\d{2})[\s.-]?(\d{2})(?!\d)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sms)) !== null) {
    // Un montant suivi de MRU n'est pas un numero.
    const following = sms.slice(re.lastIndex, re.lastIndex + 6).toLowerCase();
    if (/^\s*(mru|um|mro)\b/.test(following)) continue;
    return m[1] + m[2] + m[3] + m[4];
  }
  return null;
}

export function extractOperatorRef(raw: string): string | null {
  const sms = normalizeSms(raw);
  const labelled = sms.match(/\b(?:ref(?:erence)?|transaction|txn|trx|id)\s*(?:n[o°]?\.?)?\s*[:#.]?\s*([A-Z0-9][A-Z0-9-]{3,})/i);
  if (labelled) return labelled[1];
  const hashed = sms.match(/#\s*([A-Z0-9][A-Z0-9-]{3,})/i);
  return hashed ? hashed[1] : null;
}

export function parseDebitSms(from: string, raw: string): DebitParseResult | null {
  if (!isDebitSms(raw)) return null;
  const method = detectMethod(from, raw);
  if (!method) return null;
  const amount = extractAmount(raw);
  if (amount === null) return null;
  return {
    method,
    amount,
    recipientPhone: extractRecipientPhone(raw) ?? "",
    operatorRef: extractOperatorRef(raw),
  };
}
