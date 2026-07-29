-- ============================================================================
-- CLUVO — COMPLETE CORE SCHEMA (Final, reviewed as senior DB architect)
-- Run in Supabase SQL Editor, or via `supabase migration new` + `db push`.
-- ============================================================================

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- Reusable trigger: auto-update updated_at
-- ---------------------------------------------------------------------------
create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

-- ---------------------------------------------------------------------------
-- 1. PROFILES — extends auth.users, auto-created on signup
-- ---------------------------------------------------------------------------
create table profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  full_name text,
  avatar_url text,
  role text not null default 'member' check (role in ('member','organizer','admin')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create trigger trg_profiles_updated before update on profiles
  for each row execute function set_updated_at();

-- Auto-create profile the moment someone signs up via Supabase Auth
create or replace function handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, email, full_name, avatar_url)
  values (
    new.id,
    new.email,
    new.raw_user_meta_data->>'full_name',
    new.raw_user_meta_data->>'avatar_url'
  );
  return new;
end;
$$ language plpgsql security definer;

create trigger trg_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- ---------------------------------------------------------------------------
-- 2. COMMUNITIES
-- ---------------------------------------------------------------------------
create table communities (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  location text,
  banner_url text,
  owner_id uuid not null references profiles(id),  -- singular owner, unambiguous
  visibility text not null default 'public' check (visibility in ('public','private')),
  verification_status text not null default 'unverified' check (verification_status in ('unverified','pending','verified')),
  status text not null default 'pending_approval' check (status in ('pending_approval','active','suspended')),
  member_count int not null default 0,   -- maintained counter
  event_count int not null default 0,    -- maintained counter
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index idx_communities_discovery on communities (location, status) where deleted_at is null;
create trigger trg_communities_updated before update on communities
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- 3. COMMUNITY_MEMBERS — role + granular permissions (the "many roles" fix)
-- ---------------------------------------------------------------------------
create table community_members (
  community_id uuid not null references communities(id) on delete cascade,
  user_id uuid not null references profiles(id) on delete cascade,
  role text not null default 'member' check (role in ('member','moderator','organizer')),
  permissions jsonb not null default '{}',
  -- e.g. {"manage_events": true, "manage_members": true, "scan_qr": true,
  --       "manage_offers": false, "moderate_comments": true, "view_analytics": true}
  -- Owner (communities.owner_id) always has full implicit access regardless
  -- of this column. Moderators/organizers-in-team NEVER get: transfer
  -- ownership, delete community, change payout, remove owner — hardcoded,
  -- never granted via permissions.
  joined_at timestamptz not null default now(),
  primary key (community_id, user_id)
);

-- private-community join requests, separate from direct membership
create table join_requests (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null references communities(id) on delete cascade,
  user_id uuid not null references profiles(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  created_at timestamptz not null default now(),
  unique (community_id, user_id)
);

-- ---------------------------------------------------------------------------
-- 4. EVENTS
-- ---------------------------------------------------------------------------
create table events (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null references communities(id) on delete cascade,
  title text not null,
  description text,
  start_date timestamptz not null,
  end_date timestamptz,
  location text,
  capacity integer,
  price integer not null default 0,   -- paise
  booked_count int not null default 0, -- maintained counter
  status text not null default 'draft' check (status in ('draft','published','cancelled','completed')),
  created_by uuid not null references profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index idx_events_discovery on events (start_date, status) where deleted_at is null;
create index idx_events_by_community on events (community_id);
create trigger trg_events_updated before update on events
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- 5. WAITLIST — event full, customer waits for a spot
-- ---------------------------------------------------------------------------
create table waitlist_entries (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references events(id) on delete cascade,
  user_id uuid not null references profiles(id) on delete cascade,
  position int not null,
  status text not null default 'waiting' check (status in ('waiting','promoted','expired')),
  created_at timestamptz not null default now(),
  unique (event_id, user_id)
);

-- ---------------------------------------------------------------------------
-- 6. COUPONS
-- ---------------------------------------------------------------------------
create table coupons (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null references communities(id) on delete cascade,
  code text not null,
  discount_type text not null check (discount_type in ('percentage','flat')),
  discount_value int not null,
  valid_until date,
  max_uses int,
  used_count int not null default 0,
  created_at timestamptz not null default now(),
  unique (community_id, code)
);

-- ---------------------------------------------------------------------------
-- 7. REGISTRATIONS (bookings) — ticket fields folded in, strict 1:1 relation
-- ---------------------------------------------------------------------------
create table registrations (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references events(id),
  user_id uuid not null references profiles(id),
  status text not null default 'pending' check (status in ('pending','confirmed','cancelled','attended')),
  qr_code text unique,
  checked_in boolean not null default false,
  checked_in_at timestamptz,
  registered_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (event_id, user_id)
);
create index idx_registrations_by_event on registrations (event_id, status);
create index idx_registrations_by_user on registrations (user_id);
create trigger trg_registrations_updated before update on registrations
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- 8. PAYMENTS
-- ---------------------------------------------------------------------------
create table payments (
  id uuid primary key default gen_random_uuid(),
  registration_id uuid not null unique references registrations(id),
  amount integer not null,   -- paise
  currency text not null default 'INR',
  coupon_id uuid references coupons(id),
  razorpay_order_id text,
  razorpay_payment_id text,
  status text not null default 'pending' check (status in ('pending','success','failed','refunded')),
  refund_status text check (refund_status in ('requested','approved','processed','denied')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index idx_payments_razorpay_order on payments (razorpay_order_id);
create index idx_payments_razorpay_payment on payments (razorpay_payment_id);
create trigger trg_payments_updated before update on payments
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- 9. PLANS / SUBSCRIPTIONS (free → paid gating for organizers)
-- ---------------------------------------------------------------------------
create table plans (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  price integer not null default 0,
  limits jsonb not null default '{}',   -- e.g. {"max_events_per_month": 3}
  created_at timestamptz not null default now()
);

create table community_subscriptions (
  id uuid primary key default gen_random_uuid(),
  community_id uuid not null unique references communities(id),
  plan_id uuid not null references plans(id),
  status text not null default 'active' check (status in ('active','expired','cancelled')),
  expires_at timestamptz,
  created_at timestamptz not null default now()
);
create index idx_subscriptions_expiry on community_subscriptions (expires_at);

-- ---------------------------------------------------------------------------
-- 10. REVIEWS
-- ---------------------------------------------------------------------------
create table reviews (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references events(id),
  user_id uuid not null references profiles(id),
  rating integer not null check (rating between 1 and 5),
  comment text,
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (event_id, user_id)
);

-- ---------------------------------------------------------------------------
-- 11. NOTIFICATIONS
-- ---------------------------------------------------------------------------
create table notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id),
  type text not null,
  title text not null,
  body text,
  payload jsonb,
  read boolean not null default false,
  created_at timestamptz not null default now()
);
create index idx_notifications_by_user on notifications (user_id, read, created_at desc);

-- ---------------------------------------------------------------------------
-- 12. REPORTS — moderation, needed from day one
-- ---------------------------------------------------------------------------
create table reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid not null references profiles(id),
  target_type text not null check (target_type in ('community','event','user','review')),
  target_id uuid not null,
  reason text,
  status text not null default 'open' check (status in ('open','reviewed','resolved')),
  created_at timestamptz not null default now()
);

-- ============================================================================
-- ROW LEVEL SECURITY — PRIMARY ENFORCEMENT LAYER
-- ============================================================================

alter table profiles enable row level security;
create policy "profiles_self_read" on profiles for select using (id = auth.uid());
create policy "profiles_self_update" on profiles for update using (id = auth.uid());
create policy "profiles_public_basic_read" on profiles for select
  using (true); -- name/avatar are fine to be publicly visible (e.g. reviewer names); keep sensitive fields out of this table if ever added

alter table communities enable row level security;
create policy "communities_public_read" on communities
  for select using (status = 'active' and visibility = 'public' and deleted_at is null);
create policy "communities_team_read" on communities
  for select using (
    owner_id = auth.uid()
    or id in (select community_id from community_members where user_id = auth.uid())
  );
create policy "communities_owner_write" on communities
  for update using (owner_id = auth.uid());

alter table community_members enable row level security;
create policy "community_members_self_read" on community_members
  for select using (user_id = auth.uid());
create policy "community_members_team_read" on community_members
  for select using (
    community_id in (select id from communities where owner_id = auth.uid())
    or community_id in (select community_id from community_members where user_id = auth.uid())
  );

alter table events enable row level security;
create policy "events_public_read" on events
  for select using (status = 'published' and deleted_at is null);
create policy "events_team_read" on events
  for select using (
    community_id in (select id from communities where owner_id = auth.uid())
    or community_id in (select community_id from community_members where user_id = auth.uid())
  );

alter table registrations enable row level security;
create policy "registrations_self_read" on registrations
  for select using (user_id = auth.uid());
create policy "registrations_team_read" on registrations
  for select using (
    event_id in (
      select e.id from events e
      where e.community_id in (
        select id from communities where owner_id = auth.uid()
        union
        select community_id from community_members where user_id = auth.uid()
      )
    )
  );

alter table payments enable row level security;
create policy "payments_via_own_registration" on payments
  for select using (
    registration_id in (select id from registrations where user_id = auth.uid())
  );
create policy "payments_team_read" on payments
  for select using (
    registration_id in (
      select r.id from registrations r
      join events e on e.id = r.event_id
      where e.community_id in (
        select id from communities where owner_id = auth.uid()
        union
        select community_id from community_members where user_id = auth.uid()
      )
    )
  );

alter table reviews enable row level security;
create policy "reviews_public_read" on reviews for select using (deleted_at is null);
create policy "reviews_own_write" on reviews for insert with check (user_id = auth.uid());
create policy "reviews_own_update" on reviews for update using (user_id = auth.uid());

alter table notifications enable row level security;
create policy "notifications_self_only" on notifications
  for select using (user_id = auth.uid());
create policy "notifications_self_update" on notifications
  for update using (user_id = auth.uid());

alter table reports enable row level security;
create policy "reports_own_read" on reports for select using (reporter_id = auth.uid());
create policy "reports_own_write" on reports for insert with check (reporter_id = auth.uid());

alter table join_requests enable row level security;
create policy "join_requests_self_read" on join_requests
  for select using (user_id = auth.uid());
create policy "join_requests_team_read" on join_requests
  for select using (
    community_id in (select id from communities where owner_id = auth.uid())
  );

-- ============================================================================
-- NOTE: All writes to communities/events/registrations/payments/coupons that
-- involve permission checks beyond simple ownership, or that call Razorpay,
-- go through Edge Functions — which re-check permissions explicitly even
-- though RLS also exists (both layers check, always, per the constitution).
-- ============================================================================
