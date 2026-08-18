import { createHash } from "node:crypto";
import { Sandbox, CommandExitError, type CommandHandle } from "e2b";
import { joinUnderRoot } from "@/lib/sandbox";

const PROJECT_ROOT = "/tmp/webapp";
const PORT = 3000;
// Sits outside anything `files` ever writes (joinUnderRoot only ever
// produces paths under PROJECT_ROOT for project content), so a scaffold
// can never accidentally shadow or delete it by naming a file the same
// thing. Records the sha256 of the package.json we last ran `npm install`
// for on THIS sandbox — see the skip-install fast path in runWebApp below.
const INSTALL_MARKER_PATH = "/tmp/.koopi-install-hash";

// A live-preview sandbox is fundamentally different from every other class
// in lib/sandbox.ts: those either run to completion (SandboxRun) or hold an
// interactive process open only as long as a human is watching
// (SandboxProjectRun) — both pause on success because nothing needs the
// sandbox to keep serving traffic once the caller's request is done. A dev/
// static server is the opposite: it must keep running (and keep answering
// getHost(PORT)) long after this function returns, so it's never paused on
// success, only killed on a genuine error.
//
// Confirmed live this was the actual cause of "everything gets forgotten
// when the demo refreshes": a demo's client-side state (localStorage,
// including the mock-auth pattern Koopi itself builds for these apps) is
// scoped to the sandbox's own subdomain. Nothing renews this sandbox's
// clock except an explicit Run/Restart/fresh-link click — someone just
// sitting on the live demo tab, using it, generates zero traffic back to
// Koopi — so a 20-minute window lapsed under nothing but normal use,
// the old sandbox became unreachable, and the next click created a brand
// new one on a brand new subdomain: a different origin, so every bit of
// localStorage-backed state (a "logged in" demo session included) was
// gone, not merely reset. 1 hour (the Hobby-tier ceiling itself — see
// SandboxOpts.timeoutMs's own doc — so this is the most headroom available
// without risking an error on that tier) buys real session length on its
// own; requestPreviewHeartbeat below (called periodically while the
// Project panel is open — see ProjectPanel.tsx) is what actually keeps a
// genuinely active session from ever hitting even that.
const WEBAPP_SANDBOX_TIMEOUT_MS = 60 * 60_000;
const NPM_INSTALL_TIMEOUT_MS = 120_000;
const READY_POLL_INTERVAL_MS = 500;

export type WebAppFramework = "static" | "next";

// Static serves instantly — no install, no compile, no framework to boot —
// so a short budget is already generous. "next dev" is a genuinely heavier
// cold start even once npm install has already finished (Next still has to
// boot and do its first compile in a fresh sandbox); confirmed live that a
// single 45s budget for both wasn't always enough for "next", AND — the
// actual bug this was fixed for — gave no way to tell "still booting, just
// needs more time" apart from "crashed outright and will never come up no
// matter how long you wait". waitUntilReady below tells those apart now by
// polling the process's own exit code, not by guessing from a timeout.
const READY_POLL_MAX_TRIES: Record<WebAppFramework, number> = {
  static: 20, // ~10s
  next: 180, // ~90s
};

export type RunWebAppResult = {
  url: string | null;
  sandboxId: string | null;
  error: string | null;
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// npm/Next's own CLI output is colorized — stdout/stderr from a real
// terminal, not plain text. Every error string below is built straight from
// that output and shown as-is in ProjectPreview.tsx's plain-text banner
// (confirmed live: the raw escape bytes render as literal "?[36m"-style
// garbage instead of color, since there's no terminal here to interpret
// them). Stripped once, at the source, so nothing downstream needs to know
// this was ever a concern. Same regex shape as the sindresorhus/strip-ansi
// package (MIT) — inlined rather than adding a dependency for one pattern.
const ANSI_ESCAPE_RE = new RegExp(
  "[\\u001B\\u009B][[\\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\\d/#&.:=?%@~_]+)*|[a-zA-Z\\d]+(?:;[-a-zA-Z\\d/#&.:=?%@~_]*)*)?\\u0007)" +
    "|(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-ntqry=><~]))",
  "g"
);

function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE_RE, "");
}

