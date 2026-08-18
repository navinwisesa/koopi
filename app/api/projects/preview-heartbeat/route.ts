import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { renewPreviewSandbox } from "@/lib/webAppSandbox";

export const dynamic = "force-dynamic";

// Called periodically by ProjectPanel.tsx while a project's live preview is
// running and its panel is open — the ONLY thing that used to renew a
// preview sandbox's expiry was an explicit Run/Restart click, so a room
// where people were genuinely using the live demo (never touching Koopi
// itself) still hit the timeout on a clock nothing was resetting. This
// closes that gap: as long as the panel stays open, the sandbox's clock
// keeps getting pushed back out, same idea as lib/presence.ts's own
// heartbeat for room presence.
//
// Deliberately silent on every kind of "nothing to renew" (no preview_
// sandbox_id yet, preview not running, the sandbox already expired) —
// this is upkeep, not an action anyone asked for or needs to see fail;
// the next real Run already handles recreating a dead sandbox regardless.
export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const projectId = body?.projectId as string | undefined;
  if (!projectId) {
    return NextResponse.json({ error: "projectId required" }, { status: 400 });
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // RLS (is_project_participant) naturally 404s this for anyone not in the
  // project's room — same pattern every other /api/projects/* route uses.
  const { data: project } = await supabase
    .from("projects")
    .select("preview_sandbox_id, preview_status")
    .eq("id", projectId)
    .maybeSingle();
  if (!project) {
    return NextResponse.json({ error: "project not found" }, { status: 404 });
  }

  if (project.preview_status !== "running" || !project.preview_sandbox_id) {
    return NextResponse.json({ ok: true, renewed: false });
  }

  const renewed = await renewPreviewSandbox(project.preview_sandbox_id);
  return NextResponse.json({ ok: true, renewed });
}
