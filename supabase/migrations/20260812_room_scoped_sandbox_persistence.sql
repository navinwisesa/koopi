-- Moves run_code sandbox persistence from per-thread to per-room: a project
-- built in one thread should be reachable from a different thread ("chat
-- directory") in the same room, not siloed per-thread. Trades away the
-- thread-level isolation added in 20260811 in exchange for matching the
-- "same project, different chat" mental model — a deliberate, explicit choice
-- (not the default privacy posture used for messages/memory).
--
-- sandbox_id / sandbox_updated_at move from threads to rooms; the thread-level
-- columns are dropped since nothing has shipped depending on them yet.
ALTER TABLE public.threads
  DROP COLUMN IF EXISTS sandbox_id,
  DROP COLUMN IF EXISTS sandbox_updated_at;

ALTER TABLE public.rooms
  ADD COLUMN IF NOT EXISTS sandbox_id text,
  ADD COLUMN IF NOT EXISTS sandbox_updated_at timestamptz;

-- rooms' UPDATE RLS policy is creator-only ("room creators can update their
-- rooms"), same as it already is for personality — any participant needs to
-- be able to persist a sandbox_id after running code, not just the room
-- creator. Mirrors update_room_personality/update_room_memory exactly: a
-- SECURITY DEFINER RPC with its own explicit participant check, rather than
-- widening the RLS policy itself (which would also open name/personality/etc.
-- to every participant, a broader change than this feature needs).
CREATE OR REPLACE FUNCTION public.update_room_sandbox(p_room_id uuid, p_sandbox_id text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
begin
  if not exists (
    select 1 from public.participants
    where room_id = p_room_id and user_id = auth.uid()
  ) then
    raise exception 'not a participant of this room';
  end if;

  update public.rooms
  set sandbox_id = p_sandbox_id,
      sandbox_updated_at = now()
  where id = p_room_id;
end;
$function$;
