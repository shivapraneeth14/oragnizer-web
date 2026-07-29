-- ============================================================================
-- CLUVO — Community signup fields: categories, contacts, tags, rules
-- ============================================================================

-- Add unique constraint on name (partial, respects soft delete)
create unique index idx_communities_name on communities (name) where deleted_at is null;

-- Add new columns
alter table communities add column if not exists category text;
alter table communities add column if not exists city text;
alter table communities add column if not exists state text;
alter table communities add column if not exists country text;
alter table communities add column if not exists contact_email text;
alter table communities add column if not exists contact_phone text;
alter table communities add column if not exists tags text[];
alter table communities add column if not exists rules text;
