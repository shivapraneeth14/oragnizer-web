-- ============================================================================
-- CLUVO — Organizer-initiated refund keeps the platform fee (refund policy)
--
-- The organizer-cancel / issue-refund path persisted refund_amount_due as the
-- FULL charged amount. The policy is now: a confirmed booking is refunded the
-- ticket price only (organizer_share) and the platform fee is never refunded.
-- The full amount is refunded only for never-confirmed captures (organizer_share
-- NULL), which are handled by the webhook/reconcile paths — not this RPC.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.cancel_registration_and_claim_refund(p_payment_id uuid, p_caller_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_reg_id UUID;
  v_event_id UUID;
  v_community_id UUID;
  v_reg_status TEXT;
  v_booked_count_decremented BOOLEAN := FALSE;
  v_payment RECORD;
BEGIN
  -- Step 0: Identify foreign keys
  SELECT p.registration_id, r.event_id, e.community_id
  INTO v_reg_id, v_event_id, v_community_id
  FROM public.payments p
  JOIN public.registrations r ON r.id = p.registration_id
  JOIN public.events e ON e.id = r.event_id
  WHERE p.id = p_payment_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'Payment or registration not found');
  END IF;

  -- 1. Authorization: Verify caller is community owner, organizer/moderator, or platform admin
  IF NOT (
    EXISTS (SELECT 1 FROM public.communities c WHERE c.id = v_community_id AND c.owner_id = p_caller_id)
    OR EXISTS (
      SELECT 1 FROM public.community_members m
      WHERE m.community_id = v_community_id
        AND m.user_id = p_caller_id
        AND m.role IN ('ORGANIZER', 'MODERATOR')
    )
    OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = p_caller_id AND p.is_admin = TRUE)
  ) THEN
    RETURN jsonb_build_object('error', 'Unauthorized: Insufficient permissions to refund this payment');
  END IF;

  -- 2. Global Lock Hierarchy Level 1: Lock Event Row FIRST
  -- Eliminates deadlock hazard with reserve_ticket_capacity and atomic_free_event_registration
  IF v_event_id IS NOT NULL THEN
    PERFORM 1 FROM public.events WHERE id = v_event_id FOR UPDATE;
  END IF;

  -- 3. Global Lock Hierarchy Level 2: Lock Registration Row SECOND
  SELECT r.status INTO v_reg_status
  FROM public.registrations r
  WHERE r.id = v_reg_id
  FOR UPDATE;

  -- Attended guard: attended tickets are permanently non-refundable
  IF v_reg_status = 'attended' THEN
    RETURN jsonb_build_object(
      'error', 'not_refundable_attended',
      'message', 'Attendee already attended the event - no refund'
    );
  END IF;

  IF v_reg_status = 'cancelled' THEN
    RETURN jsonb_build_object(
      'error', 'already_cancelled',
      'message', 'Registration is already cancelled'
    );
  END IF;

  -- 4. Global Lock Hierarchy Level 3: Lock Payment Row THIRD
  SELECT * INTO v_payment
  FROM public.payments
  WHERE id = p_payment_id
  FOR UPDATE;

  IF v_payment.status NOT IN ('success', 'failed') OR v_payment.razorpay_payment_id IS NULL THEN
    RETURN jsonb_build_object('error', 'Payment is not refundable in its current state');
  END IF;

  -- 5. Atomic Cancellation: cancel ticket and clear QR code immediately
  UPDATE public.registrations
  SET status = 'cancelled',
      qr_code = NULL,
      deleted_at = clock_timestamp(),
      updated_at = clock_timestamp()
  WHERE id = v_reg_id;

  -- Exactly-once capacity decrement (only if prior status was confirmed)
  IF v_reg_status = 'confirmed' AND v_event_id IS NOT NULL THEN
    UPDATE public.events
    SET booked_count = GREATEST(0, booked_count - 1),
        updated_at = clock_timestamp()
    WHERE id = v_event_id;
    v_booked_count_decremented := TRUE;
  END IF;

  -- 6. Acquire refund claim & persist durable recovery debt in same transaction
  UPDATE public.payments
  SET refund_claim_state = 'claimed',
      refund_claim_at = clock_timestamp(),
      refund_attempt_count = COALESCE(refund_attempt_count, 0) + 1,
      refund_reason = 'organizer_issue_refund',
      refund_amount_due = COALESCE(v_payment.organizer_share, GREATEST(v_payment.amount - COALESCE(v_payment.platform_fee, 0), 0)),
      updated_at = clock_timestamp()
  WHERE id = p_payment_id;

  RETURN jsonb_build_object(
    'ok', true,
    'payment_id', p_payment_id,
    'registration_id', v_reg_id,
    'amount', v_payment.amount,
    'razorpay_payment_id', v_payment.razorpay_payment_id,
    'claim_attempt', COALESCE(v_payment.refund_attempt_count, 0) + 1,
    'decremented_capacity', v_booked_count_decremented
  );
END;
$function$
