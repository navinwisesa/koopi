import { BrainCircuit } from "lucide-react";
import Avatar from "@/components/Avatar";
import Reveal from "@/components/landing/Reveal";
import { FRAME, KoopiMark, Step } from "@/components/landing/ui";

// Sample content: a decision made in one thread, used by Koopi in another.
export default function MemoryDemo() {
  return (
    <Reveal>
      <p className="sr-only">
        A sample of room memory: Jonas says in one thread that prices are stored in cents, and later Koopi
        applies that in a different thread and marks its reply as using room memory.
      </p>
      <div aria-hidden="true" className={FRAME}>
        <Step i={0}>
          <div className="border-b border-border px-5 py-4">
            <p className="font-sans text-[11px] text-muted">
              <span className="mr-0.5">#</span>billing-bug · Tuesday
            </p>
            <div className="mt-3 flex gap-3">
              <Avatar name="Jonas" size="sm" />
              <div>
                <p className="text-[13px] font-semibold">Jonas</p>
                <p className="mt-0.5 font-sans text-[13px] leading-relaxed text-foreground/90">
                  Heads up: we store prices in cents, never floats.
                </p>
              </div>
            </div>
          </div>
        </Step>

        <Step i={1}>
          <div className="px-5 py-4">
            <p className="font-sans text-[11px] text-muted">
              <span className="mr-0.5">#</span>pricing-table · Today
            </p>
            <div className="mt-3 space-y-4">
              <div className="flex gap-3">
                <Avatar name="Priya" size="sm" />
                <div>
                  <p className="text-[13px] font-semibold">Priya</p>
                  <p className="mt-0.5 font-sans text-[13px] leading-relaxed text-foreground/90">
                    <span className="text-accent-text">@Koopi</span> add a Pro plan at $12 a month
                  </p>
                </div>
              </div>
              <div className="flex gap-3">
                <KoopiMark />
                <div>
                  <p className="flex flex-wrap items-baseline gap-x-2 text-[13px] font-semibold">
                    Koopi
                    <span className="inline-flex items-center gap-1 rounded bg-accent/15 px-1.5 py-px font-sans text-[10px] font-semibold text-accent-text">
                      <BrainCircuit className="h-2.5 w-2.5" strokeWidth={2} />
                      Room memory
                    </span>
                  </p>
                  <p className="mt-0.5 font-sans text-[13px] leading-relaxed text-foreground/90">
                    Added the Pro plan as 1200 cents, since Jonas said in #billing-bug that prices are stored in
                    cents.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </Step>
      </div>
    </Reveal>
  );
}
