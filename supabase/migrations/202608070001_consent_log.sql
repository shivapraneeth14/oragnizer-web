-- Consent capture for account creation (Play Store + DPDP compliance).
-- Server-side only: written exclusively by Edge Functions (register,
-- record-consent) using the service role. No anon/authenticated privileges,
-- RLS enabled with no policies — clients can never read or write this table.

create table public.consent_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  consent_version text not null,
  accepted_at timestamptz not null default now(),
  source text not null default 'mobile' check (source in ('mobile', 'web'))
);

create index consent_log_user_idx on public.consent_log (user_id, accepted_at desc);

alter table public.consent_log enable row level security;

-- Hard-denial: remove table privileges from client roles entirely.
revoke all on public.consent_log from anon, authenticated;

grant all on public.consent_log to service_role;
