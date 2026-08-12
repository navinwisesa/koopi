-- Fixes a live regression from 20260817_add_room_roles_and_approval.sql:
-- restricting project_files UPDATE to Owner/Admin accidentally also blocked
-- Koopi's own "koopi_scratch" auto-save (app/api/chat/route.ts's
-- syncProjectFile) whenever the chatting user is a plain Member — caught
-- live in the dev server's own logs (42501, RLS violation) while working
-- on an unrelated task, not from a report.
--
-- koopi_scratch was always meant to be freely writable by anyone in the
-- room (Phase 1's original design: Koopi's own scratch file, not
-- "content a team is collaboratively reviewing"), so this restores that —
-- it's reverting an accidental over-restriction back to intentional Phase 1
-- behavior for this one system-managed path, not opening a new hole. A
-- Member could already freely overwrite this exact file before Phase 3
-- existed at all.
--
-- Scoped to the literal path so it can't be used to dodge approval on any
-- other file — the only way to exploit this is to name your own file
-- "koopi_scratch" and accept that it behaves like Koopi's scratch file
-- (unreviewed direct writes) instead of a normal reviewed one, which is a
-- narrow, self-inflicted edge case, not a privilege escalation.
DROP POLICY IF EXISTS "project admins/owners can update project_files" ON public.project_files;
CREATE POLICY "project admins/owners (or koopi's own scratch file) can update project_files"
  ON public.project_files FOR UPDATE
  USING (can_edit_project_directly(project_id) OR path = 'koopi_scratch')
  WITH CHECK (can_edit_project_directly(project_id) OR path = 'koopi_scratch');