function packageJsonHash(files: { path: string; content: string }[]): string | null {
  const pkg = files.find((f) => f.path === "package.json");
  return pkg ? createHash("sha256").update(pkg.content).digest("hex") : null;
}

async function acquireSandbox(existingSandboxId?: string | null): Promise<Sandbox> {
  if (existingSandboxId) {
    try {
      return await Sandbox.connect(existingSandboxId, { timeoutMs: WEBAPP_SANDBOX_TIMEOUT_MS });
    } catch (err) {
      console.warn(
        `[webAppSandbox] could not reconnect to ${existingSandboxId}, starting a fresh sandbox instead:`,
        err
      );
    }
  }
  return Sandbox.create({ timeoutMs: WEBAPP_SANDBOX_TIMEOUT_MS });
}

type ReadyOutcome =
  | { status: "ready" }
  | { status: "crashed"; exitCode: number; stdout: string; stderr: string }
  | { status: "timeout"; stdout: string; stderr: string };

/**
 * Polls until the server answers on PORT — but checks the background
 * process's own exit code on every iteration too, not just the HTTP probe.
 * `handle.exitCode`/`.stdout`/`.stderr` are live getters backed by the
 * command's own event stream (confirmed against the installed e2b SDK's
 * type defs, not assumed), so a crash is caught the moment it happens
 * instead of only being discoverable after burning the entire poll budget
 * waiting on a process that already died — which used to surface as the
 * same generic "never came up in time" as a merely-slow start, with no way
 * to tell the two apart.
 */
async function waitUntilReady(
  sandbox: Sandbox,
  handle: CommandHandle,
  maxTries: number
): Promise<ReadyOutcome> {
  for (let i = 0; i < maxTries; i++) {
    if (handle.exitCode !== undefined) {
      return { status: "crashed", exitCode: handle.exitCode, stdout: handle.stdout, stderr: handle.stderr };
    }
    try {
      await sandbox.commands.run(`curl -sf -o /dev/null http://localhost:${PORT}`, {
        timeoutMs: 5_000,
      });
      return { status: "ready" };
    } catch {
      // Not up yet (connection refused, non-2xx, or still compiling) —
      // expected during startup, keep polling rather than treating it as
      // fatal on its own.
    }
    await delay(READY_POLL_INTERVAL_MS);
  }
  return { status: "timeout", stdout: handle.stdout, stderr: handle.stderr };
}

/**
 * Writes a full set of project files into a sandbox, starts serving them on
 * PORT, and returns a live public URL once the server actually answers —
 * never a link to a server that isn't up yet. `framework: "static"` skips
 * any install step entirely (plain HTML/CSS/JS, e.g. a Tailwind-via-CDN
 * landing page) since that's both the common case for "build me a page" asks
 * and dramatically faster/more reliable than spinning up a full dev server
 * for something that doesn't need one. `framework: "next"` runs `npm
 * install` first — the one step in this whole flow genuinely allowed to take
 * a while — before starting `next dev`.
 *
 * Reconnecting to `existingSandboxId` (e.g. the user clicked Run again after
 * an edit) best-effort kills whatever was previously bound to PORT before
 * starting the new server, so a stale process from the last run never blocks
 * the new one with EADDRINUSE.
 */
