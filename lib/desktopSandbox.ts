import { Sandbox as DesktopSandbox } from "@e2b/desktop";

// A live-viewing session, not a persisted resource like rooms.sandbox_id — one
// fresh desktop per request, self-expiring via E2B's own timeout rather than
// anything this app tracks or reconnects to.
const DESKTOP_TIMEOUT_MS = 5 * 60_000;

export type GuiSessionResult = {
  streamUrl: string | null;
  error: string | null;
};

/**
 * Runs GUI-toolkit code (Tkinter, Pygame, etc.) inside a real virtual desktop —
 * E2B's plain `Sandbox` (lib/sandbox.ts) is headless and such code crashes
 * there with "no display" errors. Returns a URL to a live, watchable (and
 * interactive) view of the desktop rather than stdout/stderr — the point isn't
 * the exit code, it's seeing the window.
 *
 * Auth-gated: the URL carries a one-time key (`requireAuth`), not a fully
 * public link, since it's shared into a chat message anyone in the room can
 * see and could otherwise leak beyond the room's own RLS-protected access.
 */
export async function runGuiSession(code: string, language: string): Promise<GuiSessionResult> {
  let desktop: DesktopSandbox | undefined;
  try {
    desktop = await DesktopSandbox.create({ timeoutMs: DESKTOP_TIMEOUT_MS });

    const isPython = language.trim().toLowerCase() === "python";
    const path = isPython ? "/home/user/app.py" : "/home/user/app.sh";
    const cmd = isPython ? `python3 ${path}` : `bash ${path}`;

    if (isPython) {
      // Confirmed empirically: the desktop template's python3 does NOT ship
      // tkinter by default (ModuleNotFoundError on a clean sandbox) — without
      // this, every Tkinter request would "succeed" with a real, reachable
      // stream URL pointing at an empty desktop. Best-effort: if this fails
      // (network hiccup, etc.), the crash-detection check below still catches
      // the resulting ModuleNotFoundError and reports it honestly instead of
      // silently handing back a broken link.
      await desktop.commands
        .run("sudo apt-get update -qq && sudo apt-get install -y -qq python3-tk", { timeoutMs: 60_000 })
        .catch(() => {});
    }

    await desktop.files.write(path, code);
    // Background — DISPLAY is already set by the template, so the window
    // lands on the same virtual desktop the stream below shows.
    const handle = await desktop.commands.run(cmd, { background: true });
    await desktop.wait(2000); // give the window a moment to actually open

    // A GUI app with a real event loop (mainloop(), etc.) is still running at
    // this point — if it already exited, that's a crash (syntax error, import
    // error, ...), not success. Catching this here is the difference between
    // an honest error and silently handing back a link to a dead desktop.
    if (handle.exitCode !== undefined) {
      const stderr = handle.stderr?.trim();
      await desktop.kill().catch(() => {});
      return {
        streamUrl: null,
        error: stderr || `App exited immediately with exit code ${handle.exitCode}.`,
      };
    }

    await desktop.stream.start({ requireAuth: true });
    const authKey = desktop.stream.getAuthKey();
    const streamUrl = desktop.stream.getUrl({ authKey });

    return { streamUrl, error: null };
  } catch (err) {
    await desktop?.kill().catch(() => {});
    return {
      streamUrl: null,
      error: err instanceof Error ? err.message : "Failed to start GUI session.",
    };
  }
}
