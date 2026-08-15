-- Replaces the @Koopi mention-tagging trigger with a per-user, per-thread toggle.
-- Default true matches the old "always available" behavior of tagging — nobody who
-- didn't touch the toggle sees a behavior change.
--
-- No new RLS policy needed: the "participants can update their own thread_participants
-- row" UPDATE policy added in 20260809_add_room_ui_indicator_columns.sql already covers
-- this column (RLS is row-level, not column-level).
ALTER TABLE public.thread_participants
  ADD COLUMN IF NOT EXISTS koopi_active boolean NOT NULL DEFAULT true;
