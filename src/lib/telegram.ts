import "server-only";
import type { PaymentIntent, OrphanSms } from "@/lib/types";
import { formatMRU } from "@/lib/format";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const APP_URL = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";

// Échappe les caractères spéciaux pour Telegram MarkdownV2
function escapeMd(text: string): string {
  return text.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, "\\$1");
}

// Formate une durée écoulée en français
function timeAgo(isoDate: string): string {
  const seconds = Math.floor((Date.now() - new Date(isoDate).getTime()) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h${minutes % 60 > 0 ? ` ${minutes % 60}m` : ""}`;
  const days = Math.floor(hours / 24);
  return `${days}j`;
}

// Envoie un message Telegram avec gestion d'erreur silencieuse
export async function sendTelegramMessage(
  text: string,
  options: { parseMode?: "MarkdownV2" | "HTML"; disableLinkPreview?: boolean } = {}
): Promise<{ ok: boolean; error?: string }> {
  if (!BOT_TOKEN || !CHAT_ID) {
    console.warn("Telegram not configured (TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID missing)");
    return { ok: false, error: "telegram_not_configured" };
  }

  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: CHAT_ID,
        text,
        parse_mode: options.parseMode || "MarkdownV2",
        disable_web_page_preview: options.disableLinkPreview ?? true
      })
    });
    if (!res.ok) {
      const errorBody = await res.text();
      console.error("Telegram API error:", errorBody);
      return { ok: false, error: errorBody };
    }
    return { ok: true };
  } catch (e: any) {
    console.error("sendTelegramMessage error:", e);
    return { ok: false, error: e.message };
  }
}

// === Notifications spécifiques ===

export async function notifyPaymentConfirmed(intent: PaymentIntent) {
  // Garde de securite : ne jamais notifier pour un intent qui n'est pas en mode 'live'.
  // Les intents 'test' peuvent etre marques 'paid' via /api/v1/test/sandbox-simulate
  // ou /api/v1/test/simulate-payment sans qu'aucun paiement reel n'ait lieu ; les notifier
  // au canal Telegram de production donnerait de fausses confirmations.
  if (intent.mode !== "live") {
    console.info("[telegram] notifyPaymentConfirmed skipped (non-live mode)", {
      ref: intent.ref,
      mode: intent.mode,
    });
    return { ok: true };
  }

  const tierLabel: Record<number, string> = {
    1: "🟢 Tier 1 · Match parfait",
    2: "🟡 Tier 2 · Match probable",
    3: "🟠 Tier 3 · Validation manuelle"
  };

  const phoneNote =
    intent.actual_sender_phone &&
    intent.actual_sender_phone !== intent.expected_phone
      ? ` (déclaré : ${intent.expected_phone})`
      : "";

  const elapsed = intent.paid_at
    ? `Délai paiement : ${timeAgo(intent.created_at).replace(/^/, "")} après création`
    : "";

  const lines = [
    `*✅ Paiement confirmé · ${escapeMd(formatMRU(intent.amount))}*`,
    ``,
    `📦 *Article :* ${escapeMd(intent.product_name)}`,
    `💳 *Mode :* ${escapeMd(intent.method)}`,
    `📱 *Numéro payeur :* \`${escapeMd((intent.actual_sender_phone || intent.expected_phone) + phoneNote)}\``,
    `🔖 *Référence :* \`${escapeMd(intent.ref)}\``,
    `${escapeMd(intent.matched_tier ? tierLabel[intent.matched_tier] : "—")}`,
    intent.customer_email ? `📧 *Email client :* ${escapeMd(intent.customer_email)}` : "",
    elapsed ? `⏱ ${escapeMd(elapsed)}` : "",
    ``,
    `[Voir admin](${APP_URL}/admin)`
  ].filter(Boolean);

  return sendTelegramMessage(lines.join("\n"));
}

export async function notifyOrphanSms(orphan: OrphanSms) {
  const lines = [
    `*🟠 SMS orphelin · action requise*`,
    ``,
    `💰 *Montant :* ${escapeMd(orphan.parsed_amount ? formatMRU(orphan.parsed_amount) : "?")}`,
    `📱 *De :* \`${escapeMd(orphan.parsed_phone || "?")}\``,
    `💳 *Mode :* ${escapeMd(orphan.parsed_method || "?")}`,
    `⏱ *Reçu il y a :* ${escapeMd(timeAgo(orphan.received_at))}`,
    ``,
    `_${escapeMd(orphan.raw_body.substring(0, 200))}_`,
    ``,
    `Aucun match auto trouvé\\. À réconcilier manuellement\\.`,
    ``,
    `[Aller à l'admin](${APP_URL}/admin)`
  ];

  return sendTelegramMessage(lines.join("\n"));
}

