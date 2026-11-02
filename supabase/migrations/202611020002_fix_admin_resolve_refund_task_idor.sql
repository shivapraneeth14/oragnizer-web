-- ============================================================================
-- CLUVO — Fix admin refund resolver IDOR (Stage 6 security remediation)
--
-- The admin dispatcher admin_resolve_refund_task authorized callers by the
-- caller-supplied p_admin_id parameter instead of the authenticated identity
-- (auth.uid()). A non-admin could pass another admin's id and pass the check.
--
-- This redefinition requires the caller to be the admin they claim to be:
--   auth.uid() must equal p_admin_id, and that user must be an admin.
-- The admin web UI passes its own logged-in id, so it is unaffected.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.admin_resolve_refund_task(
  p_task_id UUID,
  p_resolution_type TEXT,
  p_admin_id UUID,
  p_razorpay_refund_id TEXT,
  p_notes TEXT,
  p_evidence JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  -- IDOR fix: verify the authenticated caller is the admin they claim to be.
  IF auth.uid() IS NULL OR auth.uid() <> p_admin_id THEN
    RETURN jsonb_build_object('error', 'Unauthorized: caller identity mismatch');
  END IF;
  IF NOT public.is_admin_user() THEN
    RETURN jsonb_build_object('error', 'Unauthorized: Admin privileges required');
  END IF;

  IF p_resolution_type = 'adopt_provider_refund' THEN
    RETURN public.admin_adopt_provider_refund(p_task_id, p_admin_id, p_razorpay_refund_id, p_notes);

  ELSIF p_resolution_type = 'manual_settlement' THEN
    RETURN public.admin_manual_settlement(
      p_task_id,
      p_admin_id,
      COALESCE(
        p_evidence,
        jsonb_build_object(
          'settlement_method', 'bank_transfer',
          'reference_number', p_razorpay_refund_id,
          'notes', p_notes
        )
      )
    );

  ELSIF p_resolution_type = 'retry_task' THEN
    IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = p_admin_id AND is_admin = TRUE) THEN
      RETURN jsonb_build_object('error', 'Unauthorized: Admin privileges required');
    END IF;

    UPDATE public.refund_task_queue
    SET status = 'pending',
        attempt_count = 0,
        next_attempt_at = clock_timestamp(),
        leased_at = NULL,
        leased_by = NULL,
        lease_expires_at = NULL,
        error_message = 'Retried by admin: ' || COALESCE(p_notes, ''),
        updated_at = clock_timestamp()
    WHERE id = p_task_id;

    RETURN jsonb_build_object('ok', true, 'task_id', p_task_id, 'status', 'pending');

  ELSE
    RETURN jsonb_build_object('error', 'Invalid resolution_type: ' || p_resolution_type);
  END IF;
END;
$$;

REVOKE ALL PRIVILEGES ON FUNCTION public.admin_resolve_refund_task(UUID, TEXT, UUID, TEXT, TEXT, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_resolve_refund_task(UUID, TEXT, UUID, TEXT, TEXT, JSONB) TO authenticated, service_role;
