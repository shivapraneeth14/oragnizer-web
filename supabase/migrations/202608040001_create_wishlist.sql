-- Wishlist: per-user saved events & communities.
-- Follows the polymorphic pattern of media (item_type / item_id); item content
-- is only ever reached through the events / communities public-read policies,
-- so a saved item that stops being public simply drops out of joins.
CREATE TABLE wishlist (
  user_id    UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  item_type  TEXT NOT NULL CHECK (item_type IN ('event', 'community')),
  item_id    UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, item_type, item_id)
);

CREATE INDEX idx_wishlist_user ON wishlist (user_id, created_at DESC);

ALTER TABLE wishlist ENABLE ROW LEVEL SECURITY;

CREATE POLICY "wishlist_self_read" ON wishlist
  FOR SELECT USING (user_id = auth.uid());
CREATE POLICY "wishlist_self_insert" ON wishlist
  FOR INSERT WITH CHECK (user_id = auth.uid());
CREATE POLICY "wishlist_self_delete" ON wishlist
  FOR DELETE USING (user_id = auth.uid());