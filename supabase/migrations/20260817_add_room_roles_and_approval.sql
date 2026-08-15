-- Phase 3: Owner/Admin/Member role management, attached to `participants`
-- (room membership) — confirmed by Phase 0's audit to be the real
-- room-membership table; the original plan's assumed `room_participants`
-- doesn't exist anywhere in this codebase. Layers approve/reject on top of
-- project_file_changes, added early in 20260816 because Phase 2's AI
-- assistant already needed somewhere for proposals to land.

ALTER TABLE public.participants
  ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'member'
    CHECK (role IN ('owner', 'admin', 'member'));

-- Backfill: whoever created the room is that room's Owner, for every
-- participants row that already exists.
UPDATE public.participants p
SET role = 'owner'
FROM public.rooms r
WHERE p.room_id = r.id
  AND p.user_id = r.created_by
  AND p.role <> 'owner';

-- --- enforcement lives in a trigger, not (only) RLS ----------------------
--
-- Two reasons:
--   1. RLS is row-level, not column-level. This repo already has a
--      participants UPDATE code path (the presence heartbeat in
--      RoomView.tsx, `.eq("user_id", currentUserId)`), which implies *some*
--      "update your own row" policy already exists on this table. That
--      policy isn't migration-tracked and wasn't reachable to inspect this
--      session (no DB access — see the Phase 1 commit message), so this
--      trigger is written to hold regardless of whatever that policy turns
--      out to permit, rather than assuming it's narrow enough to exclude
--      the role column on its own.
--   2. It's also the one enforcement point set_participant_role() below
--      relies on, so the security boundary doesn't depend on the RPC AND a
--      separate RLS policy both being correct — only this trigger has to be.
CREATE OR REPLACE FUNCTION public.enforce_participant_role()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
declare
  v_created_by uuid;
  v_caller_role text;
begin
  select created_by into v_created_by from public.rooms where id = NEW.room_id;

  if TG_OP = 'INSERT' then
    -- The server decides role at join time, never the client: the room
    -- creator is always Owner, everyone else always starts Member.
    -- Promotion to Admin only ever happens afterward, through
    -- set_participant_role().
    NEW.role := (case when NEW.user_id = v_created_by then 'owner' else 'member' end);
    return NEW;
  end if;

  -- TG_OP = 'UPDATE' from here.
  if NEW.role = OLD.role then
    return NEW; -- not a role change (e.g. the presence heartbeat) — nothing to guard.
  end if;

  -- The Owner slot is pinned to whoever created the room, not an assignable
  -- role — avoids an ownerless room by construction, not by convention.
  if OLD.user_id = v_created_by or NEW.role = 'owner' then
    raise exception 'the room owner is fixed at room creation and cannot be reassigned';
  end if;

  select role into v_caller_role
  from public.participants
  where room_id = NEW.room_id and user_id = auth.uid();

  if v_caller_role is distinct from 'owner' then
    raise exception 'only the room owner can change member roles';
  end if;

  return NEW;
end;
$function$;

DROP TRIGGER IF EXISTS participants_enforce_role ON public.participants;
CREATE TRIGGER participants_enforce_role
  BEFORE INSERT OR UPDATE ON public.participants
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_participant_role();

