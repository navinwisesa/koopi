import { Users, SquareArrowOutUpRight, BrainCircuit, GitBranch } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import ScrollIn from "@/components/landing/ScrollIn";

type Feature = {
  icon: LucideIcon;
  title: string;
  description: string;
};

const features: Feature[] = [
  {
    icon: Users,
    title: "Shared Workspace",
    description:
      "Real-time multiplayer editing and shared agent execution — everyone sees the same session, live.",
  },
  {
    icon: SquareArrowOutUpRight,
    title: "Mid-Stream Steering",
    description:
      "Interrupt or redirect the agent, any teammate, any time — no waiting for a run to finish to change course.",
  },
  {
    icon: BrainCircuit,
    title: "Squad Memory",
    description:
      "The agent gets smarter about how your team works, the longer you use it — conventions, context, and all.",
  },
  {
    icon: GitBranch,
    title: "No-Git Vibe-Coding",
    description:
      "Parallel sandboxes that auto-integrate, no manual merge conflicts — branch freely, converge automatically.",
  },
];

export default function Features() {
  return (
    <section id="features" className="border-t border-border">
      <div className="mx-auto grid max-w-6xl gap-12 px-6 py-20 sm:py-28 lg:grid-cols-[5fr_7fr] lg:gap-20">
        <ScrollIn className="lg:sticky lg:top-28 lg:self-start">
          <h2 className="text-balance font-display text-3xl font-semibold leading-tight tracking-tight sm:text-4xl">
            Built for teams who ship
          </h2>
          <p className="mt-4 max-w-md text-pretty leading-relaxed text-muted">
            Koopi drops your whole squad into the same AI coding session — no hand-offs, no merge hell, no waiting
            your turn.
          </p>
        </ScrollIn>

        <ul className="border-t border-border">
          {features.map(({ icon: Icon, title, description }, idx) => (
            <li key={title} className="border-b border-border">
              <ScrollIn delay={idx * 90} className="grid grid-cols-[2rem_1fr] gap-x-4 py-7">
                <Icon className="mt-1 h-5 w-5 text-accent-text" strokeWidth={1.75} aria-hidden="true" />
                <div>
                  <h3 className="font-display text-xl font-semibold">{title}</h3>
                  <p className="mt-2 max-w-[58ch] leading-relaxed text-muted">{description}</p>
                </div>
              </ScrollIn>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
