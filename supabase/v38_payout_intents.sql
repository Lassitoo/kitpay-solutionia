-- =====================================================================
-- KitPay v38 - Paiements sortants suivis (payout_intents)
--
-- Le marchand annonce un transfert qu'il va faire depuis son compte
-- operateur (POST /api/v1/payouts : montant, numero du destinataire,
-- operateur). Quand l'operateur envoie le SMS de DEBIT sur le telephone
-- marchand, /api/sms-ingest le lit (src/lib/sms/debit.ts) et appelle
-- match_payout() : le paiement sortant passe a 'paid' avec la reference
-- de l'operateur et un webhook payout.succeeded est envoye au marchand.
-- Meme tracabilite que les paiements entrants (payment_intents).
--
-- Regles de rapprochement :
--   Tier 1 : operateur + montant (net OU frais compris) + numero du
--            destinataire lu dans le SMS.
--   Tier 2 : uniquement si le SMS ne contient aucun numero (paiement par
--            code marchand) : operateur + montant, s'il n'y a qu'un seul
--            candidat (meme garde anti-collision que v34).
--   Sinon  : orphan_sms (direction 'out') pour un rapprochement manuel.
--            Un numero lu mais different n'est jamais rapproche au montant
--            seul : c'est un autre transfert.
--
-- Securite : comme v37, les fonctions SECURITY DEFINER ne sont executables
-- que par service_role (jamais par anon / authenticated).
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 1. Table
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.payout_intents (
  ref                text PRIMARY KEY,
  merchant_id        uuid NOT NULL REFERENCES public.merchants(id) ON DELETE CASCADE,
  mode               text NOT NULL DEFAULT 'live' CHECK (mode IN ('test', 'live')),
  method             text NOT NULL CHECK (method IN ('Bankily', 'Masrvi', 'Sedad', 'BIM', 'Click', 'BCIPAY')),
  amount             integer NOT NULL CHECK (amount > 0),
  amount_with_fees   integer CHECK (amount_with_fees IS NULL OR amount_with_fees >= amount),
  recipient_phone    text NOT NULL DEFAULT '',
  recipient_name     text,
  description        text,
  metadata           jsonb NOT NULL DEFAULT '{}'::jsonb,
  status             text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'expired', 'cancelled')),
  matched_tier       integer,
  operator_reference text,
  actual_recipient_phone text,
  sms_received       text,
  idempotency_key    text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  expires_at         timestamptz NOT NULL,
  paid_at            timestamptz,
  cancelled_at       timestamptz
);

CREATE INDEX IF NOT EXISTS idx_payout_intents_pending
  ON public.payout_intents (method, amount, recipient_phone)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_payout_intents_merchant
  ON public.payout_intents (merchant_id, created_at DESC);

ALTER TABLE public.payout_intents ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "members read payouts" ON public.payout_intents;
CREATE POLICY "members read payouts" ON public.payout_intents
  FOR SELECT TO authenticated
  USING (public.user_is_member_of(merchant_id) OR public.is_super_admin());

DROP POLICY IF EXISTS "service all payouts" ON public.payout_intents;
CREATE POLICY "service all payouts" ON public.payout_intents
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Droits explicites (les privileges par defaut ne sont pas accordes sur
-- tous les projets Supabase, voir v39).
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.payout_intents TO service_role;
GRANT SELECT ON TABLE public.payout_intents TO authenticated;
REVOKE ALL ON TABLE public.payout_intents FROM anon;

-- SMS non rapproches : on distingue desormais les credits ('in'), les
-- debits ('out') et les SMS illisibles ('unknown', gardes pour apprendre
-- leur format au lieu d'etre perdus).
ALTER TABLE public.orphan_sms ADD COLUMN IF NOT EXISTS direction text NOT NULL DEFAULT 'in';
ALTER TABLE public.orphan_sms DROP CONSTRAINT IF EXISTS orphan_sms_direction_check;
ALTER TABLE public.orphan_sms ADD CONSTRAINT orphan_sms_direction_check
  CHECK (direction IN ('in', 'out', 'unknown'));
ALTER TABLE public.orphan_sms ADD COLUMN IF NOT EXISTS sender text;

-- Les webhooks existants (abonnes aux paiements entrants) recoivent aussi
-- les evenements des paiements sortants : le tableau de bord ne permet pas
-- de modifier les evenements d'un webhook existant.
UPDATE public.webhooks
SET events = events || ARRAY['payout.succeeded', 'payout.expired', 'payout.cancelled']
WHERE 'payment.succeeded' = ANY(events)
  AND NOT ('payout.succeeded' = ANY(events));

-- ---------------------------------------------------------------------
-- 2. Representation publique (webhooks + API)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.payout_public_json(p public.payout_intents)
RETURNS jsonb
LANGUAGE sql STABLE
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'object', 'payout',
    'ref', p.ref,
    'amount', p.amount,
    'amount_with_fees', p.amount_with_fees,
    'method', p.method,
    'recipient_phone', p.recipient_phone,
    'recipient_name', p.recipient_name,
    'description', p.description,
    'metadata', p.metadata,
    'status', p.status,
    'mode', p.mode,
    'matched_tier', p.matched_tier,
    'operator_reference', p.operator_reference,
    'actual_recipient_phone', p.actual_recipient_phone,
    'sms_received', p.sms_received,
    'created_at', p.created_at,
    'expires_at', p.expires_at,
    'paid_at', p.paid_at,
    'cancelled_at', p.cancelled_at
  );
