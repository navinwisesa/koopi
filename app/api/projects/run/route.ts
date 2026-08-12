import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { SandboxProjectRun, type RunResult } from "@/lib/sandbox";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Same ticker/CAS/poll-to-cancel shape as app/api/thread-files/run/route.ts,
// applied to projects.run_status instead of thread_files.run_status — see
// that route's header comment for why this shape exists at all.
const FLUSH_MS = 120;

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const projectId = body?.projectId as string | undefined;
  const entryPath = body?.entryPath as string | undefined;
  if (!projectId || !entryPath) {
    return NextResponse.json({ error: "projectId and entryPath required" }, { status: 400 });
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // RLS (is_project_participant) naturally 404s this for anyone not in the
  // project's room — no separate membership check needed.
  const { data: project } = await supabase
    .from("projects")
    .select("id, room_id")
    .eq("id", projectId)
    .maybeSingle();
  if (!project) {
    return NextResponse.json({ error: "project not found" }, { status: 404 });
  }

  const { data: fileRows } = await supabase
    .from("project_files")
    .select("path, content, language")
    .eq("project_id", projectId);
  const files = fileRows ?? [];
  const entryFile = files.find((f) => f.path === entryPath);
  if (!entryFile) {
    return NextResponse.json({ error: "entry file not found in project" }, { status: 404 });
  }

  // CAS claim: only the request that flips idle -> running proceeds.
  const { data: claimed } = await supabase
    .from("projects")
    .update({ run_status: "running", run_entry_path: entryPath })
    .eq("id", projectId)
    .eq("run_status", "idle")
    .select("id");
  if (!claimed?.length) {
    return NextResponse.json({ error: "already running" }, { status: 409 });
  }

  // Reuse the SAME shared room sandbox run_code/thread_files already use —
  // not a second persistence mechanism.
  const { data: roomRow } = await supabase
    .from("rooms")
    .select("sandbox_id")
    .eq("id", project.room_id)
    .maybeSingle();

  async function isStillRunning(): Promise<boolean> {
    const { data, error } = await supabase
      .from("projects")
      .update({ run_status: "running" })
      .eq("id", projectId!)
      .eq("run_status", "running")
      .select("id");
    if (error) return true; // transient failure — don't abort on a hiccup
    return Boolean(data && data.length > 0);
  }

  const sandboxRun = new SandboxProjectRun(
    files,
    entryPath,
    entryFile.language,
    roomRow?.sandbox_id ?? null
  );
  let cancelled = false;
  const ticker = setInterval(async () => {
    if (!(await isStillRunning())) {
      cancelled = true;
      clearInterval(ticker);
      void sandboxRun.cancel();
    }
  }, FLUSH_MS);

  let result: RunResult;
  let sandboxId: string | null = null;
  try {
    const outcome = await sandboxRun.run();
    result = outcome.result;
    sandboxId = outcome.sandboxId;
  } catch (err) {
    result = {
      stdout: "",
      stderr: err instanceof Error ? err.message : "Sandbox execution failed.",
      exit_code: -1,
    };
  } finally {
    clearInterval(ticker);
  }

  if (sandboxId && sandboxId !== roomRow?.sandbox_id) {
    const { error: sandboxPersistErr } = await supabase.rpc("update_room_sandbox", {
      p_room_id: project.room_id,
      p_sandbox_id: sandboxId,
    });
    if (sandboxPersistErr) {
      console.warn(`/api/projects/run: failed to persist sandbox_id for room ${project.room_id}:`, sandboxPersistErr);
    }
  }

  if (cancelled) {
    // Stop already flipped run_status back to 'idle' itself.
    return NextResponse.json({ ok: true, cancelled: true });
  }

  await supabase
    .from("projects")
    .update({
      run_status: "idle",
      last_run_stdout: result.stdout,
      last_run_stderr: result.stderr,
      last_run_exit_code: result.exit_code,
      last_run_at: new Date().toISOString(),
      last_run_by: user.id,
    })
    .eq("id", projectId)
    .eq("run_status", "running");

  return NextResponse.json({ ok: true, result });
}
