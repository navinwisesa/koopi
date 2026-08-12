-- Persistent, collaborative code panel — one row per thread for now. The unique
-- constraint on thread_id is what encodes "single file per thread"; the intended
-- path to multi-file later is dropping this constraint and adding a path/filename
-- column, not a rewrite.
--
-- Run state (run_status/last_run_*) lives on this same row rather than a second
-- table: one thread has one file has one "current run", so a second table would
-- only add a join with no isolation benefit. run_status is a two-value CAS flag
-- ('idle' | 'running') polled exactly the way messages.status = 'streaming' is
-- already polled by isStillStreaming() in app/api/chat/route.ts — Stop is simply
-- setting run_status back to 'idle', which the running request's ticker detects
-- via the same conditional-UPDATE-returns-0-rows trick, so no separate
-- cancel-requested flag is needed.
CREATE TABLE IF NOT EXISTS public.thread_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id uuid NOT NULL REFERENCES public.threads(id) ON DELETE CASCADE,
  content text NOT NULL DEFAULT '',
  language text NOT NULL DEFAULT 'python',
  last_edited_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  run_status text NOT NULL DEFAULT 'idle' CHECK (run_status IN ('idle', 'running')),
  last_run_stdout text,
  last_run_stderr text,
  last_run_exit_code integer,
  last_run_at timestamptz,
  last_run_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT thread_files_thread_id_key UNIQUE (thread_id)
);

ALTER TABLE public.thread_files ENABLE ROW LEVEL SECURITY;

-- Same access pattern as messages/thread_participants: reuse the existing
-- is_thread_participant() SECURITY DEFINER helper, no widened policy needed.
-- Unlike rooms.sandbox_id (creator-only UPDATE, requiring the update_room_sandbox
-- RPC), thread_files has no such restriction — any participant can read/write
-- directly, so Save/Cancel are plain client-side .update()/.upsert() calls, no
-- RPC required for this table.
CREATE POLICY "thread participants can read thread_files"
  ON public.thread_files FOR SELECT
  USING (is_thread_participant(thread_id));

CREATE POLICY "thread participants can insert thread_files"
  ON public.thread_files FOR INSERT
  WITH CHECK (is_thread_participant(thread_id));

CREATE POLICY "thread participants can update thread_files"
  ON public.thread_files FOR UPDATE
  USING (is_thread_participant(thread_id))
  WITH CHECK (is_thread_participant(thread_id));

-- Only for FK-cascade safety when a thread is deleted elsewhere in the app —
-- nothing in this feature deletes a row directly.
CREATE POLICY "thread participants can delete thread_files"
  ON public.thread_files FOR DELETE
  USING (is_thread_participant(thread_id));

-- No migration in this repo currently versions supabase_realtime publication
-- membership at all (a pre-existing, undocumented gap across all 5 existing
-- realtime tables). This is the first migration to do so properly, and sets
-- REPLICA IDENTITY FULL to match the majority precedent (thread_participants,
-- threads, participants) — delivers old-row values on UPDATE, useful for
-- detecting exactly what changed (e.g. run_status flipping) client-side.
ALTER TABLE public.thread_files REPLICA IDENTITY FULL;
ALTER PUBLICATION supabase_realtime ADD TABLE public.thread_files;
