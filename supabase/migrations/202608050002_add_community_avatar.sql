-- Community avatar: dedicated round avatar image for the community, set from
-- the organizer web. Stored separately from banner_url (wide banner image)
-- and from profiles.avatar_url (the owner's personal app avatar) so the two
-- never overwrite each other.
ALTER TABLE communities ADD COLUMN community_avatar_url text;
