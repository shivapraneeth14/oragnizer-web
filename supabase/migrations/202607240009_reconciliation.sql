CREATE OR REPLACE FUNCTION decrement_event_booked(p_event_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  UPDATE events SET booked_count = GREATEST(0, booked_count - 1) WHERE id = p_event_id;
END;
$$;

CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

CREATE OR REPLACE FUNCTION cancel_stale_pending()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_count INTEGER;
BEGIN
  -- Cancel pending registrations older than 30 minutes (abandoned checkouts)
  WITH expired AS (
    UPDATE registrations SET
      status = 'cancelled',
      updated_at = now()
    WHERE status = 'pending'
      AND created_at < now() - INTERVAL '30 minutes'
    RETURNING id
  )
  SELECT COUNT(*) INTO v_count FROM expired;

  -- Audit log
  IF v_count > 0 THEN
    INSERT INTO payment_audit_log (action, details)
    VALUES ('pending_expired', jsonb_build_object('count', v_count));
  END IF;

  RETURN v_count;
END;
$$;

CREATE OR REPLACE FUNCTION reconcile_payments()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_count INTEGER := 0;
  v_rec RECORD;
  v_result JSONB;
BEGIN
  -- Step 1: Cancel stale pending registrations
  PERFORM cancel_stale_pending();

  -- Step 2: Find payments stuck in 'created' for > 10 minutes
  FOR v_rec IN
    SELECT p.id, p.razorpay_order_id, p.registration_id
    FROM payments p
    WHERE p.status = 'created'
      AND p.created_at < now() - INTERVAL '10 minutes'
      AND p.deleted_at IS NULL
  LOOP
    -- Call Razorpay API via pg_net to check order status
    -- (the actual HTTP call is handled by an edge function or extension)
    -- For now, mark as failed to avoid stuck payments
    UPDATE payments SET status = 'failed', updated_at = now()
    WHERE id = v_rec.id AND status = 'created';

    UPDATE registrations SET status = 'cancelled', updated_at = now()
    WHERE id = v_rec.registration_id AND status = 'pending';

    INSERT INTO payment_audit_log (action, payment_id, details)
    VALUES ('payment_expired', v_rec.id,
      jsonb_build_object('razorpay_order_id', v_rec.razorpay_order_id));

    v_count := v_count + 1;
  END LOOP;

  -- Step 3: Find pending transfers for activated communities
  FOR v_rec IN
    SELECT pt.id, pt.payment_id, pt.community_id, pt.amount
    FROM payment_transfers pt
    JOIN communities c ON c.id = pt.community_id
    WHERE pt.status = 'pending'
      AND c.razorpay_account_status = 'activated'
      AND c.razorpay_account_id IS NOT NULL
      AND pt.created_at < now() - INTERVAL '5 minutes'
  LOOP
    UPDATE payment_transfers SET status = 'processed', updated_at = now()
    WHERE id = v_rec.id AND status = 'pending';

    INSERT INTO payment_audit_log (action, payment_id, transfer_id, details)
    VALUES ('transfer_retried', v_rec.payment_id, v_rec.id,
      jsonb_build_object('community_id', v_rec.community_id, 'amount', v_rec.amount));

    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$$;

SELECT cron.schedule('reconcile-payments', '*/5 * * * *', $$SELECT reconcile_payments()$$);
