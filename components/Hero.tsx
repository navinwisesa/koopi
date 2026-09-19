import Link from "next/link";
import BackgroundGrid from "@/components/BackgroundGrid";
import RoomDemo from "@/components/landing/RoomDemo";

export default function Hero() {
  return (
    <section id="top" className="relative overflow-hidden">
      <BackgroundGrid />

      <div className="mx-auto max-w-6xl px-6 pb-20 pt-20 sm:pb-28 sm:pt-28">
        <h1 className="text-balance font-display text-5xl font-bold leading-[1.28] tracking-[-0.025em] md:leading-[0.98] sm:text-7xl lg:text-[5.5rem]">
          What will{" "}
          <span className="whitespace-nowrap">
            you
            <span className="relative inline-block w-0 align-baseline">
              <span
                aria-hidden="true"
                className="pointer-events-none absolute bottom-[0.62em] left-[0.28em] flex -translate-x-1/2 -rotate-6 flex-col items-center text-accent-text"
              >
                <span className="font-sans text-[0.36em] font-semibold italic leading-none">guys</span>
                <svg viewBox="0 0 16 10" className="mt-[0.06em] h-[0.16em] w-[0.26em]" fill="none">
                  <path d="M1 1.5 8 8.5l7-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </span>
            </span>{" "}
            make
          </span>{" "}
          today?
        </h1>

        <div className="mt-8 flex flex-col gap-8 sm:mt-10 sm:flex-row sm:items-end sm:justify-between">
          <p className="max-w-xl text-balance text-lg leading-snug text-muted sm:text-xl">
            Real-time multiplayer AI agent sessions for dev teams. Code together, steer the agent together, ship
            together.
          </p>

          <div className="flex flex-col gap-3 sm:flex-row">
            <Link
              href="/auth"
              className="rounded-md bg-accent px-6 py-3 text-center font-display text-base font-medium text-accent-foreground transition-[background-color,transform] duration-150 hover:bg-[#1f3af5] active:translate-y-px"
            >
              Let&apos;s build
            </Link>
            <a
              href="#features"
              className="rounded-md border border-border-strong px-6 py-3 text-center font-display text-base font-medium text-foreground transition-colors duration-150 hover:bg-surface-2"
            >
              See how it works
            </a>
          </div>
        </div>

        <div className="mt-14 sm:mt-16">
          <RoomDemo />
        </div>
      </div>
    </section>
  );
}
