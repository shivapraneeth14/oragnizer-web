-- ============================================================================
-- CLUVO — Immutable payment ledger (Stage 8, phase 1)
--
-- The `payments` row is a mutable booking-state row: a cancel -> rebook cycle
-- REUSES it and overwrites amount / order / capture id / created_at. That is
-- correct for checkout, but it destroys the historical sale, so every
-- financial report that reads `payments` undercounts gross and mis-attributes
-- refunds.
--
-- This migration adds the append-only records that must never be overwritten:
--
--   payment_sales       one row per successful capture (never updated)
--   payment_refund_history  (extended) one row per refund, linked to its sale
--   refund_clawbacks    the organizer-share debt created by a refund; lives
--                       in its own table so a requote can never erase it
--
-- Nothing existing is dropped, renamed, or rewritten. `payments` keeps running
-- the booking flow exactly as before; only readers move to these tables.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. payment_sales — append-only sale record
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.payment_sales (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id          uuid NOT NULL REFERENCES public.payments(id) ON DELETE RESTRICT,
  registration_id     uuid NOT NULL REFERENCES public.registrations(id) ON DELETE RESTRICT,
  event_id            uuid NOT NULL REFERENCES public.events(id) ON DELETE RESTRICT,
  community_id        uuid NOT NULL REFERENCES public.communities(id) ON DELETE RESTRICT,
  user_id             uuid NULL REFERENCES public.profiles(id) ON DELETE SET NULL,
  razorpay_order_id   text NOT NULL,
  razorpay_payment_id text NOT NULL,
  attempt_count       integer NOT NULL DEFAULT 1,
  currency            text NOT NULL DEFAULT 'INR',
  gross_amount        integer NOT NULL CHECK (gross_amount > 0),
  ticket_amount       integer NOT NULL CHECK (ticket_amount >= 0),
  platform_fee        integer NOT NULL DEFAULT 0 CHECK (platform_fee >= 0),
  platform_fee_gst    integer NOT NULL DEFAULT 0 CHECK (platform_fee_gst >= 0),
  captured_at         timestamptz NOT NULL,
  source              text NOT NULL DEFAULT 'live'
                      CHECK (source IN ('live', 'backfill', 'reconstructed')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payment_sales_capture_uniq UNIQUE (razorpay_payment_id)
);

CREATE INDEX IF NOT EXISTS idx_payment_sales_community
  ON public.payment_sales (community_id, captured_at);
CREATE INDEX IF NOT EXISTS idx_payment_sales_event
  ON public.payment_sales (event_id, captured_at);
CREATE INDEX IF NOT EXISTS idx_payment_sales_payment
  ON public.payment_sales (payment_id);
CREATE INDEX IF NOT EXISTS idx_payment_sales_registration
  ON public.payment_sales (registration_id);

COMMENT ON TABLE public.payment_sales IS
  'Append-only record of every successful capture. One row per payment attempt that actually took money. Never updated or deleted.';

-- ----------------------------------------------------------------------------
-- 2. payment_refund_history — link each refund to the sale it reverses
-- ----------------------------------------------------------------------------
ALTER TABLE public.payment_refund_history
  ADD COLUMN IF NOT EXISTS sale_id          uuid REFERENCES public.payment_sales(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS community_id     uuid REFERENCES public.communities(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS refund_amount    integer,
  ADD COLUMN IF NOT EXISTS fee_kept         integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS organizer_clawed integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS currency         text NOT NULL DEFAULT 'INR',
  ADD COLUMN IF NOT EXISTS requested_at     timestamptz,
  ADD COLUMN IF NOT EXISTS processed_at     timestamptz,
  ADD COLUMN IF NOT EXISTS source           text NOT NULL DEFAULT 'live';

CREATE INDEX IF NOT EXISTS idx_payment_refund_history_sale
  ON public.payment_refund_history (sale_id);
CREATE INDEX IF NOT EXISTS idx_payment_refund_history_community
  ON public.payment_refund_history (community_id, created_at);

-- ----------------------------------------------------------------------------
-- 3. refund_clawbacks — the debt a refund creates against the organizer wallet
--
-- Kept OUT of `payments` on purpose: `clearRefundFieldsForRequote` rewrites
-- the payment row on every rebook. A debt stored here cannot be erased by a
-- rebook, a provider retry, or a status reset.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.refund_clawbacks (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  refund_id     uuid NOT NULL UNIQUE REFERENCES public.payment_refund_history(id) ON DELETE RESTRICT,
  payment_id    uuid NOT NULL REFERENCES public.payments(id) ON DELETE RESTRICT,
  sale_id       uuid NOT NULL REFERENCES public.payment_sales(id) ON DELETE RESTRICT,
  community_id  uuid NOT NULL REFERENCES public.communities(id) ON DELETE RESTRICT,
  event_id      uuid NOT NULL REFERENCES public.events(id) ON DELETE RESTRICT,
  amount        integer NOT NULL CHECK (amount > 0),
  state         text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'done')),
  attempts      integer NOT NULL DEFAULT 0,
  last_error    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  settled_at    timestamptz
);

CREATE INDEX IF NOT EXISTS idx_refund_clawbacks_pending
  ON public.refund_clawbacks (state, created_at)
  WHERE state = 'pending';
CREATE INDEX IF NOT EXISTS idx_refund_clawbacks_community
  ON public.refund_clawbacks (community_id, state);
CREATE INDEX IF NOT EXISTS idx_refund_clawbacks_payment
  ON public.refund_clawbacks (payment_id);

COMMENT ON TABLE public.refund_clawbacks IS
  'Organizer-share debt created when a customer is refunded. Payouts reserve it; retry_refund_clawbacks settles it. Never erased by a requote.';

-- ----------------------------------------------------------------------------
-- 4. Immutability — sales are append-only, clawback amounts never change
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.block_financial_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'Financial records are append-only: % on %', TG_OP, TG_TABLE_NAME;
END;
$$;

DROP TRIGGER IF EXISTS trg_payment_sales_immutable ON public.payment_sales;
CREATE TRIGGER trg_payment_sales_immutable
BEFORE UPDATE OR DELETE ON public.payment_sales
FOR EACH ROW EXECUTE FUNCTION public.block_financial_mutation();

-- Clawbacks may only move state/attempts/error/settled_at. Amounts and links
-- are frozen.
CREATE OR REPLACE FUNCTION public.guard_refund_clawback_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'refund_clawbacks rows cannot be deleted';
  END IF;

  IF NEW.refund_id IS DISTINCT FROM OLD.refund_id
     OR NEW.payment_id IS DISTINCT FROM OLD.payment_id
     OR NEW.sale_id IS DISTINCT FROM OLD.sale_id
     OR NEW.community_id IS DISTINCT FROM OLD.community_id
     OR NEW.event_id IS DISTINCT FROM OLD.event_id
     OR NEW.amount IS DISTINCT FROM OLD.amount
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'refund_clawbacks financial identity is immutable';
  END IF;

  IF NEW.state = 'done' AND OLD.state = 'pending' AND NEW.settled_at IS NULL THEN
    NEW.settled_at := clock_timestamp();
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_refund_clawbacks_guard ON public.refund_clawbacks;
CREATE TRIGGER trg_refund_clawbacks_guard
BEFORE UPDATE OR DELETE ON public.refund_clawbacks
FOR EACH ROW EXECUTE FUNCTION public.guard_refund_clawback_mutation();

-- ----------------------------------------------------------------------------
-- 5. RLS + grants
-- ----------------------------------------------------------------------------
ALTER TABLE public.payment_sales ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.refund_clawbacks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS payment_sales_admin_read ON public.payment_sales;
CREATE POLICY payment_sales_admin_read ON public.payment_sales
  FOR SELECT USING (public.is_admin_user());

DROP POLICY IF EXISTS payment_sales_own_read ON public.payment_sales;
CREATE POLICY payment_sales_own_read ON public.payment_sales
  FOR SELECT USING (
    registration_id IN (
      SELECT r.id FROM public.registrations r WHERE r.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS payment_sales_team_read ON public.payment_sales;
CREATE POLICY payment_sales_team_read ON public.payment_sales
  FOR SELECT USING (
    public.is_community_owner(community_id) OR public.is_community_team(community_id)
  );

DROP POLICY IF EXISTS refund_clawbacks_admin_read ON public.refund_clawbacks;
CREATE POLICY refund_clawbacks_admin_read ON public.refund_clawbacks
  FOR SELECT USING (public.is_admin_user());

REVOKE ALL ON public.payment_sales FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.refund_clawbacks FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.payment_sales TO authenticated;
GRANT SELECT ON public.refund_clawbacks TO authenticated;
GRANT ALL ON public.payment_sales TO service_role;
GRANT ALL ON public.refund_clawbacks TO service_role;

-- ----------------------------------------------------------------------------
-- 6. Backfill: one sale row per payment row that actually took money.
--
-- A reused row only holds its LATEST sale, so this recovers the current sale
-- exactly and the older cycles only where the audit log preserved them (see
-- the reconstructed pass below).
-- ----------------------------------------------------------------------------
INSERT INTO public.payment_sales (
  payment_id, registration_id, event_id, community_id, user_id,
  razorpay_order_id, razorpay_payment_id, attempt_count, currency,
  gross_amount, ticket_amount, platform_fee, platform_fee_gst,
  captured_at, source
)
SELECT
  p.id,
  r.id,
  r.event_id,
  e.community_id,
  r.user_id,
  COALESCE(p.razorpay_order_id, 'legacy_' || p.id::text),
  p.razorpay_payment_id,
  GREATEST(COALESCE(p.attempt_count, 0), 1),
  COALESCE(p.currency, 'INR'),
  p.amount,
  GREATEST(p.amount - COALESCE(p.platform_fee, 0) - COALESCE(p.platform_fee_gst, 0), 0),
  GREATEST(COALESCE(p.platform_fee, 0), 0),
  GREATEST(COALESCE(p.platform_fee_gst, 0), 0),
  p.created_at,
  'backfill'
FROM public.payments p
JOIN public.registrations r ON r.id = p.registration_id
JOIN public.events e ON e.id = r.event_id
WHERE p.razorpay_payment_id IS NOT NULL
  AND p.status IN ('success', 'refunded')
  AND p.deleted_at IS NULL
ON CONFLICT (razorpay_payment_id) DO NOTHING;

-- Link legacy refund history to the closest sale that existed when it was
-- created. Exact for one-cycle rows; best-effort for reused rows.
UPDATE public.payment_refund_history prh
SET sale_id = s.id,
    community_id = COALESCE(prh.community_id, e.community_id),
    refund_amount = COALESCE(prh.refund_amount, prh.amount),
    requested_at = COALESCE(prh.requested_at, prh.created_at),
    processed_at = CASE
      WHEN prh.refund_status = 'processed'
        THEN COALESCE(prh.processed_at, prh.created_at)
      ELSE prh.processed_at
    END,
    organizer_clawed = CASE
      WHEN COALESCE(prh.organizer_clawed, 0) = 0
        THEN LEAST(prh.amount, s.ticket_amount)
      ELSE prh.organizer_clawed
    END,
    fee_kept = CASE
      WHEN COALESCE(prh.fee_kept, 0) = 0
        THEN GREATEST(prh.amount - s.ticket_amount, 0)
      ELSE prh.fee_kept
    END
FROM public.payment_sales s
JOIN public.registrations r ON r.id = s.registration_id
JOIN public.events e ON e.id = s.event_id
WHERE prh.sale_id IS NULL
  AND s.payment_id = prh.payment_id
  AND s.captured_at <= prh.created_at
  AND s.id = (
    SELECT s2.id
    FROM public.payment_sales s2
    WHERE s2.payment_id = prh.payment_id
      AND s2.captured_at <= prh.created_at
    ORDER BY s2.captured_at DESC
    LIMIT 1
  );

-- Backfill legacy deferred clawbacks into the durable table so the retry job
-- can still find them after this release.
INSERT INTO public.refund_clawbacks (
  refund_id, payment_id, sale_id, community_id, event_id, amount, state, created_at
)
SELECT
  h.id, p.id, h.sale_id, e.community_id, r.event_id,
  GREATEST(COALESCE(h.organizer_clawed, p.organizer_share, 0), 0),
  'pending',
  COALESCE(p.updated_at, now())
FROM public.payments p
JOIN public.registrations r ON r.id = p.registration_id
JOIN public.events e ON e.id = r.event_id
JOIN LATERAL (
  SELECT h2.*
  FROM public.payment_refund_history h2
  WHERE h2.payment_id = p.id
    AND h2.refund_status = 'processed'
    AND h2.sale_id IS NOT NULL
  ORDER BY h2.created_at DESC
  LIMIT 1
) h ON TRUE
WHERE p.refund_clawback_state = 'pending'
  AND p.refund_status = 'processed'
  AND GREATEST(COALESCE(h.organizer_clawed, p.organizer_share, 0), 0) > 0
ON CONFLICT (refund_id) DO NOTHING;
