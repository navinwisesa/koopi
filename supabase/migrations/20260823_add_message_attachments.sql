-- Multimodal input (Phase 1 of the debugging-tools build): lets a chat
-- message carry image/PDF attachments, stored in Supabase Storage with a
-- row here per file so the transcript and /api/chat can both find them.
--
-- room_id is denormalized from the parent message (not just derivable via a
-- join) for two concrete reasons, matching the precedent messages.room_id +
-- messages.thread_id already set: (1) Realtime's postgres_changes filter is
-- plain column equality, no join — without this column the room's live
-- channel couldn't filter to just its own attachments; (2) the storage
-- policies below key off it directly rather than a subquery through
-- messages, keeping them a single indexed lookup.
--
-- NOTE (write this down, don't apply-and-forget): this migration was
-- authored without a live DB connection this session (same standing
-- limitation every migration in this repo has been written under — see
-- 20260815_add_projects.sql's own note) — it has NOT been applied. Nothing
-- depending on it (the composer's attach button, /api/chat's vision path)
-- will work until it is.
CREATE TABLE IF NOT EXISTS public.message_attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id uuid NOT NULL REFERENCES public.messages(id) ON DELETE CASCADE,
  room_id uuid NOT NULL REFERENCES public.rooms(id) ON DELETE CASCADE,
  -- Path within the `message-attachments` storage bucket, always
  -- "{room_id}/{message_id}/{filename}" — see the storage policies below,
  -- which parse this same shape back out of storage.objects.name.
  storage_path text NOT NULL,
  filename text NOT NULL,
  mime_type text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('image', 'pdf')),
  byte_size integer,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.message_attachments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "room participants can read message_attachments"
  ON public.message_attachments FOR SELECT
  USING (is_room_participant(room_id));

-- Whoever's attaching a file must be the sender of the message it's
-- attached to (not just any room participant) — mirrors
-- project_file_changes' "proposed_by = auth.uid()" shape: you can only ever
-- attach to your own message, never graft a file onto someone else's.
CREATE POLICY "message sender can attach message_attachments"
  ON public.message_attachments FOR INSERT
  WITH CHECK (
    is_room_participant(room_id)
    AND EXISTS (
      SELECT 1 FROM public.messages m
      WHERE m.id = message_id AND m.sender_id = auth.uid() AND m.room_id = message_attachments.room_id
    )
  );

-- No UPDATE/DELETE policy — an attachment is immutable once sent, same
-- "no take-backs on a sent message" shape the base messages table already
-- has (no delete path there either). RLS denies both by default.

ALTER TABLE public.message_attachments REPLICA IDENTITY FULL;
ALTER PUBLICATION supabase_realtime ADD TABLE public.message_attachments;

-- Storage: a private bucket (not public — every read still goes through the
-- policies below, same as every table in this schema going through RLS).
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'message-attachments',
  'message-attachments',
  false,
  20971520, -- 20MB — generous for a screenshot or a short spec PDF, not unbounded
  ARRAY['image/png', 'image/jpeg', 'image/webp', 'application/pdf']
)
ON CONFLICT (id) DO NOTHING;

-- Objects are always uploaded to "{room_id}/{message_id}/{filename}" (see
-- the composer upload code in RoomView.tsx) — storage.foldername(name)[1]
-- is that leading room_id segment, cast to uuid and checked against
-- room membership the same way every other table here is.
CREATE POLICY "room participants can read message-attachments objects"
  ON storage.objects FOR SELECT
  USING (
    bucket_id = 'message-attachments'
    AND is_room_participant((storage.foldername(name))[1]::uuid)
  );

CREATE POLICY "room participants can upload message-attachments objects"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'message-attachments'
    AND is_room_participant((storage.foldername(name))[1]::uuid)
  );

-- No UPDATE/DELETE storage policy either, for the same "sent is sent"
-- reason as the table above.
