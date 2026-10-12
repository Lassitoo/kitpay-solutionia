# Paiements sortants suivis (payouts)

KitPay suit aussi l'argent qui SORT du compte operateur du marchand
(paiement d'un fournisseur, d'un livreur, remboursement...), avec la meme
tracabilite que les paiements entrants : un SMS de debit lu sur le
telephone marchand confirme le transfert, avec la reference de
l'operateur, un webhook signe et une notification Telegram.

KitPay ne deplace toujours pas d'argent : le marchand fait le transfert
lui-meme depuis l'appli de l'operateur.

## Deroulement

1. Le marchand annonce le transfert : `POST /api/v1/payouts`.
2. Il fait le transfert depuis son compte operateur.
3. L'operateur envoie un SMS de debit sur le telephone marchand ; le
   forwarder (MacroDroid) le transmet a `/api/sms-ingest`, comme les SMS
   de credit.
4. `parseDebitSms()` (`src/lib/sms/debit.ts`) le lit, puis
   `match_payout()` (`supabase/v38_payout_intents.sql`) le rapproche du
   paiement annonce : statut `paid`, reference operateur, SMS conserve.
5. Webhook `payout.succeeded` au marchand et notification Telegram.

Un SMS de debit sans paiement annonce part en `orphan_sms`
(`direction = 'out'`) et sur Telegram. Un SMS d'operateur illisible
(ni credit ni debit) est desormais garde (`direction = 'unknown'`) et
envoye sur Telegram au lieu d'etre perdu.

## Rapprochement

| Tier | Condition                                                                 |
|------|---------------------------------------------------------------------------|
| 1    | operateur + numero du destinataire lu dans le SMS + montant (net ou frais compris) |
| 2    | SMS sans numero (paiement par code marchand) : operateur + montant, un seul candidat |
| -    | sinon : `orphan_sms` direction `out`                                      |

Un numero lu dans le SMS mais different n'est jamais rapproche au montant
seul : c'est un autre transfert.

## API

Authentification : `Authorization: Bearer kp_live_...` (ou `kp_test_...`).

### POST /api/v1/payouts

```json
{
  "amount": 9500,
  "amount_with_fees": 9595,
  "method": "Bankily",
  "recipient_phone": "36123456",
  "recipient_name": "Grossiste K",
  "description": "Paiement grossiste - vague 12",
  "metadata": { "souk_type": "payout_grossiste", "souk_id": 42 },
  "expires_in": 86400
}
```

- `amount` : montant recu par le destinataire (MRU, entier).
- `amount_with_fees` (optionnel) : montant debite frais compris ; le SMS
  peut afficher l'un ou l'autre.
- `method` : operateur du compte marchand debite (Bankily, Masrvi,
  Sedad, BIM, Click, BCIPAY).
- `recipient_phone` : numero mauritanien a 8 chiffres (+222 accepte), ou
  vide pour un paiement par code marchand.
- `expires_in` : 300 a 259200 s (defaut 86400 = 24 h).
- En-tete `Idempotency-Key` supporte.

Reponse `201` : l'objet `payout` (`ref` au format `KPO-XXXXXX`,
`status: "pending"`).

### GET /api/v1/payouts, GET /api/v1/payouts/{ref}

Liste (filtres `status`, `method`, `limit`) et lecture d'un paiement
sortant, avec `operator_reference` et `sms_received` une fois confirme.

### POST /api/v1/payouts/{ref}/cancel

Annule un paiement sortant encore `pending` (webhook `payout.cancelled`).

### POST /api/v1/test/simulate-payout

Cles `kp_test_` uniquement : `{ "ref": "KPO-...", "operator_reference": "..." }`
simule le SMS de debit et envoie `payout.succeeded`.

## Webhooks

Memes enveloppe et signature HMAC que `payment.*` (voir
[integration.md](./integration.md)) :

- `payout.succeeded` : SMS de debit rapproche.
- `payout.expired` : aucun SMS de debit avant `expires_at`
  (cron `/api/cron/expire-intents`).
- `payout.cancelled` : annule via l'API.

`data.object` contient : `ref`, `amount`, `amount_with_fees`, `method`,
`recipient_phone`, `recipient_name`, `description`, `metadata`, `status`,
`mode`, `matched_tier`, `operator_reference`, `actual_recipient_phone`,
`sms_received`, `created_at`, `expires_at`, `paid_at`, `cancelled_at`.

La migration v38 abonne automatiquement les webhooks existants a ces
evenements.

## Mise en service

1. Appliquer `supabase/v38_payout_intents.sql` sur Supabase.
2. Redeployer l'application.
3. Verifier que le forwarder Android transmet aussi les SMS de debit
   (memes expediteurs que les SMS de credit).
4. Apres le premier transfert reel par operateur, ajouter le SMS recu
   dans `tests/unit/debit-sms.test.ts` et dans
   [operators.md](./operators.md#sms-de-debit) : la lecture des debits
   repose pour l'instant sur des formulations usuelles.
