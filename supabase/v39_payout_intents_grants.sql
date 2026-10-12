-- =====================================================================
-- KitPay v39 - Droits sur payout_intents
--
-- v38 cree la table payout_intents mais, sur les projets Supabase ou les
-- privileges par defaut ne sont pas accordes aux roles API, service_role
-- recoit "permission denied for table payout_intents" (code 42501) :
-- l'API /api/v1/payouts ne peut alors ni creer ni lire de paiement
-- sortant. On accorde explicitement les droits (RLS reste active : les
-- membres ne lisent que les paiements de leur marchand, voir v38).
-- Idempotent.
-- =====================================================================

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.payout_intents TO service_role;
GRANT SELECT ON TABLE public.payout_intents TO authenticated;
REVOKE ALL ON TABLE public.payout_intents FROM anon;

NOTIFY pgrst, 'reload schema';

SELECT 'v39_payout_intents_grants applied' AS info;