-- Sanctioned promote/demote path — a SECURITY DEFINER RPC rather than a
-- widened participants RLS policy, same reasoning update_room_sandbox
-- already established in 20260812: an Owner needs to update a DIFFERENT
-- participant's row, which the "your own row only" shape every other
-- participants write in this codebase follows would never allow. The
-- trigger above is the actual security boundary either way — this
-- function's own check is belt-and-suspenders, not the only guard.
CREATE OR REPLACE FUNCTION public.set_participant_role(p_room_id uuid, p_user_id uuid, p_role text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
begin
  if p_role NOT IN ('admin', 'member') then
    raise exception 'role must be admin or member';
  end if;

  if not exists (
    select 1 from public.participants
    where room_id = p_room_id and user_id = auth.uid() and role = 'owner'
  ) then
    raise exception 'only the room owner can change member roles';
  end if;

  update public.participants
  set role = p_role
  where room_id = p_room_id and user_id = p_user_id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.get_room_role(p_room_id uuid)
RETURNS text
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path TO 'public'
AS $function$
  SELECT role FROM public.participants WHERE room_id = p_room_id AND user_id = auth.uid();
$function$;

-- --- project_files: direct content writes are now Owner/Admin only ------
--
-- Scope note: this only gates UPDATE (content/language edits). INSERT
-- (creating a new file) and DELETE stay open to any project participant,
-- same as Phase 1 — project_file_changes proposals are inherently about an
-- EXISTING file's content (proposed_content against project_file_id), and
-- scaffolding a new file has no "current content" for a diff-based review
-- to compare against. If Members creating files with arbitrary initial
-- content unreviewed isn't acceptable, that's a deliberate scope call worth
-- revisiting, not an oversight — flagged in the status report.
CREATE OR REPLACE FUNCTION public.can_edit_project_directly(p_project_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path TO 'public'
AS $function$
  SELECT COALESCE(
    (SELECT get_room_role(room_id) IN ('owner', 'admin') FROM public.projects WHERE id = p_project_id),
    false
  );
$function$;

-- Tightens Phase 2's "any project participant can read the whole queue"
-- policy now that role is known: a Member can only ever see their OWN
-- proposals (still enough to satisfy "the proposer can see it was
-- rejected"), never the rest of the team's pending changes — the review
-- queue itself is Owner/Admin-only, enforced here rather than left as a
-- read-everything policy the UI merely chooses not to expose.
DROP POLICY IF EXISTS "project participants can read project_file_changes" ON public.project_file_changes;
CREATE POLICY "own proposals or admin/owner can read project_file_changes"
  ON public.project_file_changes FOR SELECT
  USING (
    proposed_by = auth.uid()
    OR can_edit_project_directly((SELECT project_id FROM public.project_files WHERE id = project_file_id))
  );

DROP POLICY IF EXISTS "project participants can update project_files" ON public.project_files;
CREATE POLICY "project admins/owners can update project_files"
  ON public.project_files FOR UPDATE
  USING (can_edit_project_directly(project_id))
  WITH CHECK (can_edit_project_directly(project_id));

-- Every direct content edit (necessarily by an Owner/Admin now, or by the
-- approve RPC below) gets its own already-approved audit row — Owners/Admins
-- never see a self-approval UI step, but the audit trail exists all the same.
CREATE OR REPLACE FUNCTION public.log_project_file_direct_edit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
begin
  if NEW.content IS NOT DISTINCT FROM OLD.content then
    return NEW; -- language-only change etc — not a content edit worth logging
  end if;
  if current_setting('koopi.skip_change_log', true) = 'true' then
    -- approve_project_file_change() is making this exact write itself and
    -- inserts its own (already-attributed) change row — this trigger firing
    -- too would double-log the same approval.
    return NEW;
  end if;
  insert into public.project_file_changes
    (project_file_id, proposed_by, proposed_content, source, status, reviewed_by, reviewed_at)
  values
    (NEW.id, auth.uid(), NEW.content, 'manual', 'approved', auth.uid(), now());
  return NEW;
end;
$function$;

DROP TRIGGER IF EXISTS project_files_log_direct_edit ON public.project_files;
CREATE TRIGGER project_files_log_direct_edit
  AFTER UPDATE ON public.project_files
  FOR EACH ROW
  EXECUTE FUNCTION public.log_project_file_direct_edit();

-- --- project_file_changes: approve / reject ------------------------------
CREATE OR REPLACE FUNCTION public.approve_project_file_change(p_change_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
declare
  v_project_file_id uuid;
  v_project_id uuid;
  v_content text;
begin
  select project_file_id, proposed_content into v_project_file_id, v_content
  from public.project_file_changes
  where id = p_change_id and status = 'pending';

  if v_project_file_id is null then
    raise exception 'change not found or already reviewed';
  end if;

  select project_id into v_project_id from public.project_files where id = v_project_file_id;
  if not can_edit_project_directly(v_project_id) then
    raise exception 'only a project owner/admin can approve changes';
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

CREATE OR REPLACE FUNCTION public.reject_project_file_change(p_change_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
declare
  v_project_file_id uuid;
  v_project_id uuid;
begin
  select project_file_id into v_project_file_id
  from public.project_file_changes
  where id = p_change_id and status = 'pending';

  if v_project_file_id is null then
    raise exception 'change not found or already reviewed';
  end if;

  select project_id into v_project_id from public.project_files where id = v_project_file_id;
  if not can_edit_project_directly(v_project_id) then
    raise exception 'only a project owner/admin can reject changes';
  end if;

  update public.project_file_changes
  set status = 'rejected', reviewed_by = auth.uid(), reviewed_at = now()
  where id = p_change_id;
end;
$function$;
