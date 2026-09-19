import { Sparkles, TriangleAlert } from "lucide-react";
import Reveal from "@/components/landing/Reveal";
import { FRAME, Step } from "@/components/landing/ui";

// Sample content, shaped like the real catch-up card: a short summary, then
// flagged items listed in full.
export default function CatchUpDemo() {
  return (
    <Reveal>
      <p className="sr-only">
        A sample catch-up: after 14 missed messages, Koopi summarizes that the dark mode toggle was requested,
        steered and approved, and lists one flagged risk.
      </p>
      <div aria-hidden="true" className={FRAME}>
        <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-3">
          <p className="font-display text-sm font-semibold">
            <span className="mr-1 text-muted">#</span>settings-page
          </p>
          <p className="font-sans text-[11px] text-muted">Back from lunch</p>
        </div>

        <div className="space-y-3 px-5 py-5">
          <Step i={0}>
            <div className="flex items-center justify-between gap-2 rounded-lg border border-accent/30 bg-accent/5 px-3 py-2 font-sans text-xs">
              <span className="text-foreground">You missed 14 messages here.</span>
              <span className="rounded-md bg-accent px-2.5 py-1 font-medium text-accent-foreground">Catch me up</span>
            </div>
          </Step>

          <Step i={1}>
            <div className="overflow-hidden rounded-lg border border-accent/30 bg-accent/5">
              <div className="flex items-center gap-1.5 border-b border-accent/20 px-3 py-1.5">
                <Sparkles className="h-3.5 w-3.5 text-accent-text" strokeWidth={2} />
                <span className="font-sans text-xs font-medium">Catch-up</span>
              </div>
              <div className="px-3 py-3 font-sans text-[13px] leading-relaxed">
                <p className="text-foreground/90">
                  Maya asked for a dark mode toggle. Jonas steered Koopi to reuse the existing theme tokens, and
                  Priya approved the one-file change. The onboarding copy question is still open.
                </p>
                <p className="mt-3 flex items-start gap-1.5 border-t border-border pt-3 text-xs text-amber-400">
                  <TriangleAlert className="mt-0.5 h-3 w-3 shrink-0" strokeWidth={2} />
                  Flagged: the first draft added new hex colors that bypass the theme tokens.
                </p>
              </div>
            </div>
          </Step>
        </div>
      </div>
    </Reveal>
  );
}
