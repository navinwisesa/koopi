"use client";

import { useEffect, useMemo, useState } from "react";
import { Check, X, Clock, User } from "lucide-react";
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
};

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
  const canReview = currentUserRole === "owner" || currentUserRole === "admin";
  const fileIds = useMemo(() => files.map((f) => f.id), [files]);
  const fileById = useMemo(() => new Map(files.map((f) => [f.id, f])), [files]);

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

  async function review(id: string, action: "approve" | "reject") {
    setActing(id);
    const supabase = createClient();
    const { error } = await supabase.rpc(
      action === "approve" ? "approve_project_file_change" : "reject_project_file_change",
      { p_change_id: id }
    );
    if (error) console.error(`ProjectChanges: failed to ${action} change ${id}`, error);
    setActing(null);
  }

  const pending = changes.filter((c) => c.status === "pending");
  const reviewed = changes.filter((c) => c.status !== "pending");

  function who(userId: string | null) {
    if (!userId) return "Koopi";
    return memberById.get(userId)?.username ?? "Someone";
  }

  function ChangeCard({ change }: { change: ChangeRow }) {
    const file = fileById.get(change.projectFileId);
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
          </p>
        )}
        {change.status === "pending" && canReview && (
          <div className="mt-2 flex gap-1.5">
            <button
              type="button"
              onClick={() => void review(change.id, "approve")}
              disabled={acting === change.id}
              className="flex items-center gap-1 rounded-md bg-accent px-2 py-1 text-[11px] font-medium text-accent-foreground disabled:opacity-50"
            >
              <Check className="h-3 w-3" strokeWidth={2} />
              Approve
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

  return (
    <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
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
        <div className="space-y-2">
          {pending.map((c) => (
            <ChangeCard key={c.id} change={c} />
          ))}
        </div>
      </div>
      {reviewed.length > 0 && (
        <div>
          <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted">History</p>
          <div className="space-y-2">
            {reviewed.map((c) => (
              <ChangeCard key={c.id} change={c} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