export async function notifyIntentExpired(intent: PaymentIntent) {
  const lines = [
    `*⚪ Intention expirée · paiement non reçu*`,
    ``,
    `📦 *Article :* ${escapeMd(intent.product_name)}`,
    `💰 *Montant attendu :* ${escapeMd(formatMRU(intent.amount))}`,
    `💳 *Mode :* ${escapeMd(intent.method)}`,
    `📱 *Numéro :* \`${escapeMd(intent.expected_phone)}\``,
    intent.customer_email ? `📧 ${escapeMd(intent.customer_email)}` : "",
    `🔖 \`${escapeMd(intent.ref)}\``,
    `⏱ ${escapeMd(timeAgo(intent.created_at))} après création`,
    ``,
    `Le client n'a pas envoyé le SMS dans les 15 min\\.`
  ].filter(Boolean);

  return sendTelegramMessage(lines.join("\n"));
}

export async function notifyManualReconciliation(intent: PaymentIntent, orphanId: string) {
  const lines = [
    `*🛠 Réconciliation manuelle effectuée*`,
    ``,
    `🔖 *Référence :* \`${escapeMd(intent.ref)}\``,
    `💰 *Montant :* ${escapeMd(formatMRU(intent.amount))}`,
    `📦 *Article :* ${escapeMd(intent.product_name)}`,
    `📱 *Payeur réel :* \`${escapeMd(intent.actual_sender_phone || "?")}\``,
    `💳 *Mode :* ${escapeMd(intent.method)}`,
    ``,
    `Un admin a associé manuellement le SMS orphelin à cette commande\\.`
  ];

  return sendTelegramMessage(lines.join("\n"));
}

// === Paiements sortants (payout_intents, voir supabase/v38) ===

type PayoutForTelegram = {
  ref: string;
  mode: string;
  method: string;
  amount: number;
  recipient_phone: string;
  recipient_name: string | null;
  description: string | null;
  matched_tier: number | null;
  operator_reference: string | null;
  sms_received: string | null;
  created_at: string;
};

export async function notifyPayoutConfirmed(payout: PayoutForTelegram) {
  // Meme garde que notifyPaymentConfirmed : jamais de notification test.
  if (payout.mode !== "live") return { ok: true };
  const lines: Array<string | null> = [
    `*📤 Paiement sortant confirmé · ${escapeMd(formatMRU(payout.amount))}*`,
    ``,
    payout.recipient_name ? `👤 *Bénéficiaire :* ${escapeMd(payout.recipient_name)}` : null,
    `📱 *Numéro :* \`${escapeMd(payout.recipient_phone || "par code marchand")}\``,
    `💳 *Mode :* ${escapeMd(payout.method)}`,
    payout.operator_reference ? `🧾 *Réf\\. opérateur :* \`${escapeMd(payout.operator_reference)}\`` : null,
    `🔖 *Référence :* \`${escapeMd(payout.ref)}\``,
    payout.description ? `📝 ${escapeMd(payout.description)}` : null,
    `⏱ ${escapeMd(`${timeAgo(payout.created_at)} après l'annonce`)}`,
    payout.sms_received ? `` : null,
    payout.sms_received ? `_${escapeMd(payout.sms_received.substring(0, 300))}_` : null,
  ];
  return sendTelegramMessage(lines.filter((l): l is string => l !== null).join("\n"));
}

// SMS de debit lu mais rapproche d'aucun paiement sortant annonce.
export async function notifyUnmatchedDebitSms(args: {
  method: string; amount: number; recipientPhone: string; raw: string; reason: string;
}) {
  const lines = [
    `*🟠 SMS de débit sans paiement annoncé*`,
    ``,
    `💰 *Montant :* ${escapeMd(formatMRU(args.amount))}`,
    `📱 *Vers :* \`${escapeMd(args.recipientPhone || "?")}\``,
    `💳 *Mode :* ${escapeMd(args.method)}`,
    `❔ ${escapeMd(args.reason === "ambiguous" ? "Plusieurs paiements possibles" : "Aucun paiement sortant en attente")}`,
    ``,
    `_${escapeMd(args.raw.substring(0, 300))}_`,
  ];
  return sendTelegramMessage(lines.join("\n"));
}

// SMS recu que KitPay ne sait pas lire (ni credit ni debit) : garde dans
// orphan_sms et envoye ici pour apprendre son format.
export async function notifyUnreadableSms(from: string, raw: string) {
  const lines = [
    `*⚪ SMS non reconnu par KitPay*`,
    ``,
    `📨 *Expéditeur :* ${escapeMd(from || "?")}`,
    ``,
    `_${escapeMd(raw.substring(0, 400))}_`,
  ];
  return sendTelegramMessage(lines.join("\n"));
}
