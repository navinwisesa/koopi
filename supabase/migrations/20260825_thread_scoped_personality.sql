-- Moves Koopi's response-style personality from room-wide to per-thread, so
-- different threads in the same room can run different active styles
-- independently (e.g. a "quick answers" thread set to Concise alongside a
-- "walk me through it" thread set to Explanatory in the same room).
--
-- rooms.personality and update_room_personality() are untracked base schema
-- (added before this migration history began, same category as rooms.name,
-- threads itself, messages, participants — several base tables/columns in
-- this project have never had a tracked migration; confirmed by grepping
-- every migration file for both names and finding zero CREATE/ALTER). This
-- migration can't drop that column here for the same reason 20260815 gave
-- for not dropping thread_files: no live DB connection at authoring time to
-- confirm anything currently reads it that this migration doesn't already
-- know about. It's simply unused by the app after this change (see the same
-- commit's app-code changes) — safe to drop in a follow-up once a human
-- confirms nothing else depends on it.
--
-- NOT YET APPLIED — authored without a live DB connection this session,
-- same standing limitation as every other migration written tonight.

ALTER TABLE public.threads
  ADD COLUMN IF NOT EXISTS personality text NOT NULL DEFAULT 'default'
    CHECK (personality IN ('default', 'concise', 'explanatory', 'casual', 'direct'));

-- Migration for EXISTING threads: start each thread at whatever its room is
-- currently set to, rather than resetting every thread to 'default' the
-- moment this lands — matches the task's own instruction ("nothing resets
-- to Default unexpectedly"). Only threads still sitting at the column's own
-- default get backfilled, so this is safe to re-run and never clobbers a
-- value some other process already set between this migration being
-- authored and applied.
UPDATE public.threads t
SET personality = r.personality
FROM public.rooms r
WHERE t.room_id = r.id
  AND t.personality = 'default'
  AND r.personality IS NOT NULL
  AND r.personality <> 'default';

-- Sanctioned write path — mirrors update_room_personality's own shape
-- (SECURITY DEFINER RPC, not a widened UPDATE policy on threads, since
-- threads' existing "your own row"-style policies, whatever they turn out
-- to be under the hood, weren't reachable to inspect this session either).
-- is_thread_participant() already exists (referenced by 20260813's own
-- policies) — same untracked-base-schema helper, not redefined here.
CREATE OR REPLACE FUNCTION public.update_thread_personality(p_thread_id uuid, p_personality text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
begin
  if p_personality NOT IN ('default', 'concise', 'explanatory', 'casual', 'direct') then
    raise exception 'invalid personality value';
  end if;

  if not is_thread_participant(p_thread_id) then
    raise exception 'not authorized to change this thread''s personality';
  end if;

  update public.threads
  set personality = p_personality
  where id = p_thread_id;
end;
$function$;
