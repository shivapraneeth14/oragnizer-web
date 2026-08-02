-- ============================================================================
-- CLUVO — Admin visibility toggle: hide communities from the Flutter app
-- is_hidden = true => community and its events are invisible in the Flutter
-- web/app (filtered client-side). Organizer web and admin web still show it.
-- ============================================================================

ALTER TABLE communities ADD COLUMN is_hidden boolean NOT NULL DEFAULT false;
