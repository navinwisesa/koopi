-- Stable per-project preview URL (middleware.ts + app/api/_preview-proxy):
-- the whole point is that a demo link keeps working across sandbox
-- swaps, exactly matching how the raw e2b sandbox URL it replaces already
-- worked today — anyone with the (unguessable UUID) link can view it, no
-- Koopi session required. `projects` SELECT is participant-gated
-- ("room participants can read projects", 20260815_add_projects.sql), so a
-- visitor with no Koopi session at all would get zero rows back and the
-- proxy would wrongly report "not running" even when it genuinely is.
--
-- This is a narrow, read-only, SECURITY DEFINER escape hatch — same
-- established shape as get_room_role/can_edit_project_directly — that
-- deliberately bypasses RLS for exactly two fields, nothing else about the
-- project (not room_id, not file contents, nothing). It does not widen who
-- can SEE a project's data in the app; it only lets an anonymous proxy
-- request learn "is this specific already-known project id's preview
-- running, and if so, which sandbox" — the same two facts the raw sandbox
-- link already exposed to anyone holding it.
CREATE OR REPLACE FUNCTION public.get_preview_target(p_project_id uuid)
RETURNS TABLE(sandbox_id text, status text)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path TO 'public'
AS $function$
  SELECT preview_sandbox_id, preview_status
  FROM public.projects
  WHERE id = p_project_id;
$function$;
