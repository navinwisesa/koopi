-- Companion to this session's file-targeting fix: Koopi-authored files no
-- longer all land on one hardcoded "koopi_scratch" path (see
-- app/api/chat/route.ts's chooseFileTarget), so
-- 20260820_fix_koopi_scratch_rls_regression.sql's carve-out — which
-- exempted that one literal path from the Owner/Admin-only UPDATE
-- restriction — no longer matches anything Koopi actually writes to
-- anymore. Replaces the path-literal condition with
-- `last_edited_by IS NULL`, the same "null = Koopi-authored" convention
-- already used everywhere else in this schema (messages.sender_id,
-- project_files.last_edited_by itself), so the exemption follows Koopi's
-- writes regardless of which filename it picks.
--
-- Residual, accepted risk (documented, not silently ignored): WITH CHECK
-- only lets a write through this branch when the write ITSELF sets
-- last_edited_by to NULL. app/api/chat/route.ts always does this for
-- Koopi's own syncs; ProjectPanel.tsx's human save() always sets a real
-- user id instead, so the normal UI can't hit this branch by accident.
-- A Member deliberately crafting a raw API call with last_edited_by: null
-- could still use this to bypass approval — this app has no service-role
-- key configured (confirmed earlier this session), so there's no way to
-- make a write "provably came from my own trusted server code" rather
-- than "any authenticated room participant, however they called it" with
-- only an anon key + user JWT. The threat model here is a member of a
-- room they're already a legitimate collaborator in, not an external
-- attacker — closing this fully needs a service-role key, out of scope
-- for this fix.
-- Note on the DROP target's name: CREATE POLICY silently truncates
-- identifiers past Postgres's 63-byte limit, so the policy this replaces
-- is actually stored (and must be dropped) as
-- "project admins/owners (or koopi's own scratch file) can update " —
-- truncated mid-word, confirmed against the live DB rather than
-- recomputed by hand. The new name below is kept under that limit on
-- purpose so this doesn't recur.
DROP POLICY IF EXISTS "project admins/owners (or koopi's own scratch file) can update " ON public.project_files;
CREATE POLICY "project admins/owners or koopi can update project_files"
  ON public.project_files FOR UPDATE
  USING (can_edit_project_directly(project_id) OR last_edited_by IS NULL)
  WITH CHECK (can_edit_project_directly(project_id) OR last_edited_by IS NULL);
