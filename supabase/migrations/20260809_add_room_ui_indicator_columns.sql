-- UI-indicator support columns (room-memory/evaluative-stance badges, per-thread unread state).
--
-- messages.used_room_memory / messages.flagged: set by /api/chat after a lightweight,
-- best-effort classification pass on the assistant's own completed reply (never on the raw
-- presence of room memory in the prompt — a room accrues a memory_summary almost immediately,
-- so "was memory available" would be true on nearly every message and the badge would stop
-- meaning anything). Both default false so a classification failure/skip never shows a false
-- badge.
--
-- thread_participants.last_read_at: when the current user last viewed a given thread. Nullable
-- — null means "never opened", so any message in that thread counts as unread for them.
ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS used_room_memory boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS flagged boolean NOT NULL DEFAULT false;

ALTER TABLE public.thread_participants
  ADD COLUMN IF NOT EXISTS last_read_at timestamp with time zone;

-- No UPDATE policy existed on thread_participants before this (only INSERT/DELETE by the
-- thread creator, and SELECT by participants) — a user marking their own thread as read had
-- nowhere to write. Scoped to their own row only, same shape as the existing "users can update
-- their own participant row" policy on `participants`.
CREATE POLICY "participants can update their own thread_participants row"
  ON public.thread_participants
  FOR UPDATE
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());
