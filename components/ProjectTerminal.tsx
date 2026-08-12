"use client";

import { useEffect, useRef, useState } from "react";
import { Terminal, Send, Eye } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import type { ProjectRunState, RoomMember } from "@/components/RoomView";

type Line = { stream: "stdout" | "stderr" | "input" | "system"; text: string };

// How long output must be quiet, while a run is active, before we guess
// the process is blocked on input() rather than still computing. A guess,
// not a real signal — plain subprocess piping gives no reliable way to
// know a process is blocked in read() specifically (this is the same
// limitation every terminal emulator has; they don't know either). Kept
// short enough that a merely-slow computation rarely false-triggers it for
// more than a moment, long enough that fast prints in a loop don't flicker
// the cursor on and off between them.
const WAITING_GUESS_MS = 450;

/**
 * Live terminal for the Project panel's Run — replaces the old
 * batched-result-only Output block. Subscribes to the run's broadcast
 * channel (`project:{projectId}:run`, sent server-side from
 * app/api/projects/run/route.ts) for incremental stdout/stderr and echoes
 * of submitted stdin; submitting stdin here is a plain write to
 * projects.pending_stdin, which that route's polling ticker is the only
 * thing that ever actually acts on (and only when it's still this run's
 * owner) — see that route and 20260819_add_project_run_stdin.sql for the
 * other half of this.
 */
