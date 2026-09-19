import Avatar from "@/components/Avatar";
import Reveal from "@/components/landing/Reveal";
import { Step, KoopiMark } from "@/components/landing/ui";

// Synthetic sample content — names and messages are illustrative, not real users.
// Decorative: the accessible summary lives in the sr-only paragraph.

function Message({
  name,
  time,
  children,
  tag,
}: {
  name: string;
  time: string;
  children: React.ReactNode;
  tag?: string;
}) {
  return (
    <div className="flex gap-3">
      {name === "Koopi" ? <KoopiMark /> : <Avatar name={name} size="sm" />}
      <div className="min-w-0">
        <p className="flex flex-wrap items-baseline gap-x-2 text-[13px] font-semibold text-foreground">
          {name}
          <span className="font-sans text-[11px] font-normal text-muted">{time}</span>
          {tag && (
            <span className="rounded bg-accent/15 px-1.5 py-px font-sans text-[10px] font-semibold text-accent-text">
              {tag}
            </span>
          )}
        </p>
        <p className="mt-0.5 font-sans text-[13px] leading-relaxed text-foreground/90">{children}</p>
      </div>
    </div>
  );
}

const THREADS = ["settings-page", "billing-bug", "onboarding-copy"];
const MEMBERS = ["Maya", "Jonas", "Priya"];

