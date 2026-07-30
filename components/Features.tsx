import { Users, SquareArrowOutUpRight, BrainCircuit, GitBranch } from "lucide-react";
import type { LucideIcon } from "lucide-react";

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
    <section id="features" className="mx-auto max-w-6xl px-6 py-20 sm:py-28">
      <div className="mx-auto mb-14 max-w-2xl text-center">
        <h2 className="font-display text-3xl font-semibold tracking-tight sm:text-4xl">
          Built for teams who ship
        </h2>
        <p className="mt-4 text-balance text-muted">
          Koopi drops your whole squad into the same AI coding session — no
          hand-offs, no merge hell, no waiting your turn.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {features.map(({ icon: Icon, title, description }) => (
          <div
            key={title}
            className="rounded-lg border border-border bg-surface p-6 transition-colors hover:border-accent/50"
          >
            <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-md bg-accent/10 text-accent">
              <Icon className="h-5 w-5" strokeWidth={1.75} />
            </div>
            <h3 className="font-display text-xl font-semibold">{title}</h3>
            <p className="mt-2 text-sm leading-relaxed text-muted">
              {description}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}
