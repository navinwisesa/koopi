-- Lets Koopi's run_code tool persist state across calls within the same thread,
-- instead of tearing down a fresh sandbox every time. Scoped per-thread (not
-- per-room) because threads are already the established privacy/context
-- boundary for everything else (memory, participants) — a thread's sandbox is
-- its own working environment, not shared with sibling threads in the room.
--
-- sandbox_id: the E2B sandbox ID to reconnect to (via Sandbox.connect, which
-- auto-resumes a paused sandbox) on the next run_code call in this thread.
-- Null until the thread's first run_code call.
--
-- sandbox_updated_at: when the sandbox was last used — informational only for
-- now (surfacing staleness, debugging), not read by any code path yet.
--
-- No new RLS policy needed: the existing "participants can update room
-- threads" UPDATE policy already covers any column on this row (RLS is
-- row-level, not column-level).
ALTER TABLE public.threads
  ADD COLUMN IF NOT EXISTS sandbox_id text,
  ADD COLUMN IF NOT EXISTS sandbox_updated_at timestamptz;
