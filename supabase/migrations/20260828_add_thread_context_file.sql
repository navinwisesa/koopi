-- Backs "Discuss this file": a thread can be scoped to a single project file,
-- so the chat route can inject that file's content into the thread's system
-- prompt (same private-thread mechanism 20260807_fix_room_memory_thread_privacy.sql
-- already relies on for privacy — a thread's visibility is entirely a function
-- of who's a thread_participant, and a "Discuss this file" thread is created
-- with zero invitees, i.e. private to its creator by construction). ON DELETE
-- SET NULL: if the file is later deleted, the thread itself is real
-- conversation history and should survive — it just stops injecting context.
ALTER TABLE public.threads
  ADD COLUMN IF NOT EXISTS context_project_file_id uuid
    REFERENCES public.project_files(id) ON DELETE SET NULL;

-- create_thread_with_invites is NOT migration-tracked anywhere in this repo
-- (part of an untracked base schema — same gap earlier migrations' own
-- comments flag for other objects) — this session has no DB connection to
-- read its current body, so CREATE OR REPLACE-ing it blind risks silently
-- dropping logic that isn't visible here. A small additive RPC sidesteps
-- that entirely: the client calls create_thread_with_invites exactly as
-- before, then this, with the id it got back. SECURITY DEFINER is required
-- for the same reason update_thread_personality needs it (RLS on `threads`
-- is not known to allow a plain client-side UPDATE here); the actual
-- authorization is the explicit creator check below, not the elevated
-- privilege.
CREATE OR REPLACE FUNCTION public.set_thread_context_file(p_thread_id uuid, p_context_project_file_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
begin
  if not exists (
    select 1 from public.threads where id = p_thread_id and created_by = auth.uid()
  ) then
    raise exception 'only the thread creator can set its file context';
  end if;

  if p_context_project_file_id is not null and not exists (
    select 1 from public.project_files where id = p_context_project_file_id
  ) then
    raise exception 'project file not found';
  end if;

  update public.threads
  set context_project_file_id = p_context_project_file_id
  where id = p_thread_id;
end;
$function$;
