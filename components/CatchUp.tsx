"use client";

import { useState } from "react";
import { Sparkles, X, TriangleAlert, Loader2 } from "lucide-react";

type CatchUpResult = {
  summary: string;
  flaggedItems: { id: string; kind: string; summary: string; createdAt: string }[];
  messageCount: number;
};

async function fetchCatchUp(threadId: string, since?: string): Promise<CatchUpResult | null> {
  try {
    const res = await fetch("/api/threads/catch-up", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ threadId, since }),
    });
    if (!res.ok) return null;
    return (await res.json()) as CatchUpResult;
  } catch (err) {
    console.error("CatchUp: request failed", err);
    return null;
  }
}

function ResultBody({ result }: { result: CatchUpResult }) {
  return (
    <div className="px-3 py-2 text-xs">
      <p className="leading-relaxed text-foreground">{result.summary}</p>
      {/* Flagged items are always listed in full, never trimmed by the
          summary above — see app/api/threads/catch-up/route.ts's own
          comment: a real conflict/risk (or a resolved change) must never
          quietly disappear into "a few sentences" just because a lot else
          also happened while someone was away. */}
      {result.flaggedItems.length > 0 && (
        <div className="mt-2 space-y-1 border-t border-border pt-2">
          {result.flaggedItems.map((f) => (
            <p key={f.id} className="flex items-start gap-1.5 text-[11px] text-amber-600">
              <TriangleAlert className="mt-0.5 h-3 w-3 shrink-0" strokeWidth={2} />
              {f.summary}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Auto-shown "here's what you missed" banner (PDF §3 async coordination) —
 * RoomView renders this only when switching into a thread crosses
 * CATCH_UP_THRESHOLD unread messages (see its own comment there); `since`
 * is captured BEFORE last_read_at gets overwritten to now, or there'd be
 * nothing left to catch up on by the time this could ask.
 */
export function CatchUpBanner({
  threadId,
  since,
  count,
  onDismiss,
}: {
  threadId: string;
  since: string;
  count: number;
  onDismiss: () => void;
}) {
  const [state, setState] = useState<"idle" | "loading" | CatchUpResult>("idle");

  async function catchMeUp() {
    setState("loading");
    const result = await fetchCatchUp(threadId, since);
    setState(result ?? "idle");
  }

  if (state === "loading") {
    return (
      <div className="mb-2 flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-xs text-muted">
        <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.75} />
        Catching you up…
      </div>
    );
  }

  if (state !== "idle") {
    return (
      <div className="mb-2 overflow-hidden rounded-lg border border-accent/30 bg-accent/5">
        <div className="flex items-center justify-between gap-2 border-b border-accent/20 px-3 py-1.5">
          <span className="flex items-center gap-1.5 text-xs font-medium text-foreground">
            <Sparkles className="h-3.5 w-3.5 text-accent" strokeWidth={2} />
            Catch-up
          </span>
          <button
            type="button"
            onClick={onDismiss}
            className="text-muted transition-colors hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" strokeWidth={1.75} />
          </button>
        </div>
        <ResultBody result={state} />
      </div>
    );
  }

  return (
    <div className="mb-2 flex items-center justify-between gap-2 rounded-lg border border-accent/30 bg-accent/5 px-3 py-2 text-xs">
      <span className="text-foreground">
        You missed {count} message{count === 1 ? "" : "s"} here.
      </span>
      <div className="flex shrink-0 items-center gap-2">
        <button
          type="button"
          onClick={() => void catchMeUp()}
          className="flex items-center gap-1 rounded-md bg-accent px-2 py-1 font-medium text-accent-foreground transition-opacity hover:opacity-90"
        >
          <Sparkles className="h-3 w-3" strokeWidth={2} />
          Catch me up
        </button>
        <button
          type="button"
          onClick={onDismiss}
          className="text-muted transition-colors hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" strokeWidth={1.75} />
        </button>
      </div>
    </div>
  );
}

/**
 * On-demand counterpart to CatchUpBanner — always available regardless of
 * unread count (the checklist's "TL;DR toggle scoped to user's last-active
 * area"), scoped to whichever thread is currently open. `since` omitted
 * means the API's own "last N messages" fallback.
 */
export function TldrButton({ threadId, since }: { threadId: string; since?: string }) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<"idle" | "loading" | CatchUpResult>("idle");

  async function toggle() {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    setState("loading");
    const result = await fetchCatchUp(threadId, since);
    setState(result ?? "idle");
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => void toggle()}
        title="Summarize recent activity in this thread"
        className={`flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] transition-colors ${
          open ? "border-accent text-accent" : "border-border text-muted hover:text-foreground"
        }`}
      >
        <Sparkles className="h-3 w-3" strokeWidth={1.75} />
        TL;DR
      </button>
      {open && (
        <div className="absolute right-0 top-full z-20 mt-1 w-72">
          {state === "loading" ? (
            <div className="flex items-center gap-1.5 rounded-lg border border-border bg-surface px-3 py-2 text-xs text-muted shadow-2xl">
              <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.75} />
              Summarizing…
            </div>
          ) : state === "idle" ? (
            <div className="rounded-lg border border-border bg-surface px-3 py-2 text-xs text-muted shadow-2xl">
              Couldn&apos;t generate a summary.
            </div>
          ) : (
            <div className="overflow-hidden rounded-lg border border-border bg-surface shadow-2xl">
              <ResultBody result={state} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