export default function ProjectTerminal({
  projectId,
  runState,
  currentUserId,
  memberById,
}: {
  projectId: string;
  runState: ProjectRunState;
  currentUserId: string;
  memberById: Map<string, RoomMember>;
}) {
  const isRunning = runState.status === "running";
  const isOwner = isRunning && runState.runOwnerId === currentUserId;

  // Seeded once from whatever the server already persisted — a fresh mount
  // shows the last completed run's transcript (old behavior) or, if a run
  // is already in flight when this mounts, a notice that earlier output
  // wasn't captured (broadcast doesn't replay history; there was nothing
  // to seed from for the in-progress case).
  const [lines, setLines] = useState<Line[]>(() => {
    if (runState.status === "running") {
      return [{ stream: "system", text: "Run already in progress — output from before you joined isn't shown." }];
    }
    const seeded: Line[] = [];
    if (runState.lastRunStdout) seeded.push({ stream: "stdout", text: runState.lastRunStdout });
    if (runState.lastRunStderr) seeded.push({ stream: "stderr", text: runState.lastRunStderr });
    return seeded;
  });
  const [exited, setExited] = useState<{ exitCode: number | null; cancelled: boolean; error: string | null } | null>(
    () => (runState.status === "idle" && runState.lastRunAt ? { exitCode: runState.lastRunExitCode, cancelled: false, error: null } : null)
  );
  const [stdinDraft, setStdinDraft] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [probablyWaiting, setProbablyWaiting] = useState(false);
  const lastOutputAtRef = useRef(Date.now());
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const supabase = createClient();
    const channel = supabase
      .channel(`project:${projectId}:run`)
      .on("broadcast", { event: "started" }, () => {
        setLines([]);
        setExited(null);
        lastOutputAtRef.current = Date.now();
        setProbablyWaiting(false);
      })
      .on("broadcast", { event: "output" }, (msg) => {
        const { stdout, stderr } = (msg.payload ?? {}) as { stdout?: string; stderr?: string };
        setLines((prev) => {
          const next = [...prev];
          if (stdout) next.push({ stream: "stdout", text: stdout });
          if (stderr) next.push({ stream: "stderr", text: stderr });
          return next;
        });
        lastOutputAtRef.current = Date.now();
        setProbablyWaiting(false);
      })
      .on("broadcast", { event: "input" }, (msg) => {
        const { text } = (msg.payload ?? {}) as { text?: string };
        if (!text) return;
        setLines((prev) => [...prev, { stream: "input", text }]);
        lastOutputAtRef.current = Date.now();
      })
      .on("broadcast", { event: "exited" }, (msg) => {
        const payload = (msg.payload ?? {}) as { exitCode: number | null; cancelled: boolean; error: string | null };
        setExited(payload);
        setProbablyWaiting(false);
      })
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [projectId]);

  // The "probably waiting on input" guess, re-evaluated on a short poll
  // rather than a single setTimeout, since each new output chunk resets
  // the clock (handled by re-reading the ref rather than restarting an
  // effect per chunk).
  useEffect(() => {
    if (!isRunning) return;
    const id = setInterval(() => {
      setProbablyWaiting(Date.now() - lastOutputAtRef.current > WAITING_GUESS_MS);
    }, 150);
    return () => clearInterval(id);
  }, [isRunning]);

  useEffect(() => {
    if (isOwner && probablyWaiting) inputRef.current?.focus();
  }, [isOwner, probablyWaiting]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [lines, exited]);

  async function submitStdin() {
    const text = stdinDraft;
    if (submitting || !isOwner) return;
    setSubmitting(true);
    setStdinDraft("");
    const supabase = createClient();
    const { error } = await supabase
      .from("projects")
      .update({ pending_stdin: text, pending_stdin_by: currentUserId })
      .eq("id", projectId);
    if (error) console.error("ProjectTerminal: failed to submit stdin", error);
    // Re-enable shortly after — long enough for the run route's ~120ms
    // ticker to have claimed it, short enough this doesn't feel sluggish.
    // There's no push-style ack for "the server actually consumed it" to
    // wait on instead without adding a second broadcast round trip just
    // for that.
    setTimeout(() => setSubmitting(false), 250);
  }

  return (
    <div className="shrink-0 border-t border-border bg-background">
      <div className="flex items-center gap-1.5 px-4 py-1.5 text-xs font-medium text-muted">
        <Terminal className={`h-3.5 w-3.5 ${isRunning ? "animate-pulse text-accent" : ""}`} strokeWidth={1.75} />
        {isRunning ? `Running ${runState.entryPath ?? ""}…` : "Output"}
        {isRunning && !isOwner && (
          <span className="ml-1 flex items-center gap-1 text-[10px] text-muted">
            <Eye className="h-3 w-3" strokeWidth={1.75} />
            watching — {memberById.get(runState.runOwnerId ?? "")?.username ?? "someone"} is running this
          </span>
        )}
      </div>

      <div className="max-h-48 overflow-y-auto px-4 pb-2 font-mono text-xs">
        {lines.length === 0 && !exited && <p className="py-2 text-muted">Run a file to see output here.</p>}
        {lines.map((line, i) => {
          if (line.stream === "system") {
            return (
              <p key={i} className="italic text-muted">
                {line.text}
              </p>
            );
          }
          if (line.stream === "input") {
            return (
              <pre key={i} className="whitespace-pre-wrap break-words text-accent">
                {"> "}
                {line.text}
              </pre>
            );
          }
          return (
            <pre
              key={i}
              className={`whitespace-pre-wrap break-words ${line.stream === "stderr" ? "text-red-400" : "text-foreground"}`}
            >
              {line.text}
            </pre>
          );
        })}
        {isRunning && isOwner && !exited && (
          <span
            className={`inline-block h-3 w-1.5 translate-y-0.5 bg-accent ${probablyWaiting ? "animate-pulse" : "opacity-30"}`}
            aria-hidden="true"
          />
        )}
        {exited && (
          <p className={`mt-1 ${exited.error || (exited.exitCode ?? 0) !== 0 ? "text-red-400" : "text-muted"}`}>
            {exited.cancelled
              ? "process stopped"
              : exited.error
                ? `process exited — ${exited.error}`
                : `process exited (code ${exited.exitCode ?? "?"})`}
          </p>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Gated on !exited too, not just isRunning — the exited broadcast
          lands as soon as the process actually ends, which is slightly
          ahead of runState.status flipping to 'idle' via the projects
          postgres_changes subscription (a real, if small, gap: one is a
          direct broadcast, the other waits on a DB round trip + Realtime
          delivery). Without this the input box could stay visibly "live"
          for a moment after the process it would write to no longer
          exists. */}
      {isRunning && isOwner && !exited && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submitStdin();
          }}
          className="flex items-center gap-2 border-t border-border px-4 py-2"
        >
          <input
            ref={inputRef}
            value={stdinDraft}
            onChange={(e) => setStdinDraft(e.target.value)}
            disabled={submitting}
            placeholder={probablyWaiting ? "Waiting for your input…" : "Type input and press Enter…"}
            className={`min-w-0 flex-1 rounded-md border bg-surface px-2 py-1 font-mono text-xs text-foreground placeholder:text-muted focus:outline-none disabled:opacity-60 ${
              probablyWaiting ? "border-accent" : "border-border"
            }`}
          />
          <button
            type="submit"
            disabled={submitting}
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-accent text-accent-foreground disabled:opacity-40"
          >
            <Send className="h-3 w-3" strokeWidth={2} />
          </button>
        </form>
      )}
    </div>
  );
}
