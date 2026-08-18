"use client";

import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Settings2, Minimize2, BookOpen, Smile, Target } from "lucide-react";
import { createClient } from "@/lib/supabase/client";

export type Personality = "default" | "concise" | "explanatory" | "casual" | "direct";

const PERSONALITIES: {
  key: Personality;
  label: string;
  description: string;
  icon: typeof Settings2;
}[] = [
  { key: "default", label: "Default", description: "Balanced, clear, professional.", icon: Settings2 },
  { key: "concise", label: "Concise", description: "Brief — the direct answer, no preamble.", icon: Minimize2 },
  { key: "explanatory", label: "Explanatory", description: "Walks through its reasoning, not just the result.", icon: BookOpen },
  { key: "casual", label: "Casual", description: "Relaxed and informal, still fully accurate.", icon: Smile },
  { key: "direct", label: "Direct", description: "Blunt and matter-of-fact, not diplomatic-by-default.", icon: Target },
];

// Thread-wide (not room-wide, not per-person) — any participant in THIS
// thread can change it, and everyone's @Koopi replies in this specific
// thread pick it up on their next message via realtime. A sibling thread
// in the same room keeps whatever it's independently set to.
export default function PersonalitySelector({
  threadId,
  personality,
  onChanged,
}: {
  threadId: string;
  personality: Personality;
  onChanged: (next: Personality) => void;
}) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    function onPointerDown(e: MouseEvent) {
      if (!wrapperRef.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  async function select(next: Personality) {
    setOpen(false);
    if (next === personality) return;

    const prev = personality;
    onChanged(next);
    setSaving(true);

    const { error } = await createClient().rpc("update_thread_personality", {
      p_thread_id: threadId,
      p_personality: next,
    });

    setSaving(false);
    if (error) {
      // The optimistic onChanged(next) above already visibly reverts here —
      // this is just for debuggability, not a new user-facing surface: a
      // low-stakes, one-click-to-retry preference toggle doesn't carry the
      // same "did my approval actually land" stakes the other fixes this
      // session addressed.
      console.error(`PersonalitySelector: failed to save personality for thread ${threadId}`, error);
      onChanged(prev);
    }
  }

  const current = PERSONALITIES.find((p) => p.key === personality) ?? PERSONALITIES[0];
  const CurrentIcon = current.icon;

  return (
    <div ref={wrapperRef} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Koopi's response style for this thread"
        disabled={saving}
        className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs text-muted transition-colors hover:text-foreground disabled:opacity-60"
      >
        <CurrentIcon className="h-3.5 w-3.5" strokeWidth={1.75} />
        <span className="hidden sm:inline">{current.label}</span>
        <ChevronDown className="h-3 w-3" strokeWidth={2} />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 z-50 mt-2 w-64 overflow-hidden rounded-lg border border-border bg-surface shadow-xl"
        >
          <div className="border-b border-border px-3 py-2">
            <p className="font-sans text-[11px] font-semibold uppercase tracking-wider text-muted">
              Koopi&apos;s style in this thread
            </p>
          </div>
          <ul>
            {PERSONALITIES.map(({ key, label, description, icon: Icon }) => (
              <li key={key}>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => void select(key)}
                  className="flex w-full items-start gap-2.5 px-3 py-2.5 text-left transition-colors hover:bg-background"
                >
                  <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted" strokeWidth={1.75} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5 font-display text-sm font-medium text-foreground">
                      {label}
                      {key === personality && (
                        <Check className="h-3.5 w-3.5 text-accent" strokeWidth={2.5} />
                      )}
                    </span>
                    <span className="mt-0.5 block text-xs text-muted">{description}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
