-- Fix cancel_stale_pending: only cancel pending registrations that have
-- NO associated payment record. Registrations with payments (even pending
-- payments) are now handled by the reconcile-payments Edge Function which
-- checks actual Razorpay order status before taking any action.

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
    UPDATE public.registrations r SET
      status = 'cancelled',
      updated_at = now()
    WHERE r.status = 'pending'
      AND r.registered_at < now() - INTERVAL '30 minutes'
      AND NOT EXISTS (
        SELECT 1 FROM public.payments p
        WHERE p.registration_id = r.id
          AND p.deleted_at IS NULL
      )
    RETURNING r.id
  )
  SELECT COUNT(*) INTO v_count FROM expired;

  IF v_count > 0 THEN
    INSERT INTO public.payment_audit_log (action, details)
    VALUES ('pending_expired', jsonb_build_object('count', v_count));
  END IF;

  RETURN v_count;
END;
$$;
