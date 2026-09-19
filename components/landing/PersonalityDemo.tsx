"use client";

import { useState } from "react";
import { FRAME, KoopiMark } from "@/components/landing/ui";
import Avatar from "@/components/Avatar";

// Sample replies only. The five tones mirror the real thread-wide personalities.
const TONES = [
  {
    key: "default",
    label: "Default",
    reply:
      "The build failed because settings/page.tsx imports ThemeToggle from a file that doesn't exist yet. Adding components/ThemeToggle.tsx should fix it.",
  },
  {
    key: "concise",
    label: "Concise",
    reply: "Missing file: components/ThemeToggle.tsx. Create it and rebuild.",
  },
  {
    key: "explanatory",
    label: "Explanatory",
    reply:
      "The build stops at the ThemeToggle import in settings/page.tsx. That path doesn't exist yet, so the bundler can't resolve it, and anything that imports the settings page fails with it. Creating components/ThemeToggle.tsx resolves the import.",
  },
  {
    key: "casual",
    label: "Casual",
    reply: "Ha, I imported ThemeToggle before actually making it. Easy fix: I'll add the file and rerun the build.",
  },
  {
    key: "direct",
    label: "Direct",
    reply: "My mistake. I imported ThemeToggle and never created it. Fixing that now.",
  },
] as const;

export default function PersonalityDemo() {
  const [active, setActive] = useState<(typeof TONES)[number]["key"]>("default");
  const tone = TONES.find((t) => t.key === active) ?? TONES[0];

  return (
    <div className={FRAME}>
      <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-3">
        <p className="font-display text-sm font-semibold">
          <span className="mr-1 text-muted">#</span>settings-page
        </p>
        <p className="font-sans text-[11px] text-muted">Tone for this thread</p>
      </div>

      <div role="radiogroup" aria-label="Tone for Koopi" className="flex flex-wrap gap-2 border-b border-border px-5 py-3">
        {TONES.map((t) => {
          const on = t.key === active;
          return (
            <button
              key={t.key}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => setActive(t.key)}
              className={`rounded-md border px-3 py-1.5 font-sans text-xs font-medium transition-colors duration-150 ${
                on
                  ? "border-accent bg-accent/15 text-accent-text"
                  : "border-border-strong text-muted hover:bg-surface-2 hover:text-foreground"
              }`}
            >
              {t.label}
            </button>
          );
        })}
      </div>

      <div className="min-h-[200px] space-y-5 px-5 py-5">
        <div className="flex gap-3">
          <Avatar name="Maya" size="sm" />
          <div>
            <p className="text-[13px] font-semibold">Maya</p>
            <p className="mt-0.5 font-sans text-[13px] leading-relaxed text-foreground/90">
              <span className="text-accent-text">@Koopi</span> why did the build fail?
            </p>
          </div>
        </div>
        <div className="flex gap-3">
          <KoopiMark />
          <div key={active} className="swap-in min-w-0">
            <p className="text-[13px] font-semibold">Koopi</p>
            <p className="mt-0.5 font-sans text-[13px] leading-relaxed text-foreground/90" aria-live="polite">
              {tone.reply}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
