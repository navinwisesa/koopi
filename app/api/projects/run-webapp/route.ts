import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { runWebApp } from "@/lib/webAppSandbox";
import { detectWebAppFramework } from "@/lib/webAppFramework";
import { applyScaffoldGuards } from "@/lib/webAppScaffoldGuards";
import { languageFromPath } from "@/lib/languageFromPath";

export const dynamic = "force-dynamic";
// Worst case for framework: "next" — 120s npm install budget +
// lib/webAppSandbox.ts's own ~90s readiness-poll budget for "next" — is
// ~210s; this needs real headroom above that or the route itself gets cut
// off mid-wait before runWebApp ever gets to report why. "static" resolves
// in seconds regardless, so this ceiling only ever matters for "next".
export const maxDuration = 260;

const FOLDER_MARKER = ".gitkeep";
function isFolderMarker(path: string): boolean {
  return path === FOLDER_MARKER || path.endsWith(`/${FOLDER_MARKER}`);
}

function previewChannel(supabase: Awaited<ReturnType<typeof createClient>>, projectId: string) {
  // Same broadcast-not-postgres_changes choice /api/projects/run's
  // runChannel already made — an ephemeral status update, not something
  // that needs to survive a refresh (the persisted preview_* columns on
  // `projects` are that; this is just the live nudge).
  return supabase.channel(`project:${projectId}:preview`);
}

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
  const userId = user.id;

  // RLS (is_project_participant) naturally 404s this for anyone not in the
  // project's room — same pattern /api/projects/run already relies on.
  const { data: project } = await supabase
    .from("projects")
    .select("id, preview_sandbox_id")
    .eq("id", projectId)
    .maybeSingle();
  if (!project) {
    return NextResponse.json({ error: "project not found" }, { status: 404 });
  }

  // Strictly the persisted column — never a pending proposal's content.
  // (An earlier version of this route preferred pending content so a
  // scaffold's preview would work before approval; that produced a running
  // app with an empty Project panel, which is worse than making someone
  // wait for review. What runs must always match what's actually in the
  // panel — an Owner/Admin's scaffold already lands here directly via
  // app/api/chat/route.ts's runScaffoldToolCall, so this needs nothing
  // special to see it.)
  const { data: fileRows } = await supabase
    .from("project_files")
    .select("path, content")
    .eq("project_id", projectId);
  const files = (fileRows ?? []).filter((f) => !isFolderMarker(f.path));
  if (!files.length) {
    return NextResponse.json({ error: "project has no files" }, { status: 400 });
  }

  const framework = detectWebAppFramework(files);
  if (!framework) {
    return NextResponse.json({ error: "not a web app project" }, { status: 400 });
  }

  // Same guards app/api/chat/route.ts's runScaffoldToolCall applies when a
  // scaffold is first written — reapplied here so a project whose files were
  // persisted before a given guard existed (or that picked up a bad
  // next.config.js some other way) self-heals the next time someone clicks
  // Run, instead of being permanently stuck re-running the same crash until
  // someone starts a fresh scaffold. No-ops on files that already pass.
  const guardedFiles = applyScaffoldGuards(files, framework);

  // Persist whatever the guards actually changed — otherwise a self-healed
  // run leaves the Editor still showing the broken content that was just
  // silently patched around in memory, and the next edit anyone makes in
  // the Editor starts from that stale/broken baseline again instead of the
  // fixed one. Only the changed paths are written (never a no-op churn of
  // every file), and this is strictly best-effort: RLS already restricts
  // project_files UPDATE/INSERT to owners/admins, so a non-privileged
  // participant clicking Run still gets a working preview (guardedFiles is
  // used for the sandbox regardless) even when the write itself is silently
  // rejected below.
  const originalContentByPath = new Map(files.map((f) => [f.path, f.content]));
  const healedFiles = guardedFiles.filter((f) => originalContentByPath.get(f.path) !== f.content);
  for (const f of healedFiles) {
    const { error: healErr } = await supabase.from("project_files").upsert(
      {
        project_id: projectId,
        path: f.path,
        content: f.content,
        language: languageFromPath(f.path),
        last_edited_by: null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "project_id,path" }
    );
    if (healErr) {
      console.warn(
        `/api/projects/run-webapp: failed to persist self-healed ${f.path} for project ${projectId}:`,
        healErr
      );
    }
  }

  // CAS claim: only the request that flips idle/error -> starting proceeds
  // — same shape /api/projects/run's run_status idle->running claim uses,
  // just against preview_status instead. A stale 'running' from a preview
  // that's actually fine to just re-serve (edited files, clicked Run again)
  // is deliberately allowed to be reclaimed here rather than 409ing forever
  // — unlike a script run, restarting an already-live preview is a normal,
  // idempotent action, not a conflict.
  await supabase
    .from("projects")
    .update({ preview_status: "starting", preview_error: null, preview_updated_by: userId })
    .eq("id", projectId);

  const channel = previewChannel(supabase, projectId);
  await channel.httpSend("starting", { startedBy: userId }).catch((err) => {
    console.warn(`/api/projects/run-webapp: broadcast 'starting' failed for project ${projectId}:`, err);
  });

  const { url, sandboxId, error } = await runWebApp(guardedFiles, framework, project.preview_sandbox_id ?? null);

  await supabase
    .from("projects")
    .update({
      preview_status: url ? "running" : "error",
      preview_url: url,
      preview_error: error,
      preview_sandbox_id: sandboxId,
      preview_framework: framework,
      preview_started_at: url ? new Date().toISOString() : null,
      preview_updated_by: userId,
    })
    .eq("id", projectId);

  await channel.httpSend(url ? "running" : "error", { url, error }).catch((err) => {
    console.warn(`/api/projects/run-webapp: broadcast result failed for project ${projectId}:`, err);
  });
  await supabase.removeChannel(channel);

  if (!url) {
    return NextResponse.json({ error: error ?? "failed to start web app" }, { status: 500 });
  }
  return NextResponse.json({ ok: true, url });
}
