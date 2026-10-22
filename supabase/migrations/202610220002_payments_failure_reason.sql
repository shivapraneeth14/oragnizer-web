-- Add failure_reason to payments to surface cancellation/sold-out at confirmation time
ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS failure_reason TEXT;

COMMENT ON COLUMN public.payments.failure_reason IS 'Reason for payment failure/refund_required (e.g. event_cancelled, capacity_full)';
