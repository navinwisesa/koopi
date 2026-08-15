-- Fix privacy leak in get_room_memory_messages: it previously pooled messages
-- from every thread in a room into the room-wide memory summary, including
-- 1:1 and other restricted-membership threads, because it filtered only on
-- room_id (via is_room_participant) and never checked thread_participants.
--
-- A thread's messages may now only feed the room-wide memory if every
-- CURRENT room participant is also a participant of that thread — i.e. the
-- thread's audience is a superset of (or equal to) the room's audience.
-- Concretely: nobody who could read the room-wide summary was excluded from
-- the conversation it was built from.
--
-- Implementation note: thread_participants can only be populated with people
-- who were room participants at invite time (create_thread_with_invites
-- enforces that), so a thread's participant set is always a subset of some
-- historical room membership. We inner-join thread_participants to CURRENT
-- participants and require the count of covered current room participants
-- to equal the current room size — subset + equal cardinality implies full
-- coverage, without needing a correlated per-row EXISTS check.
--
-- SECURITY DEFINER is retained deliberately — it's required for this
-- function to read across threads at all (elevated privileges were never
-- the bug). The bug was the missing per-thread membership filter inside it.
CREATE OR REPLACE FUNCTION public.get_room_memory_messages(p_room_id uuid, p_since timestamp with time zone, p_until timestamp with time zone)
 RETURNS TABLE(thread_id uuid, sender_type text, username text, content text, created_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not is_room_participant(p_room_id) then
    raise exception 'not a participant of this room';
  end if;

  return query
    with room_size as (
      select count(*) as n from public.participants where room_id = p_room_id
    ),
    qualifying_threads as (
      select tp.thread_id
      from public.thread_participants tp
      join public.participants rp
        on rp.room_id = p_room_id and rp.user_id = tp.user_id
      group by tp.thread_id
      having count(distinct tp.user_id) = (select n from room_size)
    )
    select m.thread_id, m.sender_type, p.username, m.content, m.created_at
    from public.messages m
    left join public.profiles p on p.id = m.sender_id
    where m.room_id = p_room_id
      and m.type = 'text'
      and m.created_at <= p_until
      and (p_since is null or m.created_at > p_since)
      and m.thread_id in (select qualifying_threads.thread_id from qualifying_threads)
    order by m.created_at asc
    limit 200;
end;
$function$