$$;

CREATE OR REPLACE FUNCTION public.enqueue_payout_event(p public.payout_intents, p_event text)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN public.enqueue_webhook_delivery(p.merchant_id, p_event, jsonb_build_object(
    'id', 'evt_' || encode(gen_random_bytes(12), 'hex'),
    'type', p_event,
    'created', extract(epoch from now())::int,
    'livemode', p.mode = 'live',
    'data', jsonb_build_object('object', public.payout_public_json(p))
  ));
END;
$$;

-- ---------------------------------------------------------------------
-- 3. Rapprochement d'un SMS de debit
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.match_payout(
  p_method text,
  p_amount integer,
  p_recipient_phone text,
  p_operator_ref text,
  p_raw_sms text,
  p_sender text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_payout public.payout_intents%ROWTYPE;
  v_tier integer;
  v_count integer;
  v_orphan_id uuid;
  v_phone text := coalesce(p_recipient_phone, '');
BEGIN
  -- Tier 1 : numero du destinataire + montant (net ou frais compris).
  IF v_phone <> '' THEN
    SELECT * INTO v_payout
    FROM public.payout_intents
    WHERE method = p_method
      AND status = 'pending'
      AND mode = 'live'
      AND expires_at > now()
      AND recipient_phone = v_phone
      AND (amount = p_amount OR amount_with_fees = p_amount)
    ORDER BY created_at ASC
    LIMIT 1
    FOR UPDATE SKIP LOCKED;
    IF FOUND THEN
      v_tier := 1;
    END IF;
  ELSE
    -- Tier 2 : SMS sans numero (paiement par code), un seul candidat.
    SELECT count(*) INTO v_count
    FROM public.payout_intents
    WHERE method = p_method
      AND status = 'pending'
      AND mode = 'live'
      AND expires_at > now()
      AND (amount = p_amount OR amount_with_fees = p_amount);
    IF v_count = 1 THEN
      SELECT * INTO v_payout
      FROM public.payout_intents
      WHERE method = p_method
        AND status = 'pending'
        AND mode = 'live'
        AND expires_at > now()
        AND (amount = p_amount OR amount_with_fees = p_amount)
      LIMIT 1
      FOR UPDATE SKIP LOCKED;
      IF FOUND THEN
        v_tier := 2;
      END IF;
    END IF;
  END IF;

  IF v_tier IS NULL THEN
    INSERT INTO public.orphan_sms (raw_body, parsed_amount, parsed_phone, parsed_method, direction, sender)
    VALUES (p_raw_sms, p_amount, v_phone, p_method, 'out', p_sender)
    RETURNING id INTO v_orphan_id;
    RETURN jsonb_build_object(
      'matched', false,
      'reason', CASE WHEN coalesce(v_count, 0) > 1 THEN 'ambiguous' ELSE 'no_payout_found' END,
      'candidates', coalesce(v_count, 0),
      'orphan_id', v_orphan_id
    );
  END IF;

  UPDATE public.payout_intents
  SET status = 'paid',
      matched_tier = v_tier,
      operator_reference = nullif(p_operator_ref, ''),
      actual_recipient_phone = nullif(v_phone, ''),
      sms_received = p_raw_sms,
      paid_at = now()
  WHERE ref = v_payout.ref
  RETURNING * INTO v_payout;

  PERFORM public.enqueue_payout_event(v_payout, 'payout.succeeded');

  RETURN jsonb_build_object('matched', true, 'tier', v_tier, 'ref', v_payout.ref, 'merchant_id', v_payout.merchant_id);
END;
$$;

-- ---------------------------------------------------------------------
-- 4. Expiration (appelee par /api/cron/expire-intents)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.expire_old_payouts()
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_payout public.payout_intents%ROWTYPE;
  v_count integer := 0;
BEGIN
  FOR v_payout IN
    UPDATE public.payout_intents
    SET status = 'expired'
    WHERE status = 'pending' AND expires_at < now()
    RETURNING *
  LOOP
    PERFORM public.enqueue_payout_event(v_payout, 'payout.expired');
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END;
$$;

-- ---------------------------------------------------------------------
-- 5. Droits : service_role uniquement (voir v37 / KP-SEC-2026-001)
-- ---------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION public.payout_public_json(public.payout_intents) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.enqueue_payout_event(public.payout_intents, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.match_payout(text, integer, text, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.expire_old_payouts() FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.payout_public_json(public.payout_intents) TO service_role;
GRANT EXECUTE ON FUNCTION public.enqueue_payout_event(public.payout_intents, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.match_payout(text, integer, text, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.expire_old_payouts() TO service_role;

DO $$
DECLARE
  v_fn text;
  v_count int;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY['payout_public_json', 'enqueue_payout_event', 'match_payout', 'expire_old_payouts'] LOOP
    SELECT count(*) INTO v_count
    FROM information_schema.routine_privileges
    WHERE routine_schema = 'public'
      AND routine_name = v_fn
      AND grantee IN ('anon', 'authenticated', 'PUBLIC')
      AND privilege_type = 'EXECUTE';
    IF v_count > 0 THEN
      RAISE EXCEPTION 'v38 FAIL: public.% est executable par anon/authenticated', v_fn;
    END IF;
  END LOOP;
END $$;

NOTIFY pgrst, 'reload schema';

COMMIT;

SELECT 'v38_payout_intents applied' AS info;
