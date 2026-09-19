import { ThumbsUp, ThumbsDown, TriangleAlert } from "lucide-react";
import Avatar from "@/components/Avatar";

// Synthetic sample content, in the same three kinds the real judgment log records.
const ROWS = [
  {
    kind: "approved",
    who: "Priya",
    time: "10:46",
    text: "Approved “Dark mode toggle” — 1 file",
  },
  {
    kind: "flagged",
    who: "Koopi",
    time: "10:43",
    text: "Flagged: the first draft added new hex colors that bypass the theme tokens",
  },
  {
    kind: "rejected",
    who: "Jonas",
    time: "Yesterday",
    text: "Rejected “Inline styles for pricing table”",
  },
] as const;

const KIND = {
  approved: { icon: ThumbsUp, label: "Approved", className: "bg-accent/15 text-accent-text" },
  flagged: { icon: TriangleAlert, label: "Flagged", className: "bg-amber-500/15 text-amber-400" },
  rejected: { icon: ThumbsDown, label: "Rejected", className: "bg-red-500/15 text-red-400" },
} as const;

export default function JudgmentDemo() {
  return (
    <div
      aria-hidden="true"
      className="overflow-hidden rounded-xl border border-border-strong bg-surface shadow-[0_30px_60px_-30px_rgba(0,0,0,0.9)]"
    >
      <div className="flex items-center border-b border-border px-5 py-3">
        <p className="font-display text-sm font-semibold">Judgment log</p>
      </div>
      <ul className="divide-y divide-border">
        {ROWS.map((row) => {
          const meta = KIND[row.kind];
          const Icon = meta.icon;
          return (
            <li key={row.text} className="flex items-start gap-3 px-5 py-4">
              {row.who === "Koopi" ? (
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-accent font-display text-[11px] font-bold text-accent-foreground">
                  K
                </span>
              ) : (
                <Avatar name={row.who} size="sm" />
              )}
              <div className="min-w-0 flex-1">
                <p className="font-sans text-[13px] leading-relaxed text-foreground/90">{row.text}</p>
                <p className="mt-1 font-sans text-[11px] text-muted">
                  {row.who} · {row.time}
                </p>
              </div>
              <span
                className={`flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 font-sans text-[11px] font-semibold ${meta.className}`}
              >
                <Icon className="h-3 w-3" strokeWidth={2} />
                {meta.label}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
