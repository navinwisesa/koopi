-- Project Mode: replaces the single-file-per-thread `thread_files` code panel
-- with a room-scoped, multi-file collaborative project. Scoped to the ROOM
-- (not a thread) so a whole squad works on one shared project regardless of
-- which chat thread they're in — same "chat directory" mental model
-- 20260812_room_scoped_sandbox_persistence.sql already established for
-- rooms.sandbox_id.
--
-- `thread_files` is deliberately NOT dropped here. This repo has no
-- migration-tracked base schema and no accessible DB connection at
-- migration-authoring time to confirm whether it holds real user data worth
-- preserving vs. only test rows — dropping it would be a silent, irreversible
-- guess about someone else's data. It's simply unused by the app after this
-- change (see the app-code changes in the same commit); drop it in a follow-up
-- migration once a human confirms it's safe to discard.
--
-- One project per room for now, enforced by UNIQUE(room_id) below — same
-- "single row, unique-constrained on the parent" shape thread_files used for
-- single-file-per-thread. If multiple concurrent projects per room are wanted
-- later, the intended path is dropping that constraint, exactly as
-- 20260813_add_thread_files.sql documented for its own eventual multi-file
-- migration (which this migration is).
CREATE TABLE IF NOT EXISTS public.projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id uuid NOT NULL REFERENCES public.rooms(id) ON DELETE CASCADE,
  name text NOT NULL DEFAULT 'Project',
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Run state lives on the project row, not a separate table — mirrors
  -- thread_files' reasoning exactly (one project has one "current run" of
  -- whichever file is the entry point; a second table would only add a join
  -- with no isolation benefit). Same CAS idle/running flag, polled the same
  -- way messages.status and thread_files.run_status already are.
  run_status text NOT NULL DEFAULT 'idle' CHECK (run_status IN ('idle', 'running')),
  run_entry_path text,
  last_run_stdout text,
  last_run_stderr text,
  last_run_exit_code integer,
  last_run_at timestamptz,
  last_run_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT projects_room_id_key UNIQUE (room_id)
);

-- Multiple files per project, flat or nested path (e.g. "src/index.py").
CREATE TABLE IF NOT EXISTS public.project_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  path text NOT NULL,
  content text NOT NULL DEFAULT '',
  language text NOT NULL DEFAULT 'python',
  last_edited_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT project_files_project_id_path_key UNIQUE (project_id, path)
);

ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_files ENABLE ROW LEVEL SECURITY;

-- Reuses the existing is_room_participant() SECURITY DEFINER helper
-- (base schema, already relied on by 20260807_fix_room_memory_thread_privacy.sql
-- and update_room_sandbox) rather than duplicating the membership check.
CREATE POLICY "room participants can read projects"
  ON public.projects FOR SELECT
  USING (is_room_participant(room_id));

CREATE POLICY "room participants can insert projects"
  ON public.projects FOR INSERT
  WITH CHECK (is_room_participant(room_id));

CREATE POLICY "room participants can update projects"
  ON public.projects FOR UPDATE
  USING (is_room_participant(room_id))
  WITH CHECK (is_room_participant(room_id));

-- Deliberately no DELETE policy on projects yet — "delete the project" is
-- specced as an Owner-only action, and roles don't exist until the next
-- migration. No policy means RLS denies all deletes by default in the
-- meantime, which is the safe default (nobody can drop the shared project
-- out from under a room), not an oversight.

-- Small helper so project_files' policies don't need to know about rooms at
-- all — same one-hop indirection is_thread_participant() gives thread_files.
CREATE OR REPLACE FUNCTION public.is_project_participant(p_project_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path TO 'public'
AS $function$
  SELECT is_room_participant(room_id) FROM public.projects WHERE id = p_project_id;
$function$;

CREATE POLICY "project participants can read project_files"
  ON public.project_files FOR SELECT
  USING (is_project_participant(project_id));

CREATE POLICY "project participants can insert project_files"
  ON public.project_files FOR INSERT
  WITH CHECK (is_project_participant(project_id));

CREATE POLICY "project participants can update project_files"
  ON public.project_files FOR UPDATE
  USING (is_project_participant(project_id))
  WITH CHECK (is_project_participant(project_id));

CREATE POLICY "project participants can delete project_files"
  ON public.project_files FOR DELETE
  USING (is_project_participant(project_id));

-- Realtime: same explicit REPLICA IDENTITY FULL + publication membership
-- 20260813_add_thread_files.sql started doing for new tables.
ALTER TABLE public.projects REPLICA IDENTITY FULL;
ALTER TABLE public.project_files REPLICA IDENTITY FULL;
ALTER PUBLICATION supabase_realtime ADD TABLE public.projects;
ALTER PUBLICATION supabase_realtime ADD TABLE public.project_files;
