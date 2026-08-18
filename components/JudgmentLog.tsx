"use client";

import { useEffect, useMemo, useState } from "react";
import { Scale, X, ThumbsUp, ThumbsDown, TriangleAlert } from "lucide-react";
import Avatar from "@/components/Avatar";
import { createClient } from "@/lib/supabase/client";
import type { RoomMember } from "@/components/RoomView";

type JudgmentCallRow = {
  id: string;
  kind: "flagged" | "change_approved" | "change_rejected";
  subjectUserId: string | null;
  decidedBy: string | null;
  summary: string;
  createdAt: string;
};

function rowToJudgmentCall(row: Record<string, unknown>): JudgmentCallRow {
  return {
    id: row.id as string,
    kind: row.kind as JudgmentCallRow["kind"],
    subjectUserId: (row.subject_user_id as string | null) ?? null,
    decidedBy: (row.decided_by as string | null) ?? null,
    summary: (row.summary as string) ?? "",
    createdAt: row.created_at as string,
  };
}

const KIND_META: Record<JudgmentCallRow["kind"], { icon: typeof Scale; label: string; className: string }> = {
  flagged: { icon: TriangleAlert, label: "Flagged", className: "bg-amber-500/15 text-amber-600" },
  change_approved: { icon: ThumbsUp, label: "Approved", className: "bg-accent/15 text-accent" },
  change_rejected: { icon: ThumbsDown, label: "Rejected", className: "bg-red-500/15 text-red-500" },
};

/**
 * Moat/defensibility layer (PDF §4): a real, queryable judgment-call track
 * record — every time Koopi's evaluative stance actually flagged a
 * disagreement or named risk (not just agreed), and every proposed change a
 * human actually resolved, lands in `judgment_calls`
 * (20260829_add_judgment_calls.sql) and shows up here. The "hand-off
 * reliability" stat is computed straight from that same real data — never a
 * fabricated score, and deliberately absent for anyone with zero resolved
 * proposals yet, since an invented 100% would be worse than no number at
 * all. Visible to every room participant (unlike the Changes queue, this
 * isn't private-until-reviewed — the whole point of a track record is that
 * the squad shares it).
 */
export default function JudgmentLog({
  roomId,
  members,
  onClose,
}: {
  roomId: string;
  members: RoomMember[];
  onClose: () => void;
}) {
  const [rows, setRows] = useState<JudgmentCallRow[]>([]);
  const memberById = useMemo(() => new Map(members.map((m) => [m.userId, m])), [members]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  useEffect(() => {
    const supabase = createClient();
    let cancelled = false;
    void supabase
      .from("judgment_calls")
      .select("*")
      .eq("room_id", roomId)
      .order("created_at", { ascending: false })
      .limit(200)
      .then(({ data }) => {
        if (!cancelled && data) setRows(data.map(rowToJudgmentCall));
      });

    const channel = supabase
      .channel(`judgment-calls:${roomId}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "judgment_calls", filter: `room_id=eq.${roomId}` },
        (payload) => {
          setRows((prev) => [rowToJudgmentCall(payload.new as Record<string, unknown>), ...prev]);
        }
      )
      .subscribe();

    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
    };
  }, [roomId]);

  function who(userId: string | null) {
    if (!userId) return "Koopi";
    return memberById.get(userId)?.username ?? "Someone";
  }

  // Only ever counts change_approved/change_rejected — a 'flagged' row is
  // Koopi's own call, not a hand-off, and doesn't belong in anyone's ratio.
  const reliability = useMemo(() => {
    const stats = new Map<string, { approved: number; rejected: number }>();
    for (const r of rows) {
      if (r.kind !== "change_approved" && r.kind !== "change_rejected") continue;
      if (!r.subjectUserId) continue;
      const s = stats.get(r.subjectUserId) ?? { approved: 0, rejected: 0 };
      if (r.kind === "change_approved") s.approved++;
      else s.rejected++;
      stats.set(r.subjectUserId, s);
    }
    return stats;
  }, [rows]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[80vh] w-full max-w-lg flex-col rounded-xl border border-border bg-surface p-6 shadow-2xl"
      >
        <div className="mb-1 flex items-center justify-between">
          <h2 className="flex items-center gap-2 font-display text-base font-semibold">
            <Scale className="h-4 w-4" strokeWidth={1.75} />
            Judgment log
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-muted transition-colors hover:text-foreground"
          >
            <X className="h-4 w-4" strokeWidth={1.75} />
          </button>
        </div>
        <p className="mb-4 text-xs text-muted">
          Every real conflict/risk Koopi flagged, and every proposed change someone actually
          resolved — a record, not a vibe.
        </p>

        {reliability.size > 0 && (
          <div className="mb-4 space-y-1.5 rounded-lg border border-border p-3">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted">
              Hand-off reliability
            </p>
            {[...reliability.entries()].map(([userId, s]) => {
              const total = s.approved + s.rejected;
              const pct = Math.round((s.approved / total) * 100);
              return (
                <div key={userId} className="flex items-center justify-between gap-2 text-xs">
                  <span className="flex items-center gap-1.5 text-foreground">
                    <Avatar name={who(userId)} size="sm" />
                    {who(userId)}
                  </span>
                  <span className="text-muted">
                    {s.approved}/{total} approved as-is ({pct}%)
                  </span>
                </div>
              );
            })}
          </div>
        )}

        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto">
          {rows.length === 0 && <p className="text-xs text-muted">Nothing logged yet.</p>}
          {rows.map((r) => {
            const meta = KIND_META[r.kind];
            const Icon = meta.icon;
            return (
              <div key={r.id} className="rounded-lg border border-border p-2.5 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <span
                    className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium ${meta.className}`}
                  >
                    <Icon className="h-3 w-3" strokeWidth={2} />
                    {meta.label}
                  </span>
                  <span className="text-[10px] text-muted">
                    {new Date(r.createdAt).toLocaleString()}
                  </span>
                </div>
                <p className="mt-1.5 text-[11px] leading-relaxed text-foreground">{r.summary}</p>
                <p className="mt-1 text-[10px] text-muted">
                  {r.kind === "flagged"
                    ? `About ${who(r.subjectUserId)}`
                    : `Proposed by ${who(r.subjectUserId)} · resolved by ${who(r.decidedBy)}`}
                </p>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
