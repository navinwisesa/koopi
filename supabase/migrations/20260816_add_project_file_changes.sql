-- Pulled forward from Phase 3 of the room-role-management plan: Phase 2 (the
-- per-user AI coding assistant) has its own test gate requiring that an
-- accepted AI suggestion land as a pending proposal and NEVER write
-- project_files directly, even before role management exists. That's this
-- table. Phase 3 adds the `role` column elsewhere and the Owner/Admin
-- review-queue UI on top of what's created here — this migration only adds
-- the table, propose-only RLS, and realtime wiring; approve/reject UPDATE
-- access is deliberately withheld until Phase 3 can gate it by role.
CREATE TABLE IF NOT EXISTS public.project_file_changes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_file_id uuid NOT NULL REFERENCES public.project_files(id) ON DELETE CASCADE,
  proposed_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  proposed_content text NOT NULL,
  source text NOT NULL CHECK (source IN ('manual', 'ai_assistant')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  reviewed_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.project_file_changes ENABLE ROW LEVEL SECURITY;

-- Same one-hop-to-room-membership shape as is_project_participant(), just
-- starting from a file instead of the project directly.
CREATE OR REPLACE FUNCTION public.is_project_file_participant(p_project_file_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path TO 'public'
AS $function$
  SELECT is_project_participant(project_id) FROM public.project_files WHERE id = p_project_file_id;
$function$;

-- Any participant can see the proposal queue for their project — needed both
-- so a proposer can watch their own change get approved/rejected (Phase 3's
-- "the proposer can see it was rejected" requirement) and so Phase 3's
-- Owner/Admin review-queue UI has something to read. Visibility isn't the
-- sensitive part here; writing is.
CREATE POLICY "project participants can read project_file_changes"
  ON public.project_file_changes FOR SELECT
  USING (is_project_file_participant(project_file_id));

-- Anyone in the project can PROPOSE a change (manual or AI-assisted) —
-- that's the whole point of a Member-safe proposal queue. proposed_by must
-- be the caller, so nobody can submit a change credited to someone else.
CREATE POLICY "project participants can insert their own project_file_changes"
  ON public.project_file_changes FOR INSERT
  WITH CHECK (is_project_file_participant(project_file_id) AND proposed_by = auth.uid());

-- Deliberately no UPDATE policy yet — approving/rejecting requires knowing
-- who's an Owner/Admin, which doesn't exist until Phase 3's role column and
-- helper land. No policy means RLS denies all updates in the meantime,
-- which is the safe default: a pending proposal cannot be silently
-- self-approved by anyone before the review workflow actually exists.

ALTER TABLE public.project_file_changes REPLICA IDENTITY FULL;
ALTER PUBLICATION supabase_realtime ADD TABLE public.project_file_changes;
