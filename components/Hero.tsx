import Link from "next/link";
import BackgroundGrid from "@/components/BackgroundGrid";

export default function Hero() {
  return (
    <section id="top" className="relative overflow-hidden">
      <BackgroundGrid />

      <div className="mx-auto max-w-6xl px-6 pb-20 pt-28 sm:pb-28 sm:pt-36">
        <div className="mx-auto max-w-3xl text-center">
          <h1 className="text-balance font-display text-4xl font-bold tracking-tight sm:text-6xl">
            What will you
            <span className="relative inline-block w-0 align-baseline">
              <span className="pointer-events-none absolute -top-12 left-1.5 flex -translate-x-1/2 -rotate-6 flex-col items-center sm:-top-16">
                <span className="font-sans text-2xl italic text-red-500 sm:text-3xl">
                  guys
                </span>
                <span className="font-sans -mt-1 text-xl leading-none text-red-500">
                  v
                </span>
              </span>
            </span>{" "}
            make today?
          </h1>

          <p className="mx-auto mt-6 max-w-xl text-balance text-base text-muted sm:text-lg">
            Real-time multiplayer AI agent sessions for dev teams — code
            together, steer the agent together, ship together.
          </p>

          <div className="mt-10 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Link
              href="/auth"
              className="w-full rounded-md bg-accent px-6 py-3 font-display text-base font-medium text-accent-foreground transition-opacity hover:opacity-90 sm:w-auto"
            >
              Let&apos;s build
            </Link>
            <a
              href="#features"
              className="w-full rounded-md border border-border px-6 py-3 font-display text-base font-medium text-foreground transition-colors hover:border-muted sm:w-auto"
            >
              See how it works
            </a>
          </div>
        </div>
      </div>
    </section>
  );
}
