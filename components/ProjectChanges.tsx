"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, X, Clock, User, Layers, ChevronDown, ChevronRight, AlertTriangle } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import type { ProjectFile, RoomMember, RoomRole } from "@/components/RoomView";

type ChangeRow = {
  id: string;
  projectFileId: string;
  proposedBy: string | null;
  proposedContent: string;
  source: "manual" | "ai_assistant";
  status: "pending" | "approved" | "rejected";
  reviewedBy: string | null;
  reviewedAt: string | null;
  createdAt: string;
  // Plain-language "what and why" (Phase 3) — generated asynchronously by
  // /api/projects/summarize-change right after the row is created, so this
  // is null for a brief window on every new proposal until that call lands
  // its own UPDATE (picked up by this component's existing realtime
  // subscription below, same as any other change to the row).
  summary: string | null;
  // Shared across every file proposed together in one go — a web-app
  // scaffold, say — so they can be reviewed as one unit instead of N
  // unrelated-looking cards. null for every ordinary single-file proposal,
  // which renders exactly as before. See
  // 20260827_add_project_file_change_batch.sql.
  batchId: string | null;
};

/** "Xm ago" while recent enough for that to be meaningful; otherwise an absolute
 * date + time in the viewer's own locale/timezone (never the server's). */
function formatReviewedAt(iso: string, now: number): string {
  const mins = Math.floor((now - new Date(iso).getTime()) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  return new Date(iso).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function rowToChange(row: Record<string, unknown>): ChangeRow {
  return {
    id: row.id as string,
    projectFileId: row.project_file_id as string,
    proposedBy: (row.proposed_by as string | null) ?? null,
    proposedContent: (row.proposed_content as string) ?? "",
    source: row.source as "manual" | "ai_assistant",
    status: row.status as "pending" | "approved" | "rejected",
    reviewedBy: (row.reviewed_by as string | null) ?? null,
    reviewedAt: (row.reviewed_at as string | null) ?? null,
    createdAt: row.created_at as string,
    summary: (row.summary as string | null) ?? null,
    batchId: (row.batch_id as string | null) ?? null,
  };
}

// The review queue itself — RLS already limits what actually comes back
// (a Member only ever gets their own proposals; see
// 20260817_add_room_roles_and_approval.sql's SELECT policy), so
// `canReview` here only controls whether Approve/Reject buttons are
// offered, not what data is fetched. Hiding the buttons for a Member who
// somehow saw a stray row would still be backstopped by the approve/reject
// RPCs' own owner/admin check.
export default function ProjectChanges({
  files,
  memberById,
  currentUserRole,
}: {
  projectId: string;
  files: ProjectFile[];
  memberById: Map<string, RoomMember>;
  currentUserRole: RoomRole;
}) {
  const [changes, setChanges] = useState<ChangeRow[]>([]);
  const [acting, setActing] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  // Per-file content preview inside a BatchGroup — collapsed by default (a
  // scaffold can be a dozen+ files, showing every body at once would bury
  // the summary and the Approve/Reject buttons), expandable one at a time
  // per file so an owner/admin can actually read what they're approving
  // instead of approving blind on filename + summary alone.
  const [expandedChangeIds, setExpandedChangeIds] = useState<Set<string>>(new Set());
  function toggleExpanded(id: string) {
    setExpandedChangeIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // Confirmed live: approve_project_file_change(_batch) can genuinely fail
  // (a race with a second reviewer, a dropped connection, ...) and until
  // now that failure only ever reached the browser console — the item just
  // silently stayed in Pending with nothing telling the person who clicked
  // Approve that it didn't actually happen. Same self-clearing-banner
  // convention ProjectPanel's own changeToast/notice already use.
  const [actionError, setActionError] = useState<string | null>(null);
  const actionErrorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (actionErrorTimerRef.current) clearTimeout(actionErrorTimerRef.current);
  }, []);
  function showActionError(message: string) {
    setActionError(message);
    if (actionErrorTimerRef.current) clearTimeout(actionErrorTimerRef.current);
    actionErrorTimerRef.current = setTimeout(() => setActionError(null), 6000);
  }
  const canReview = currentUserRole === "owner" || currentUserRole === "admin";
  const fileIds = useMemo(() => files.map((f) => f.id), [files]);
  const fileById = useMemo(() => new Map(files.map((f) => [f.id, f])), [files]);

  // Keeps "Xm ago" ticking forward while History is open, same interval RoomView
  // uses for its own relative-time labels.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 20_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!fileIds.length) {
      setChanges([]);
      return;
    }
    const supabase = createClient();
    let cancelled = false;
    void supabase
      .from("project_file_changes")
      .select("*")
      .in("project_file_id", fileIds)
      .order("created_at", { ascending: false })
      .then(({ data }) => {
        if (!cancelled && data) setChanges(data.map(rowToChange));
      });

    const channel = supabase
      .channel(`project-file-changes:${fileIds.join(",")}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "project_file_changes" },
        (payload) => {
          const row = (payload.new ?? payload.old) as Record<string, unknown> | null;
          const id = row?.id as string | undefined;
          if (!id) return;
          if (payload.eventType === "DELETE") {
            setChanges((prev) => prev.filter((c) => c.id !== id));
            return;
          }
          const change = rowToChange(row!);
          if (!fileIds.includes(change.projectFileId)) return;
          setChanges((prev) => {
            const idx = prev.findIndex((c) => c.id === id);
            if (idx === -1) return [change, ...prev];
            const next = [...prev];
            next[idx] = change;
            return next;
          });
        }
      )
      .subscribe();

    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
    };
  }, [fileIds]);

  // A STALE_CHANGE rejection (20260831_add_stale_change_guard.sql) should be
  // rare in practice — isStale below already warns before the click happens
  // — but it's still a real possible outcome (a race between render and
  // click, e.g.), so it gets its own friendlier copy instead of surfacing
  // the RPC's bare greppable message string verbatim.
  function friendlyReviewError(action: "approve" | "reject", message: string | undefined): string {
    if (message === "STALE_CHANGE") {
      return "This file was changed since this was proposed — review the current content before approving.";
    }
    return `Couldn't ${action} that change — ${message || "try again"}. It's still pending.`;
  }

  async function review(id: string, action: "approve" | "reject", force = false) {
    setActing(id);
    const supabase = createClient();
    const { error } = await supabase.rpc(
      action === "approve" ? "approve_project_file_change" : "reject_project_file_change",
      action === "approve" ? { p_change_id: id, p_force: force } : { p_change_id: id }
    );
    if (error) {
      console.error(`ProjectChanges: failed to ${action} change ${id}`, error);
      showActionError(friendlyReviewError(action, error.message));
    }
    setActing(null);
  }

  // Batch-scoped counterpart to review() above — approve_project_file_change_batch/
  // reject_project_file_change_batch (20260827_add_project_file_change_batch.sql)
  // apply the same per-row logic to every pending row sharing a batch_id, in one
  // transaction, so a scaffold's N files land (or don't) as a single unit.
  async function reviewBatch(batchId: string, action: "approve" | "reject", force = false) {
    setActing(batchId);
    const supabase = createClient();
    const { error } = await supabase.rpc(
      action === "approve" ? "approve_project_file_change_batch" : "reject_project_file_change_batch",
      action === "approve" ? { p_batch_id: batchId, p_force: force } : { p_batch_id: batchId }
    );
    if (error) {
      console.error(`ProjectChanges: failed to ${action} batch ${batchId}`, error);
      showActionError(friendlyReviewError(action, error.message));
    }
    setActing(null);
  }

  const pending = changes.filter((c) => c.status === "pending");
  const reviewed = changes.filter((c) => c.status !== "pending");

  function who(userId: string | null) {
    if (!userId) return "Koopi";
    return memberById.get(userId)?.username ?? "Someone";
  }

  // Shared by ChangeCard and BatchGroup — see ChangeCard's own comment for
  // why file.updatedAt > change.createdAt means "stale": something wrote to
  // this file's content since this proposal was made, so approving it now
  // would silently overwrite that instead of what the proposer reviewed.
  function isStale(change: ChangeRow): boolean {
    if (change.status !== "pending") return false;
    const file = fileById.get(change.projectFileId);
    return Boolean(file) && new Date(file!.updatedAt) > new Date(change.createdAt);
  }

  // Collapses a flat, chronologically-ordered list into single cards plus
  // one entry per distinct batch_id (first-occurrence position, every later
  // row sharing that batch_id folded into it) — same list, just grouped for
  // display. Every ordinary single-file proposal (batchId: null) is
  // completely unaffected, rendering exactly as it did before batching
  // existed.
  function groupForDisplay(
    items: ChangeRow[]
  ): ({ kind: "single"; change: ChangeRow } | { kind: "batch"; batchId: string; items: ChangeRow[] })[] {
    const seen = new Set<string>();
    const entries: ReturnType<typeof groupForDisplay> = [];
    for (const c of items) {
      if (!c.batchId) {
        entries.push({ kind: "single", change: c });
        continue;
      }
      if (seen.has(c.batchId)) continue;
      seen.add(c.batchId);
      entries.push({ kind: "batch", batchId: c.batchId, items: items.filter((x) => x.batchId === c.batchId) });
    }
    return entries;
  }

  function ChangeCard({ change }: { change: ChangeRow }) {
    const file = fileById.get(change.projectFileId);
    const stale = isStale(change);
    return (
      <div className="rounded-lg border border-border p-2.5 text-xs">
        <div className="flex items-center justify-between gap-2">
          <span className="truncate font-mono text-[11px] text-foreground">{file?.path ?? "(deleted file)"}</span>
          <span
            className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${
              change.status === "pending"
                ? "bg-amber-500/15 text-amber-600"
                : change.status === "approved"
                  ? "bg-accent/15 text-accent"
                  : "bg-red-500/15 text-red-500"
            }`}
          >
            {change.status}
          </span>
        </div>
        <p className="mt-1 flex items-center gap-1 text-[11px] text-muted">
          <User className="h-3 w-3" strokeWidth={1.75} />
          {who(change.proposedBy)} · {change.source === "ai_assistant" ? "AI suggestion" : "manual edit"}
        </p>
        <p className="mt-1.5 text-[11px] leading-relaxed text-foreground">
          {change.summary ?? <span className="italic text-muted">Summary pending…</span>}
        </p>
        <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap break-words rounded bg-background p-2 font-mono text-[10px] text-foreground">
          {change.proposedContent}
        </pre>
        {change.status !== "pending" && (
          <p className="mt-1 flex items-center gap-1 text-[10px] text-muted">
            <Clock className="h-3 w-3" strokeWidth={1.75} />
            {change.status === "approved" ? "Approved" : "Rejected"} by {who(change.reviewedBy)}
            {change.reviewedAt && ` · ${formatReviewedAt(change.reviewedAt, now)}`}
          </p>
        )}
        {stale && canReview && (
          <p className="mt-2 flex items-start gap-1.5 rounded-md bg-amber-500/10 px-2 py-1.5 text-[11px] text-amber-600">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0 translate-y-px" strokeWidth={1.75} />
            <span>This file changed after this was proposed — approving will overwrite that newer content.</span>
          </p>
        )}
        {change.status === "pending" && canReview && (
          <div className="mt-2 flex gap-1.5">
            <button
              type="button"
              onClick={() => void review(change.id, "approve", stale)}
              disabled={acting === change.id}
              className="flex items-center gap-1 rounded-md bg-accent px-2 py-1 text-[11px] font-medium text-accent-foreground disabled:opacity-50"
            >
              <Check className="h-3 w-3" strokeWidth={2} />
              {stale ? "Approve anyway" : "Approve"}
            </button>
            <button
              type="button"
              onClick={() => void review(change.id, "reject")}
              disabled={acting === change.id}
              className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] text-muted hover:text-foreground disabled:opacity-50"
            >
              <X className="h-3 w-3" strokeWidth={2} />
              Reject
            </button>
          </div>
        )}
      </div>
    );
  }

  function BatchGroup({ batchId, items }: { batchId: string; items: ChangeRow[] }) {
    const anyPending = items.some((c) => c.status === "pending");
    // approve_project_file_change_batch stays all-or-nothing (its own
    // migration comment) — one stale file anywhere in the batch aborts the
    // WHOLE approval server-side, so the warning/override has to be
    // batch-wide too, not just on the one row that's actually stale.
    const staleItems = items.filter(isStale);
    return (
      <div className="rounded-lg border border-border p-2.5 text-xs">
        <div className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-1.5 font-medium text-foreground">
            <Layers className="h-3.5 w-3.5 shrink-0" strokeWidth={1.75} />
            Web app scaffold — {items.length} file{items.length === 1 ? "" : "s"}
          </span>
          {!anyPending && (
            <span
              className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${
                items.every((c) => c.status === "approved")
                  ? "bg-accent/15 text-accent"
                  : "bg-red-500/15 text-red-500"
              }`}
            >
              {items.every((c) => c.status === "approved") ? "approved" : "reviewed"}
            </span>
          )}
        </div>
        <p className="mt-1 flex items-center gap-1 text-[11px] text-muted">
          <User className="h-3 w-3" strokeWidth={1.75} />
          {who(items[0].proposedBy)} · {items[0].source === "ai_assistant" ? "AI suggestion" : "manual edit"}
        </p>
        {items[0].summary && (
          <p className="mt-1.5 text-[11px] leading-relaxed text-foreground">{items[0].summary}</p>
        )}
        <ul className="mt-2 space-y-1">
          {items.map((c) => {
            const file = fileById.get(c.projectFileId);
            const expanded = expandedChangeIds.has(c.id);
            return (
              <li key={c.id} className="rounded bg-background">
                <button
                  type="button"
                  onClick={() => toggleExpanded(c.id)}
                  className="flex w-full items-center justify-between gap-2 px-2 py-1 text-left"
                >
                  <span className="flex min-w-0 items-center gap-1 text-[11px] text-foreground">
                    {expanded ? (
                      <ChevronDown className="h-3 w-3 shrink-0 text-muted" strokeWidth={2} />
                    ) : (
                      <ChevronRight className="h-3 w-3 shrink-0 text-muted" strokeWidth={2} />
                    )}
                    <span className="truncate font-mono">{file?.path ?? "(deleted file)"}</span>
                  </span>
                  <span className="flex shrink-0 items-center gap-1">
                    {isStale(c) && (
                      <AlertTriangle
                        className="h-3 w-3 text-amber-600"
                        strokeWidth={2}
                        aria-label="Changed since proposed"
                      />
                    )}
                    <span
                      className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                        c.status === "pending"
                          ? "bg-amber-500/15 text-amber-600"
                          : c.status === "approved"
                            ? "bg-accent/15 text-accent"
                            : "bg-red-500/15 text-red-500"
                      }`}
                    >
                      {c.status}
                    </span>
                  </span>
                </button>
                {expanded && (
                  <pre className="mx-2 mb-2 max-h-32 overflow-auto whitespace-pre-wrap break-words rounded border border-border p-2 font-mono text-[10px] text-foreground">
                    {c.proposedContent}
                  </pre>
                )}
              </li>
            );
          })}
        </ul>
        {!anyPending && (
          <p className="mt-1.5 flex items-center gap-1 text-[10px] text-muted">
            <Clock className="h-3 w-3" strokeWidth={1.75} />
            {items.every((c) => c.status === "approved") ? "Approved" : "Reviewed"} by{" "}
            {who(items[0].reviewedBy)}
            {items[0].reviewedAt && ` · ${formatReviewedAt(items[0].reviewedAt, now)}`}
          </p>
        )}
        {staleItems.length > 0 && canReview && (
          <p className="mt-2 flex items-start gap-1.5 rounded-md bg-amber-500/10 px-2 py-1.5 text-[11px] text-amber-600">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0 translate-y-px" strokeWidth={1.75} />
            <span>
              {staleItems.length === 1 ? "1 file" : `${staleItems.length} files`} in this batch changed after being
              proposed — approving all will overwrite that newer content.
            </span>
          </p>
        )}
        {anyPending && canReview && (
          <div className="mt-2 flex gap-1.5">
            <button
              type="button"
              onClick={() => void reviewBatch(batchId, "approve", staleItems.length > 0)}
              disabled={acting === batchId}
              className="flex items-center gap-1 rounded-md bg-accent px-2 py-1 text-[11px] font-medium text-accent-foreground disabled:opacity-50"
            >
              <Check className="h-3 w-3" strokeWidth={2} />
              {staleItems.length > 0 ? "Approve all anyway" : "Approve all"}
            </button>
            <button
              type="button"
              onClick={() => void reviewBatch(batchId, "reject")}
              disabled={acting === batchId}
              className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] text-muted hover:text-foreground disabled:opacity-50"
            >
              <X className="h-3 w-3" strokeWidth={2} />
              Reject all
            </button>
          </div>
        )}
      </div>
    );
  }

  function renderEntry(entry: ReturnType<typeof groupForDisplay>[number]) {
    return entry.kind === "single" ? (
      <ChangeCard key={entry.change.id} change={entry.change} />
    ) : (
      <BatchGroup key={entry.batchId} batchId={entry.batchId} items={entry.items} />
    );
  }

  return (
    <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
      {actionError && (
        <p className="flex items-start gap-1.5 rounded-md bg-red-500/10 px-2.5 py-2 text-[11px] text-red-500">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 translate-y-px" strokeWidth={1.75} />
          <span>{actionError}</span>
        </p>
      )}
      {!canReview && (
        <p className="text-[11px] text-muted">
          Showing only your own proposed changes — approving/rejecting is an admin/owner action.
        </p>
      )}
      <div>
        <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted">
          Pending {pending.length > 0 && `(${pending.length})`}
        </p>
        {pending.length === 0 && <p className="text-[11px] text-muted">Nothing pending.</p>}
        <div className="space-y-2">{groupForDisplay(pending).map(renderEntry)}</div>
      </div>
      {reviewed.length > 0 && (
        <div>
          <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted">History</p>
          <div className="space-y-2">{groupForDisplay(reviewed).map(renderEntry)}</div>
        </div>
      )}
    </div>
  );
}
