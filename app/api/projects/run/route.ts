import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { SandboxProjectRun, type RunResult } from "@/lib/sandbox";

export const dynamic = "force-dynamic";
// Generous, but not unbounded — a human genuinely idle at a prompt for
// longer than this still gets cut off. Matches the chat route's own
// ceiling (the highest maxDuration already proven to work in this
// deployment) rather than guessing a larger number that might exceed
// whatever the actual hosting platform allows. A known, disclosed
// limitation, not a silent one.
export const maxDuration = 300;

// Same 120ms cadence as before, now doing three things per tick instead of
// one: poll for Stop, flush buffered output to all viewers, and check for
// stdin the owner submitted since the last tick. See
// 20260819_add_project_run_stdin.sql for why stdin routes through the DB
// (a "mailbox" column) rather than a second HTTP connection.
const FLUSH_MS = 120;

function runChannel(supabase: Awaited<ReturnType<typeof createClient>>, projectId: string) {
  // Broadcast, not postgres_changes — same choice the room chat's "typing"
  // indicator already made for high-frequency, ephemeral events that don't
  // need to survive a page refresh. httpSend() posts over REST; no
  // websocket needed from a server route.
  return supabase.channel(`project:${projectId}:run`);
}

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
  // Captured as its own const: TS's narrowing of `user` past the null
  // check above doesn't reliably propagate into the nested closures below
  // (isStillRunning/claimPendingStdin/the ticker), so they close over this
  // plain string instead of `user` itself.
  const userId = user.id;

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
  // run_owner_id records who this run belongs to for the stdin-ownership
  // check below; any stale mailbox from a previous run is cleared so a
  // late-arriving write from before this run started can't be replayed
  // into the new process.
  const { data: claimed } = await supabase
    .from("projects")
    .update({
      run_status: "running",
      run_entry_path: entryPath,
      run_owner_id: userId,
      pending_stdin: null,
      pending_stdin_by: null,
    })
    .eq("id", projectId)
    .eq("run_status", "idle")
    .select("id");
  if (!claimed?.length) {
    return NextResponse.json({ error: "already running" }, { status: 409 });
  }

  const channel = runChannel(supabase, projectId);
  async function broadcast(event: string, payload: Record<string, unknown>) {
    await channel.httpSend(event, payload).catch((err) => {
      console.warn(`/api/projects/run: broadcast '${event}' failed for project ${projectId}:`, err);
    });
  }
  await broadcast("started", { entryPath, startedBy: userId });

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
      .eq("run_owner_id", userId)
      .select("id");
    if (error) return true; // transient failure — don't abort on a hiccup
    return Boolean(data && data.length > 0);
  }

  // Claims (and clears) any stdin the owner submitted since the last tick.
  // Read-then-clear rather than a single UPDATE ... RETURNING — PostgREST's
  // RETURNING reflects the row AFTER the update, so selecting pending_stdin
  // in the same call would only ever hand back the null it was just set
  // to. The two-step version is safe here without an explicit CAS on the
  // clear: only this run's own ticker ever calls this for this project (the
  // run_status CAS at claim time guarantees one active run per project), so
  // there's no concurrent caller to race against.
  //
  // The `pending_stdin_by = userId` condition is the actual enforcement
  // point for "only the run's owner can submit input" — a write from
  // anyone else matches zero rows here and is silently never consumed,
  // regardless of what the UI does or doesn't show them.
  async function claimPendingStdin(): Promise<string | null> {
    const { data } = await supabase
      .from("projects")
      .select("pending_stdin")
      .eq("id", projectId!)
      .eq("pending_stdin_by", userId)
      .not("pending_stdin", "is", null)
      .maybeSingle();
    const text = (data?.pending_stdin as string | null) ?? null;
    if (text === null) return null;
    await supabase
      .from("projects")
      .update({ pending_stdin: null, pending_stdin_by: null })
      .eq("id", projectId!)
      .eq("pending_stdin_by", userId);
    return text;
  }

  const sandboxRun = new SandboxProjectRun(
    files,
    entryPath,
    entryFile.language,
    roomRow?.sandbox_id ?? null
  );

  // The route's own accumulation of everything seen — authoritative for
  // what gets persisted, independent of whether the run finishes, errors,
  // or is cancelled mid-stream. Small buffers of *unflushed* output are
  // kept separately so the ticker can batch broadcasts instead of firing
  // one HTTP POST per raw chunk E2B hands back.
  let fullStdout = "";
  let fullStderr = "";
  let unflushedOut = "";
  let unflushedErr = "";

  let cancelled = false;
  let sawError: string | null = null;
  const ticker = setInterval(async () => {
    try {
      if (!(await isStillRunning())) {
        cancelled = true;
        clearInterval(ticker);
        void sandboxRun.cancel();
        return;
      }
      if (unflushedOut || unflushedErr) {
        const out = unflushedOut;
        const err = unflushedErr;
        unflushedOut = "";
        unflushedErr = "";
        void broadcast("output", { stdout: out, stderr: err });
      }
      const stdin = await claimPendingStdin();
      if (stdin !== null) {
        await sandboxRun.sendStdin(`${stdin}\n`);
        void broadcast("input", { text: stdin, by: userId });
      }
    } catch (err) {
      // A hiccup in the ticker itself (network blip on a poll) shouldn't
      // tear down an otherwise-healthy run — log and try again next tick.
      console.warn(`/api/projects/run: ticker error for project ${projectId}:`, err);
    }
  }, FLUSH_MS);

  let result: RunResult;
  let sandboxId: string | null = null;
  try {
    const outcome = await sandboxRun.run({
      onStdout: (data) => {
        fullStdout += data;
        unflushedOut += data;
      },
      onStderr: (data) => {
        fullStderr += data;
        unflushedErr += data;
      },
    });
    result = outcome.result;
    sandboxId = outcome.sandboxId;
  } catch (err) {
    sawError = err instanceof Error ? err.message : "Sandbox execution failed.";
    result = { stdout: fullStdout, stderr: fullStderr, exit_code: -1 };
  } finally {
    clearInterval(ticker);
  }

  // Final flush — whatever arrived between the last tick and the process
  // actually exiting.
  if (unflushedOut || unflushedErr) {
    await broadcast("output", { stdout: unflushedOut, stderr: unflushedErr });
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

  // The route's own buffers are authoritative regardless of how this run
  // ended — cancelled mid-stream still persists whatever actually printed,
  // rather than discarding it the way the old one-shot version did.
  const finalStdout = fullStdout;
  const finalStderr = sawError ? `${fullStderr}${fullStderr ? "\n" : ""}${sawError}` : fullStderr;
  const finalExitCode = cancelled ? null : result.exit_code;

  await supabase
    .from("projects")
    .update({
      run_status: "idle",
      run_owner_id: null,
      pending_stdin: null,
      pending_stdin_by: null,
      last_run_stdout: finalStdout,
      last_run_stderr: finalStderr,
      last_run_exit_code: finalExitCode,
      last_run_at: new Date().toISOString(),
      last_run_by: userId,
    })
    .eq("id", projectId)
    .eq("run_owner_id", userId);

  await broadcast("exited", {
    exitCode: finalExitCode,
    cancelled,
    error: sawError,
  });
  await supabase.removeChannel(channel);

  return NextResponse.json({ ok: true, cancelled, result: { ...result, stdout: finalStdout, stderr: finalStderr } });
}
