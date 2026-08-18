-- Rooms had create/read/update policies but no DELETE policy at all — no
-- policy means RLS denies every delete by default (confirmed live against
-- this project: zero rows in pg_policy for rooms with polcmd = 'd'), so
-- there was never a way to delete a room from the app, not even for its
-- own creator. Same "room creators" condition the existing UPDATE policy
-- ("room creators can update their rooms") already uses — deleting is an
-- owner-only action here for the same reason changing a member's role is:
-- the creator is the one fixed, non-transferable owner of a room.
--
-- Confirmed safe to cascade: every table with a room_id foreign key
-- (participants, messages, room_invites, threads, projects,
-- message_attachments, judgment_calls) already has ON DELETE CASCADE on
-- that key, checked live against pg_constraint before writing this — a
-- room delete cleanly removes everything hanging off it in Postgres.
--
-- NOT covered by this (documented, not silently ignored): actual files in
-- the `message-attachments` STORAGE bucket aren't Postgres rows, so
-- cascading message_attachments deletes the DB rows but not the underlying
-- objects in storage — those become orphaned. Cleaning that up needs a
-- separate step (e.g. an Edge Function or a pre-delete client-side sweep of
-- the room's storage prefix) that's out of scope for "add the ability to
-- delete a room" specifically.
CREATE POLICY "room creators can delete their rooms"
  ON public.rooms FOR DELETE
  USING (created_by = auth.uid());
