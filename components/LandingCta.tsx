import Link from "next/link";
import ScrollIn from "@/components/landing/ScrollIn";

export default function LandingCta() {
  return (
    <section id="cta" className="border-t border-border">
      <ScrollIn className="mx-auto flex max-w-6xl flex-col gap-8 px-6 py-20 sm:flex-row sm:items-end sm:justify-between sm:py-28">
        <h2 className="max-w-2xl text-balance font-display text-4xl font-bold leading-[1.02] tracking-[-0.02em] sm:text-6xl">
          Open a room and bring the team.
        </h2>
        <Link
          href="/auth"
          className="self-start rounded-md bg-accent px-6 py-3 font-display text-base font-medium text-accent-foreground transition-[background-color,transform] duration-150 hover:bg-[#1f3af5] active:translate-y-px sm:self-auto"
        >
          Let&apos;s build
        </Link>
      </ScrollIn>
    </section>
  );
}
