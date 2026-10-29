-- Block new activity when community is scheduled for closure
CREATE OR REPLACE FUNCTION public.prevent_activity_on_closure_scheduled()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_community_id UUID;
BEGIN
  IF TG_TABLE_NAME = 'events' THEN
    v_community_id := NEW.community_id;
  ELSIF TG_TABLE_NAME = 'registrations' THEN
    SELECT e.community_id INTO v_community_id FROM public.events e WHERE e.id = NEW.event_id;
  ELSIF TG_TABLE_NAME = 'payments' THEN
    SELECT e.community_id INTO v_community_id 
    FROM public.registrations r 
    JOIN public.events e ON e.id = r.event_id 
    WHERE r.id = NEW.registration_id;
  ELSIF TG_TABLE_NAME = 'community_subscriptions' THEN
    v_community_id := NEW.community_id;
  ELSIF TG_TABLE_NAME = 'payout_items' THEN
    v_community_id := NEW.community_id;
  ELSE
    RETURN NEW;
  END IF;

  IF v_community_id IS NOT NULL THEN
    IF EXISTS (
      SELECT 1 FROM public.communities c 
      WHERE c.id = v_community_id 
        AND c.deletion_grace_started_at IS NOT NULL 
        AND c.closed_at IS NULL
    ) THEN
      RAISE EXCEPTION 'Cannot create/update activity while community closure is scheduled';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_block_events_closure ON public.events;
CREATE TRIGGER trg_block_events_closure
  BEFORE INSERT OR UPDATE ON public.events
  FOR EACH ROW EXECUTE FUNCTION public.prevent_activity_on_closure_scheduled();

DROP TRIGGER IF EXISTS trg_block_registrations_closure ON public.registrations;
CREATE TRIGGER trg_block_registrations_closure
  BEFORE INSERT OR UPDATE ON public.registrations
  FOR EACH ROW EXECUTE FUNCTION public.prevent_activity_on_closure_scheduled();

DROP TRIGGER IF EXISTS trg_block_payments_closure ON public.payments;
CREATE TRIGGER trg_block_payments_closure
  BEFORE INSERT OR UPDATE ON public.payments
  FOR EACH ROW EXECUTE FUNCTION public.prevent_activity_on_closure_scheduled();

DROP TRIGGER IF EXISTS trg_block_subscriptions_closure ON public.community_subscriptions;
CREATE TRIGGER trg_block_subscriptions_closure
  BEFORE INSERT OR UPDATE ON public.community_subscriptions
  FOR EACH ROW EXECUTE FUNCTION public.prevent_activity_on_closure_scheduled();

DROP TRIGGER IF EXISTS trg_block_payout_items_closure ON public.payout_items;
CREATE TRIGGER trg_block_payout_items_closure
  BEFORE INSERT OR UPDATE ON public.payout_items
  FOR EACH ROW EXECUTE FUNCTION public.prevent_activity_on_closure_scheduled();
