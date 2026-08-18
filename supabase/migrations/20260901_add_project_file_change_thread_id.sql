-- Confirmed live: project_file_changes never had a thread_id column, so
-- log_judgment_call_from_change() (20260829_add_judgment_calls.sql) could
-- only ever insert judgment_calls rows with thread_id NULL for
-- change_approved/change_rejected. /api/threads/catch-up/route.ts filters
-- its "always surfaced in full, never trimmed" flagged-items query with
-- `.eq("thread_id", threadId)` — which a NULL thread_id can never match, in
-- ANY thread — so despite that route's own comment promising a resolved
-- change "must never quietly vanish" from catch-up, every approved/rejected
-- change silently never appeared there at all. Only 'flagged' rows (which
-- the chat route already inserts with a real thread_id) ever showed up.
-- Nullable and ON DELETE SET NULL, same shape judgment_calls.thread_id
-- already uses — a manual edit proposed from the Project panel (not from
-- within any particular thread's chat) still correctly has no thread to
-- attribute, and stays NULL exactly as before.
ALTER TABLE public.project_file_changes
  ADD COLUMN IF NOT EXISTS thread_id uuid REFERENCES public.threads(id) ON DELETE SET NULL;

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
    (room_id, thread_id, kind, subject_user_id, decided_by, summary, project_file_change_id)
  values (
    v_room_id,
    NEW.thread_id,
    case when NEW.status = 'approved' then 'change_approved' else 'change_rejected' end,
    NEW.proposed_by,
    NEW.reviewed_by,
    coalesce(NEW.summary, 'Proposed change to ' || coalesce(v_path, 'a project file')),
    NEW.id
  );
  return NEW;
end;
$function$;