export async function runWebApp(
  files: { path: string; content: string }[],
  framework: WebAppFramework,
  existingSandboxId?: string | null
): Promise<RunWebAppResult> {
  let sandbox: Sandbox;
  try {
    sandbox = await acquireSandbox(existingSandboxId);
  } catch (err) {
    return {
      url: null,
      sandboxId: null,
      error: err instanceof Error ? err.message : "Failed to start sandbox.",
    };
  }

  try {
    // One round trip instead of one per file — on a scaffold with a couple
    // dozen files this was previously a couple dozen sequential awaits, each
    // paying the sandbox API's own latency; batching is pure speed, no
    // behavior change (writeFiles overwrites each path exactly like the
    // per-file write() this replaces).
    await sandbox.files.writeFiles(
      files.map((f) => ({ path: joinUnderRoot(PROJECT_ROOT, f.path), data: f.content }))
    );

    // Best-effort — nothing to kill on a fresh sandbox, and a failure here
    // shouldn't abort an otherwise-fine run. NOT `fuser -k` (what this used
    // to be): confirmed live against this app's own sandbox image that
    // `fuser` isn't installed at all (exit 127), so that call always
    // silently failed via the .catch() below — which meant a dev server
    // left running from the PREVIOUS Run on a reconnected (not fresh)
    // sandbox never actually got killed, and the next `next dev` crashed on
    // startup with EADDRINUSE instead. `ss` (unlike `fuser`/`lsof`, neither
    // present either) IS on this image; parses its own `pid=N` field
    // straight out of `-p` process info rather than needing a second tool
    // to resolve socket owner to pid.
    await sandbox.commands
      .run(`ss -ltnp | grep ':${PORT} ' | grep -oP '(?<=pid=)\\d+' | xargs -r kill -9`, { timeoutMs: 5_000 })
      .catch(() => {});

    if (framework === "next") {
      // Reconnecting to a still-live sandbox (clicked Run again within its
      // 20-minute window without touching dependencies) already has
      // node_modules from the last install sitting right there — re-running
      // `npm install` for an unchanged package.json is pure wasted time on
      // the single slowest step in this whole flow. Marker records the
      // package.json hash `npm install` last actually succeeded for, on
      // this specific sandbox; a fresh sandbox has no marker (acquireSandbox
      // above falls back to Sandbox.create whenever reconnect fails, which
      // the logs show is the common case once a preview's been idle), so
      // this only ever skips work that's genuinely already done, never
      // masks a real missing-deps case.
      const currentHash = packageJsonHash(files);
      let installedHash: string | null = null;
      try {
        installedHash = (await sandbox.files.read(INSTALL_MARKER_PATH)).trim();
      } catch {
        // No marker yet — fresh sandbox, or nothing's ever installed here.
      }

      if (!currentHash || installedHash !== currentHash) {
        try {
          await sandbox.commands.run("npm install --no-audit --no-fund --prefer-offline", {
            cwd: PROJECT_ROOT,
            timeoutMs: NPM_INSTALL_TIMEOUT_MS,
          });
        } catch (err) {
          const stderr = err instanceof CommandExitError ? err.stderr : undefined;
          await sandbox.kill().catch(() => {});
          const detail = stripAnsi(stderr?.trim() || (err instanceof Error ? err.message : ""));
          // A real V8 OOM crash (sandbox ran out of memory resolving/installing
          // the dependency tree, not a normal npm error) prints its own multi-
          // thousand-character internal stack trace — surface a clear one-line
          // cause instead of dumping that verbatim into the UI. Any other npm
          // failure still gets its real message, just capped like the
          // crashed/timeout outcomes below already are.
          const isHeapOom = /JavaScript heap out of memory|Ineffective mark-compacts/i.test(detail);
          return {
            url: null,
            sandboxId: null,
            error: isHeapOom
              ? "npm install ran out of memory in the sandbox. Try trimming dependencies, or Run again — this isn't caused by anything in your prompt."
              : detail.slice(0, 500) || "npm install failed.",
          };
        }
        if (currentHash) {
          // Best-effort — worst case a future run just reinstalls
          // unnecessarily, same as today's always-install behavior.
          await sandbox.files.write(INSTALL_MARKER_PATH, currentHash).catch(() => {});
        }
      }
    }

    const serveCmd =
      framework === "next" ? `npx next dev -p ${PORT}` : `python3 -m http.server ${PORT}`;

    // Backgrounded and never awaited to exit — a dev/static server runs
    // forever by design; this handle is only ever used to WATCH it (live
    // exitCode/stdout/stderr via waitUntilReady), never to wait for it to
    // finish. The underlying process is deliberately left running on
    // success — neither this function nor its caller tears it down.
    const handle = await sandbox.commands.run(serveCmd, { cwd: PROJECT_ROOT, background: true });

    const outcome = await waitUntilReady(sandbox, handle, READY_POLL_MAX_TRIES[framework]);
    const label = framework === "next" ? "Next.js dev server" : "server";

    if (outcome.status === "crashed") {
      await sandbox.kill().catch(() => {});
      const detail = stripAnsi((outcome.stderr || outcome.stdout).trim());
      return {
        url: null,
        sandboxId: null,
        error:
          `The ${label} crashed on startup (exit ${outcome.exitCode})` +
          (detail ? `: ${detail.slice(0, 500)}` : "."),
      };
    }

    if (outcome.status === "timeout") {
      await sandbox.kill().catch(() => {});
      // Whatever it had printed before we gave up waiting — genuinely
      // useful even for a process that never actually crashed, e.g. one
      // stuck mid-compile, so this isn't just a bare "took too long".
      const detail = stripAnsi((outcome.stderr || outcome.stdout).trim());
      return {
        url: null,
        sandboxId: null,
        error: `The ${label} never came up in time` + (detail ? ` — last output: ${detail.slice(0, 500)}` : "."),
      };
    }

    // Stops the SDK from receiving further events for this command without
    // touching the process itself (per the e2b SDK's own docs on
    // disconnect()) — we're done watching it, but it must keep running,
    // that's the whole point of a live preview. Best-effort: this is
    // cleanup, not something a successful preview should fail over.
    await handle.disconnect().catch(() => {});

    const url = `https://${sandbox.getHost(PORT)}`;
    return { url, sandboxId: sandbox.sandboxId, error: null };
  } catch (err) {
    await sandbox.kill().catch(() => {});
    return {
      url: null,
      sandboxId: null,
      error: err instanceof Error ? err.message : "Failed to start the web app.",
    };
  }
}

