-- Account deletion: secure hard-delete helper.
--
-- gotrue's admin.deleteUser() fails with "Database error deleting user" on
-- this project for hard deletes, so the delete-account edge function deletes
-- the auth row through this security-definer RPC instead.
--
-- The RPC is gated to requests authenticated with the service_role key (the
-- edge function), so end users can never call it directly. Deleting the auth
-- row cascades to profiles -> memberships, join requests, waitlists, wishlist
-- and event messages, while the SET NULL FKs from 202608060003 keep
-- registrations/payments/events/audit rows intact and unlinked.

create or replace function public.delete_user_auth_cascade(p_user_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_claims text := nullif(current_setting('request.jwt.claims', true), '');
  v_role text;
begin
  if v_claims is null then
    raise exception 'Permission denied';
  end if;
  v_role := (v_claims::jsonb ->> 'role')::text;
  if v_role <> 'service_role' then
    raise exception 'Permission denied';
  end if;
  delete from auth.users where id = p_user_id;
  return found;
end;
$$;

revoke all on function public.delete_user_auth_cascade(uuid) from public;
grant execute on function public.delete_user_auth_cascade(uuid) to service_role;
