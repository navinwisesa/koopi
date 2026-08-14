-- Phase 3 of the debugging-tools build: role-aware change notifications.
-- Builds directly on project_file_changes (20260816) and the Owner/Admin
-- role model (20260817) — no new table, just a place to put an AI-generated
-- plain-language summary alongside the diff that's already there.
--
-- NOT YET APPLIED — authored without a live DB connection this session,
-- same standing limitation every migration in this repo has been written
-- under (see 20260815_add_projects.sql's own note, and this session's
-- earlier 20260823_add_message_attachments.sql). Nothing reading or writing
-- this column works until it's applied.
ALTER TABLE public.project_file_changes
  ADD COLUMN IF NOT EXISTS summary text;

-- Nullable and best-effort by design, not required — a summary is generated
-- asynchronously, after the proposal row itself already exists (see
-- app/api/projects/summarize-change/route.ts), so every pending change
-- briefly has summary = NULL between being proposed and the summary landing
-- a moment later via realtime. The Pending panel falls back to "Summary
-- pending…" for that gap rather than blocking the proposal on it — a slow
-- or failed summary call must never be why a Member's change doesn't show
-- up for review.

-- No plain UPDATE policy on project_file_changes exists at all (20260816
-- deliberately left it that way — "no take-backs" on status/review fields
-- from a bare client write). Writing the summary needs its own narrow
-- carve-out rather than a general UPDATE policy that would also reopen
-- status/reviewed_by to direct tampering — same SECURITY DEFINER RPC shape
-- approve_project_file_change/reject_project_file_change already use for
-- "needs write access wider than a plain row-owner policy allows".
CREATE OR REPLACE FUNCTION public.set_project_file_change_summary(p_change_id uuid, p_summary text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
declare
  v_project_file_id uuid;
begin
  select project_file_id into v_project_file_id
  from public.project_file_changes
  where id = p_change_id;

  if v_project_file_id is null or not is_project_file_participant(v_project_file_id) then
    raise exception 'not authorized to summarize this change';
  end if;

  update public.project_file_changes
  set summary = p_summary
  where id = p_change_id;
end;
$function$;
