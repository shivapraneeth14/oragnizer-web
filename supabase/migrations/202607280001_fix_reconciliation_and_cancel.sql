-- Fix: decrement_event_booked used unqualified "events" with SET search_path = ''
CREATE OR REPLACE FUNCTION decrement_event_booked(p_event_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  UPDATE public.events SET booked_count = GREATEST(0, booked_count - 1) WHERE id = p_event_id;
END;
$$;

-- Fix: cancel_stale_pending used unqualified "registrations" and wrong column "created_at"
-- (column is "registered_at")
CREATE OR REPLACE FUNCTION cancel_stale_pending()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_count INTEGER;
BEGIN
  WITH expired AS (
    UPDATE public.registrations SET
      status = 'cancelled',
      updated_at = now()
    WHERE status = 'pending'
      AND registered_at < now() - INTERVAL '30 minutes'
    RETURNING id
  )
  SELECT COUNT(*) INTO v_count FROM expired;

  IF v_count > 0 THEN
    INSERT INTO public.payment_audit_log (action, details)
    VALUES ('pending_expired', jsonb_build_object('count', v_count));
  END IF;

  RETURN v_count;
END;
$$;

-- Fix: reconcile_payments used unqualified tables and function calls
CREATE OR REPLACE FUNCTION reconcile_payments()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_count INTEGER := 0;
  v_rec RECORD;
BEGIN
  PERFORM public.cancel_stale_pending();

  FOR v_rec IN
    SELECT p.id, p.razorpay_order_id, p.registration_id
    FROM public.payments p
    WHERE p.status = 'created'
      AND p.created_at < now() - INTERVAL '10 minutes'
      AND p.deleted_at IS NULL
  LOOP
    UPDATE public.payments SET status = 'failed', updated_at = now()
    WHERE id = v_rec.id AND status = 'created';

    UPDATE public.registrations SET status = 'cancelled', updated_at = now()
    WHERE id = v_rec.registration_id AND status = 'pending';

    INSERT INTO public.payment_audit_log (action, payment_id, details)
    VALUES ('payment_expired', v_rec.id,
      jsonb_build_object('razorpay_order_id', v_rec.razorpay_order_id));

    v_count := v_count + 1;
  END LOOP;

  FOR v_rec IN
    SELECT pt.id, pt.payment_id, pt.community_id, pt.amount
    FROM public.payment_transfers pt
    JOIN public.communities c ON c.id = pt.community_id
    WHERE pt.status = 'pending'
      AND c.razorpay_account_status = 'activated'
      AND c.razorpay_account_id IS NOT NULL
      AND pt.created_at < now() - INTERVAL '5 minutes'
  LOOP
    UPDATE public.payment_transfers SET status = 'processed', updated_at = now()
    WHERE id = v_rec.id AND status = 'pending';

    INSERT INTO public.payment_audit_log (action, payment_id, transfer_id, details)
    VALUES ('transfer_retried', v_rec.payment_id, v_rec.id,
      jsonb_build_object('community_id', v_rec.community_id, 'amount', v_rec.amount));

    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$$;