/**
 * Renews a live preview sandbox's expiry back out to WEBAPP_SANDBOX_TIMEOUT_MS
 * — called periodically (see app/api/projects/preview-heartbeat/route.ts and
 * its client-side interval in ProjectPanel.tsx) so a sandbox someone is
 * actually using never lapses just because nobody happened to click Run
 * again inside the window. Uses the static, ID-only Sandbox.setTimeout
 * rather than a full connect() — this fires every few minutes for as long
 * as the Project panel is open, so it's worth it being the cheapest call
 * that does the job instead of a full reconnect handshake each time.
 * Returns false (never throws) for "nothing to renew" — an idle/errored/
 * already-expired preview — which the caller treats as a normal no-op, not
 * a failure: the next real Run already handles recreating a dead sandbox,
 * this function's only job is reducing how often that becomes necessary.
 */
export async function renewPreviewSandbox(sandboxId: string): Promise<boolean> {
  try {
    await Sandbox.setTimeout(sandboxId, WEBAPP_SANDBOX_TIMEOUT_MS);
    return true;
  } catch {
    return false;
  }
}

export type PreviewSandboxHost = { host: string } | { host: null; reason: string };

/**
 * Resolves the CURRENT live host for an already-running preview sandbox —
 * for the stable-URL reverse proxy (middleware.ts + app/api/_preview-proxy),
 * which must forward every request to whichever sandbox actually exists
 * right now, since a Run/Restart or the natural expiry-and-recreate cycle
 * can swap it out for a different one with a different host at any time.
 *
 * Deliberately reconnect-only, NEVER falls back to Sandbox.create() the way
 * acquireSandbox() (runWebApp's own helper) does — creating a fresh, empty
 * sandbox here would serve a proxy visitor a blank/broken app instead of
 * telling them the truth ("nothing's running"), and would silently orphan
 * whatever sandbox preview_sandbox_id actually still points at in the DB.
 * A missing/dead sandbox is the proxy route's problem to report, not this
 * function's to paper over.
 *
 * Renews the sandbox's timeout on every call — same effect as the
 * heartbeat endpoint, except this fires on genuine visitor traffic instead
 * of a fixed interval, so an actively-viewed demo's sandbox gets renewed
 * even more directly than the Project-panel-open heartbeat alone achieves.
 */
export async function resolvePreviewSandboxHost(sandboxId: string): Promise<PreviewSandboxHost> {
  let sandbox: Sandbox;
  try {
    sandbox = await Sandbox.connect(sandboxId, { timeoutMs: WEBAPP_SANDBOX_TIMEOUT_MS });
  } catch (err) {
    return { host: null, reason: err instanceof Error ? err.message : "Sandbox is no longer reachable." };
  }
  return { host: sandbox.getHost(PORT) };
}
