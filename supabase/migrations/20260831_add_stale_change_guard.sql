-- Closes a real gap in approve_project_file_change (20260817_add_room_roles_
-- and_approval.sql): it always wrote proposed_content verbatim with no check
-- against the file's CURRENT content, so approving a Member's proposal could
-- silently clobber a newer direct edit (or a different already-approved
-- change) made to the same file after this proposal was submitted but before
-- it got reviewed — no warning, no conflict flag, just quietly gone. project_
-- files.updated_at is bumped by every path that ever changes .content (a
-- direct Owner/Admin edit, AND this same function's own UPDATE on an earlier
-- approval), so "file's updated_at is newer than this change's created_at"
-- is exactly "something landed on this file since this proposal was made" —
-- no new column needed to detect it.
--
-- p_force lets a reviewer proceed anyway once they've seen the warning (the
-- client computes and shows staleness itself, from data it already has —
-- see ProjectChanges.tsx's isStale — so the RPC's own check here is the
-- backend backstop, not the only place this is surfaced). Defaults to false
-- so any caller that doesn't know about this yet (there isn't one today, but
-- nothing requires that) keeps getting the safe behavior.
CREATE OR REPLACE FUNCTION public.approve_project_file_change(p_change_id uuid, p_force boolean DEFAULT false)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
declare
  v_project_file_id uuid;
  v_project_id uuid;
  v_content text;
  v_change_created_at timestamptz;
  v_file_updated_at timestamptz;
begin
  select project_file_id, proposed_content, created_at
    into v_project_file_id, v_content, v_change_created_at
  from public.project_file_changes
  where id = p_change_id and status = 'pending';

  if v_project_file_id is null then
    raise exception 'change not found or already reviewed';
  end if;

  select project_id, updated_at into v_project_id, v_file_updated_at
  from public.project_files where id = v_project_file_id;

  if not can_edit_project_directly(v_project_id) then
    raise exception 'only a project owner/admin can approve changes';
  end if;

  -- Fixed, greppable message (not a generic sentence) so the client can
  -- reliably tell "stale, needs confirmation" apart from every other
  -- failure reason instead of string-matching prose.
  if not p_force and v_file_updated_at > v_change_created_at then
    raise exception 'STALE_CHANGE';
  end if;

  perform set_config('koopi.skip_change_log', 'true', true); -- transaction-local, no manual reset needed
  update public.project_files
  set content = v_content, last_edited_by = auth.uid(), updated_at = now()
  where id = v_project_file_id;

  update public.project_file_changes
  set status = 'approved', reviewed_by = auth.uid(), reviewed_at = now()
  where id = p_change_id;
end;
$function$;

-- Same p_force, passed through to every row — a batch stays all-or-nothing
-- (20260827_add_project_file_change_batch.sql's own comment): one stale file
-- anywhere in the batch aborts the whole transaction rather than silently
-- approving the other N-1 files and skipping just that one, so "Approve all"
-- never quietly overwrites a single file while claiming full success.
CREATE OR REPLACE FUNCTION public.approve_project_file_change_batch(p_batch_id uuid, p_force boolean DEFAULT false)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
declare
  v_change record;
begin
  for v_change in
    select id from public.project_file_changes
    where batch_id = p_batch_id and status = 'pending'
  loop
    perform public.approve_project_file_change(v_change.id, p_force);
  end loop;
end;
$function$;
