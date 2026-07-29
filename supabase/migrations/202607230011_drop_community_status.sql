DROP POLICY IF EXISTS communities_public_read ON communities;
ALTER TABLE communities DROP COLUMN IF EXISTS status;
