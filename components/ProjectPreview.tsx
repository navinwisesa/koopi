"use client";

import { ExternalLink, Loader2, AlertTriangle, Globe } from "lucide-react";
import type { ProjectRunState } from "@/components/RoomView";

/**
 * Live web-app preview status — shown instead of ProjectTerminal for a
 * project ProjectPanel has detected as a web app (see
 * lib/webAppFramework.ts). Unlike a script run there's no stdout/stderr
 * transcript to stream — a dev/static server either isn't up, is up, or
 * failed to start — so this is entirely derived from runState's preview_*
 * fields rather than subscribing to its own broadcast channel: RoomView's
 * existing `projects` realtime subscription already keeps those fresh for
 * every viewer, the same source ProjectTerminal's non-streaming fields
 * (lastRunAt, lastRunBy, ...) already rely on.
 */
export default function ProjectPreview({
  runState,
  onRequestFreshLink,
  freshLinkDisabled,
}: {
  runState: ProjectRunState;
  // Passive recovery affordance for the one thing preview_status can't ever
  // know on its own: whether the URL it's showing still actually resolves.
  // A sandbox can pause/expire without this room hearing about it — the
  // next Run/Restart already reconnects-or-recreates and broadcasts
  // whatever URL results (see lib/webAppSandbox.ts's acquireSandbox), so
  // "get a fresh link" is just that same flow, offered right where someone
  // would notice the current one is dead instead of only via the bigger
  // Restart button. Optional so a caller that never wires it up (there
  // isn't one today, but nothing requires there to be) still renders fine
  // with the affordance simply omitted.
  onRequestFreshLink?: () => void;
  freshLinkDisabled?: boolean;
}) {
  const { previewStatus, previewUrl, previewError, previewFramework } = runState;

  return (
    <div className="shrink-0 border-t border-border bg-background px-4 py-2.5">
      <div className="flex items-center gap-2 text-xs">
        <Globe className="h-3.5 w-3.5 shrink-0 text-muted" strokeWidth={1.75} />
        {previewStatus === "starting" && (
          <span className="flex items-center gap-1.5 text-muted">
            <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.75} />
            {previewFramework === "next"
              ? "Installing dependencies and starting the dev server…"
              : "Starting…"}
          </span>
        )}
        {previewStatus === "running" && previewUrl && (
          <>
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" aria-hidden="true" />
            <span className="shrink-0 text-foreground">Live</span>
            <a
              href={previewUrl}
              target="_blank"
              rel="noreferrer"
              className="flex min-w-0 items-center gap-1 truncate text-accent underline-offset-2 hover:underline"
            >
              <span className="truncate">{previewUrl}</span>
              <ExternalLink className="h-3 w-3 shrink-0" strokeWidth={2} />
            </a>
            {onRequestFreshLink && (
              <button
                type="button"
                onClick={onRequestFreshLink}
                disabled={freshLinkDisabled}
                className="ml-auto shrink-0 text-muted underline-offset-2 hover:text-foreground hover:underline disabled:opacity-50"
              >
                Not loading? Get a fresh link
              </button>
            )}
          </>
        )}
        {previewStatus === "error" && (
          <span className="flex items-center gap-1.5 text-red-400">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" strokeWidth={1.75} />
            {previewError ?? "The preview failed to start."}
          </span>
        )}
        {previewStatus === "idle" && <span className="text-muted">Click Run to serve this app live.</span>}
      </div>
    </div>
  );
}