export default function RoomDemo() {
  return (
    <Reveal>
      <p className="sr-only">
        A sample Koopi room. Maya asks Koopi to add a dark mode toggle, Jonas redirects it mid-run to use the
        existing theme tokens, and Priya approves the proposed one-file change.
      </p>

      <div
        aria-hidden="true"
        className="flex h-[480px] overflow-hidden rounded-xl border border-border-strong bg-surface shadow-[0_40px_80px_-30px_rgba(0,0,0,0.9),0_2px_0_0_rgba(255,255,255,0.04)_inset] sm:h-[440px]"
      >
        {/* Threads and people */}
        <aside className="hidden w-52 shrink-0 flex-col border-r border-border bg-background/60 p-4 lg:flex">
          <p className="font-display text-sm font-bold">Northwind app</p>
          <p className="mt-5 font-sans text-[11px] font-semibold uppercase tracking-wide text-muted">Threads</p>
          <ul className="mt-2 space-y-0.5 font-sans text-[13px]">
            {THREADS.map((t, idx) => (
              <li
                key={t}
                className={`rounded-md px-2 py-1.5 ${
                  idx === 0 ? "bg-surface-2 text-foreground" : "text-muted"
                }`}
              >
                <span className="mr-1 text-muted">#</span>
                {t}
              </li>
            ))}
          </ul>
          <p className="mt-6 font-sans text-[11px] font-semibold uppercase tracking-wide text-muted">In this room</p>
          <ul className="mt-2 space-y-2 font-sans text-[13px]">
            {MEMBERS.map((m) => (
              <li key={m} className="flex items-center gap-2">
                <Avatar name={m} size="sm" />
                <span>{m}</span>
                <span className="ml-auto h-1.5 w-1.5 rounded-full bg-emerald-400" />
              </li>
            ))}
            <li className="flex items-center gap-2">
              <KoopiMark />
              <span>Koopi</span>
              <span className="demo-pulse ml-auto h-1.5 w-1.5 rounded-full bg-accent-text" />
            </li>
          </ul>
        </aside>

        {/* Conversation */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center gap-3 border-b border-border px-5 py-3">
            <p className="font-display text-sm font-semibold">
              <span className="mr-1 text-muted">#</span>settings-page
            </p>
            <div className="ml-auto flex -space-x-1.5">
              {MEMBERS.map((m) => (
                <Avatar key={m} name={m} size="sm" className="ring-2 ring-surface" />
              ))}
            </div>
          </div>

          <div className="flex-1 space-y-5 overflow-hidden px-5 py-5">
            <Step i={0}>
              <Message name="Maya" time="10:42">
                <span className="text-accent-text">@Koopi</span> add a dark mode toggle to the settings page
              </Message>
            </Step>

            <Step i={1}>
              <div className="flex items-center gap-2 rounded-md border border-border bg-background/50 px-3 py-2 font-sans text-xs text-muted">
                <span className="demo-pulse h-1.5 w-1.5 rounded-full bg-accent-text" />
                Koopi is editing
                <code className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] text-foreground/90">
                  app/settings/page.tsx
                </code>
              </div>
            </Step>

            <Step i={2}>
              <Message name="Jonas" time="10:43" tag="Steered mid-run">
                Use the theme tokens we already have — no new hex colors.
              </Message>
            </Step>

            <Step i={3}>
              <Message name="Koopi" time="10:43">
                Switched to the tokens in globals.css. One file changed. I put the diff in Changes for review.
              </Message>
            </Step>

            <Step i={4}>
              <Message name="Priya" time="10:46">
                Toggle looks right on my end. Approving.
              </Message>
            </Step>
          </div>

          <Step i={4} className="flex items-center gap-2 border-t border-border px-4 py-2.5 md:hidden">
            <p className="min-w-0 flex-1 truncate font-sans text-xs text-muted">
              <span className="font-semibold text-foreground">Dark mode toggle</span> · 1 file
            </p>
            <span className="rounded-md border border-border-strong px-2.5 py-1 font-sans text-xs font-medium">Reject</span>
            <span className="rounded-md bg-accent px-2.5 py-1 font-sans text-xs font-medium text-accent-foreground">
              Approve
            </span>
          </Step>

          <div className="border-t border-border p-3">
            <div className="rounded-md border border-border bg-background/60 px-3 py-2.5 font-sans text-[13px] text-muted">
              Message the room. Mention @Koopi to ask the agent.
            </div>
          </div>
        </div>

        {/* Proposed change */}
        <aside className="hidden w-72 shrink-0 flex-col border-l border-border bg-background/60 md:flex">
          <div className="border-b border-border px-4 py-3">
            <p className="font-display text-sm font-semibold">Changes</p>
          </div>
          <Step i={4} className="p-4">
            <p className="font-display text-sm font-semibold">Dark mode toggle</p>
            <p className="mt-1 font-sans text-xs text-muted">1 file · proposed by Koopi</p>

            <div className="mt-3 overflow-hidden rounded-md border border-border font-mono text-[11px] leading-relaxed">
              <p className="border-b border-border bg-surface-2 px-2.5 py-1.5 text-muted">app/settings/page.tsx</p>
              <p className="bg-red-500/10 px-2.5 py-0.5 text-red-300">- const bg = &quot;#0a0a0b&quot;;</p>
              <p className="bg-emerald-500/10 px-2.5 py-0.5 text-emerald-300">+ const bg = &quot;var(--background)&quot;;</p>
              <p className="bg-emerald-500/10 px-2.5 py-0.5 text-emerald-300">+ &lt;ThemeToggle /&gt;</p>
            </div>

            <div className="mt-4 flex items-center gap-2">
              <span className="rounded-md border border-border-strong px-3 py-1.5 font-sans text-xs font-medium text-foreground">
                Reject
              </span>
              <span className="rounded-md bg-accent px-3 py-1.5 font-sans text-xs font-medium text-accent-foreground">
                Approve
              </span>
            </div>
          </Step>
          <Step i={5} className="mx-4 mt-2 border-t border-border pt-4 font-sans text-xs text-muted">
            <p className="flex items-center gap-2">
              <span className="h-1.5 w-1.5 rounded-full bg-muted" />
              Koopi proposed · 10:43
            </p>
            <p className="mt-2 flex items-center gap-2 text-foreground/90">
              <span className="h-1.5 w-1.5 rounded-full bg-accent-text" />
              Priya is reviewing · 10:46
            </p>
          </Step>
        </aside>
      </div>
      <p className="mt-3 font-sans text-xs text-muted">Sample room with illustrative data.</p>
    </Reveal>
  );
}
