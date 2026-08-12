-- Supports interactive Project-mode runs (fixes the EOFError input() hit
-- against the old one-shot execute-and-wait call — see
-- app/api/projects/run/route.ts and lib/sandbox.ts's SandboxProjectRun for
-- the actual fix; this migration is just the state it needs).
--
-- Live output itself is NOT persisted incrementally — it streams via
-- Realtime broadcast (same mechanism the room chat's "typing" indicator
-- already uses, not postgres_changes, since per-chunk DB writes for
-- terminal-speed output would be both slow and wasteful). These columns
-- exist only for what has to survive a page refresh or reach a
-- newly-arriving RLS-checked subscriber: who owns the current run's stdin,
-- and a mailbox for delivering stdin to the server process that's actually
-- holding the sandbox open (see the run route's polling ticker).
ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS run_owner_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS pending_stdin text,
  ADD COLUMN IF NOT EXISTS pending_stdin_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL;

-- No RLS change: the existing "room participants can update projects"
-- UPDATE policy already covers these columns, and Run/Stop/stdin-submit
-- are deliberately any-participant actions (unchanged from Phase 1) — this
-- feature doesn't add role gating to run control, only to project_files
-- content. The "only the run's owner can submit stdin" restriction is
-- real, not just a UI nicety, but it's enforced where it actually matters:
-- the run route's ticker only ever *acts* on pending_stdin when
-- pending_stdin_by matches the run_owner_id it captured at claim time —
-- anyone else's write to these columns is silently ignored, not merely
-- hidden in the UI.
