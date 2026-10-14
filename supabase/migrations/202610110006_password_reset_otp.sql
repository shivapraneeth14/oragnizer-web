-- ============================================================================
-- CLUVO — Password-reset OTP storage (custom OTP flow)
--
-- Replaces the GoTrue reset-link email with a server-generated 6-digit OTP so
-- the flow can enforce the operational rules the built-in magic link cannot:
--   1. OTP valid for exactly 10 minutes.
--   2. A resend overwrites the previous OTP (only the latest is valid).
--   3. Single-use: the OTP is destroyed as soon as it is verified.
--   4. Wrong-attempt throttling (5 tries) before a new code is required.
--
-- The table is server-only: all reads/writes come from the edge functions
-- (forgot-password / verify-otp / change-password) using the service_role key.
-- RLS is enabled with NO policies (denies anon/authenticated/PUBLIC) and table
-- grants are revoked from client roles so PostgREST can never read or mutate a
-- code/token hash.
--
-- reset_token_hash: a one-time, 10-minute "permission slip" minted ONLY after
-- a code verifies successfully. change-password consumes it to authorize the
-- password update, so nobody can skip OTP verification.
-- ============================================================================

create table if not exists public.password_reset_otps (
  user_id uuid primary key references auth.users(id) on delete cascade,
  otp_hash text,
  otp_attempts integer not null default 0 check (otp_attempts >= 0),
  otp_expires_at timestamptz not null,
  reset_token_hash text,
  reset_token_expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Server-only table: no client role may read, write, or mutate it.
alter table public.password_reset_otps enable row level security;

revoke all on table public.password_reset_otps from anon, authenticated, PUBLIC;

grant select, insert, update, delete on table public.password_reset_otps to service_role;