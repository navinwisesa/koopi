-- Live web-app preview state, mirroring the shape run_status/run_entry_path/
-- last_run_* already established on this same table (20260815_add_projects.sql)
-- for the "run a single script to completion" flow. Preview is a DIFFERENT
-- lifecycle — a dev/static server that's meant to keep running, not exit —
-- so it gets its own status column rather than overloading run_status
-- ('running' already means something specific: "a script is executing and
-- someone may be feeding it stdin", which doesn't describe a live server at
-- all). One project has at most one live preview at a time, same
-- one-row-per-project shape as the run_* columns.
ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS preview_status text NOT NULL DEFAULT 'idle'
    CHECK (preview_status IN ('idle', 'starting', 'running', 'error')),
  ADD COLUMN IF NOT EXISTS preview_url text,
  ADD COLUMN IF NOT EXISTS preview_error text,
  ADD COLUMN IF NOT EXISTS preview_sandbox_id text,
  ADD COLUMN IF NOT EXISTS preview_framework text,
  ADD COLUMN IF NOT EXISTS preview_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS preview_updated_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL;

-- No new RLS policy needed — the existing "room participants can update
-- projects" policy (20260815_add_projects.sql) already covers UPDATE on
-- this table for any project participant, and these are plain status/URL
-- columns, not the sensitive project_files content path that later needed
-- Owner/Admin gating.
