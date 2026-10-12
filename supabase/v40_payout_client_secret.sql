-- =====================================================================
-- KitPay v40 - Page publique d'un paiement sortant
--
-- Comme pour les paiements entrants (/pay/{ref} + client_secret), chaque
-- paiement sortant a desormais une page (/payout/{ref}?cs=...) que le
-- marchand ouvre depuis son application : statut en direct et, en mode
-- test, bouton "Simuler le paiement" (/api/v1/test/sandbox-simulate-payout).
-- La page n'est accessible qu'avec le client_secret du paiement.
-- Idempotent.
-- =====================================================================

ALTER TABLE public.payout_intents ADD COLUMN IF NOT EXISTS client_secret text;

UPDATE public.payout_intents
SET client_secret = 'kpcs_' || encode(gen_random_bytes(16), 'hex')
WHERE client_secret IS NULL;

NOTIFY pgrst, 'reload schema';

SELECT 'v40_payout_client_secret applied' AS info;
