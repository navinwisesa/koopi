-- TEMPORARY — for live-testing the preview proxy end-to-end against a real
-- project row. Dropped again in the immediately-following migration once
-- verification is done; not meant to persist.
CREATE OR REPLACE FUNCTION public._test_set_preview(p_room_id uuid, p_sandbox_id text, p_status text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
declare
  v_project_id uuid;
begin
  select id into v_project_id from public.projects where room_id = p_room_id;
  if v_project_id is null then
    raise exception 'no project for room %', p_room_id;
  end if;
  update public.projects
  set preview_sandbox_id = p_sandbox_id, preview_status = p_status
  where id = v_project_id;
  return v_project_id;
end;
$function$;
