-- Moat/defensibility layer (PDF §4): a real, queryable "judgment call track
-- record" — every time Koopi's evaluative stance actually flagged a
-- disagreement/risk, and every time a human resolved a proposed change
-- (approved or rejected), lands here as one row. This is the seed of
-- per-person "hand-off reliability" too: a member's approved-vs-rejected
-- ratio, computed from this same table, is the honest starting point for
-- that reputation — deliberately NOT a fabricated score, just the raw
-- record accruing from here on, same "needs real usage data first"
-- reasoning the original plan itself called for.
CREATE TABLE IF NOT EXISTS public.judgment_calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id uuid NOT NULL REFERENCES public.rooms(id) ON DELETE CASCADE,
  thread_id uuid REFERENCES public.threads(id) ON DELETE SET NULL,
  kind text NOT NULL CHECK (kind IN ('flagged', 'change_approved', 'change_rejected')),
  -- Whose work/statement this call is ABOUT — the flagged message's
  -- sender, or the change's original proposer. Null when it's Koopi's own
  -- content (no profiles row), same null-means-Koopi convention
  -- messages.sender_id/project_files.last_edited_by already use.
  subject_user_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  -- Who made the call — null for 'flagged' (that's Koopi's own judgment,
  -- not yet a human decision), the reviewer for change_approved/rejected.
  decided_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  summary text NOT NULL,
  message_id uuid REFERENCES public.messages(id) ON DELETE SET NULL,
  project_file_change_id uuid REFERENCES public.project_file_changes(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.judgment_calls ENABLE ROW LEVEL SECURITY;

-- Visibility is a squad-level trust asset, not a private one — unlike
-- project_file_changes (where a Member only sees their own pending
-- proposals pre-approval), the whole point of a track record is that
-- everyone in the room can see it, the same way a public commit history
-- would be. Any room participant can read every row.
CREATE POLICY "room participants can read judgment_calls"
  ON public.judgment_calls FOR SELECT
  USING (is_room_participant(room_id));

-- Server-side chat-route inserts (for 'flagged') run as whichever user's
-- session triggered that turn — any room participant may log a flagged
-- call for their own room. change_approved/change_rejected rows are never
-- inserted this way at all (see the trigger below), so this policy only
-- ever actually applies to 'flagged'.
CREATE POLICY "room participants can insert judgment_calls"
  ON public.judgment_calls FOR INSERT
  WITH CHECK (is_room_participant(room_id));

ALTER TABLE public.judgment_calls REPLICA IDENTITY FULL;
ALTER PUBLICATION supabase_realtime ADD TABLE public.judgment_calls;

-- Auto-logs a judgment_calls row the moment approve_project_file_change/
-- reject_project_file_change (20260817_add_room_roles_and_approval.sql)
-- actually resolves a proposal — same "trigger observes the state
-- transition, not the RPC" shape log_project_file_direct_edit already
-- established, so this can never drift out of sync with approvals that
-- happen through any future path, only this one.
CREATE OR REPLACE FUNCTION public.log_judgment_call_from_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
declare
  v_room_id uuid;
  v_path text;
begin
  if NEW.status = OLD.status or NEW.status = 'pending' then
    return NEW; -- not a resolution (e.g. the summary landing later) — nothing to log
  end if;

  select p.room_id, pf.path into v_room_id, v_path
  from public.project_files pf
  join public.projects p on p.id = pf.project_id
  where pf.id = NEW.project_file_id;

  if v_room_id is null then
    return NEW; -- file/project already gone — nothing sensible to attribute this to
  end if;

  insert into public.judgment_calls
    (room_id, kind, subject_user_id, decided_by, summary, project_file_change_id)
  values (
    v_room_id,
    case when NEW.status = 'approved' then 'change_approved' else 'change_rejected' end,
    NEW.proposed_by,
    NEW.reviewed_by,
    coalesce(NEW.summary, 'Proposed change to ' || coalesce(v_path, 'a project file')),
    NEW.id
  );
  return NEW;
end;
$function$;

DROP TRIGGER IF EXISTS project_file_changes_log_judgment_call ON public.project_file_changes;
CREATE TRIGGER project_file_changes_log_judgment_call
  AFTER UPDATE ON public.project_file_changes
  FOR EACH ROW
  EXECUTE FUNCTION public.log_judgment_call_from_change();
