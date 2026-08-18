import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { summarizeProjectFileChange } from "@/lib/summarizeProjectFileChange";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// Phase 3 of the debugging-tools build (role-aware change notifications):
// generates the plain-language "what and why" shown above the diff in the
// Pending panel, so an Owner/Admin can understand a proposed change without
// reading it line-by-line. The actual model call + persist now lives in
// lib/summarizeProjectFileChange.ts, shared with app/api/chat/route.ts's
// AI-assistant proposal paths — this route is now just that shared
// function's HTTP face for the browser-triggered manual-edit path
// (RoomView.tsx's requestChangeSummary).
export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const changeId = body?.changeId as string | undefined;
  if (!changeId) {
    return NextResponse.json({ error: "changeId is required" }, { status: 400 });
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  // RLS on project_file_changes (own proposals or admin/owner) and
  // project_files (project participant) both apply here automatically —
  // this uses the caller's own session, not a service role, same as every
  // other read in this app. A change this user can't see degrades to the
  // shared function's own "change/file not found" outcome rather than
  // needing its own explicit authorization check.
  const outcome = await summarizeProjectFileChange(supabase, changeId);
  if (!outcome.ok) {
    // Best-effort feature — the Pending panel's own "Summary pending…"
    // fallback (see ProjectChanges.tsx) is the honest state here, not an
    // error the proposer needs to see. The change itself already exists
    // and is reviewable without this.
    console.warn(`/api/projects/summarize-change: skipped for ${changeId}: ${outcome.reason}`);
    return NextResponse.json({ ok: true, skipped: outcome.reason });
  }
  return NextResponse.json({ ok: true });
}
