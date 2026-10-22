-- ============================================================================
-- CLUVO — Event hero video
-- Adds an optional single video to events, used by the mobile event detail
-- hero (autoplay, muted, looping) with the event image as the fallback. Mirrors
-- image_url: nullable, one URL per event, set by the organizer portal.
-- ============================================================================

alter table events add column if not exists video_url text;
