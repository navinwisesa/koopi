-- Groups multiple project_file_changes rows proposed together as one unit —
-- e.g. a web-app scaffold that touches N files at once — so the review UI
-- can show "N files, one proposal" instead of N unrelated-looking cards, and
-- an Owner/Admin can approve/reject the whole thing atomically. Nullable:
-- every existing (and future single-file) proposal has batch_id = null and
-- renders exactly as before; this is purely additive.
ALTER TABLE public.project_file_changes
  ADD COLUMN IF NOT EXISTS batch_id uuid;

CREATE INDEX IF NOT EXISTS project_file_changes_batch_id_idx
  ON public.project_file_changes (batch_id)
  WHERE batch_id IS NOT NULL;

-- Batch-scoped counterparts to approve_project_file_change/
-- reject_project_file_change (20260817_add_room_roles_and_approval.sql) —
-- same per-row logic, looped inside one transaction so a batch is
-- all-or-nothing from the caller's point of view (a single Approve-all
-- click either lands every file or none of them, never a partial scaffold).
-- Rows already reviewed (approved/rejected) are silently skipped rather than
-- erroring, since a batch reasonably contains a mix once someone starts
-- reviewing file-by-file before using the all/none button.
CREATE OR REPLACE FUNCTION public.approve_project_file_change_batch(p_batch_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
declare
  v_change record;
begin
  for v_change in
    select id from public.project_file_changes
    where batch_id = p_batch_id and status = 'pending'
  loop
    perform public.approve_project_file_change(v_change.id);
  end loop;
end;
$function$;

CREATE OR REPLACE FUNCTION public.reject_project_file_change_batch(p_batch_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
declare
  v_change record;
begin
  for v_change in
    select id from public.project_file_changes
    where batch_id = p_batch_id and status = 'pending'
  loop
    perform public.reject_project_file_change(v_change.id);
  end loop;
end;
$function$;
