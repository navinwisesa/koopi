import { randomUUID } from "node:crypto";
import { Sandbox, CommandExitError, type CommandHandle } from "e2b";

export type RunResult = {
  stdout: string;
  stderr: string;
  exit_code: number;
};

const SANDBOX_TIMEOUT_MS = 60_000;
const EXEC_TIMEOUT_MS = 20_000;

// Interactive Project-mode runs are a different shape entirely — a human
// may take minutes to respond to a prompt, so both the sandbox's own
// idle timeout and the command's timeout need real headroom, not the 20s
// fire-and-forget budget SandboxRun (below) uses for the chat run_code
// tool. Scoped to SandboxProjectRun only — SandboxRun's constants above are
// untouched, deliberately, per the chat flow staying fire-and-forget.
const INTERACTIVE_SANDBOX_TIMEOUT_MS = 10 * 60_000;
const INTERACTIVE_EXEC_TIMEOUT_MS = 10 * 60_000;

// Confirmed live (by reading, not guessing): this room-wide sandbox
// (SandboxRun below) has no serialization at all — unlike Project-mode runs,
// which /api/projects/run/route.ts gates behind an idle->running CAS claim
// so only one is ever active per project, `run_code` can fire concurrently
// from any chat request in the room with nothing stopping two people (or
// two rounds of the same turn) from triggering it at once. A per-LANGUAGE
// fixed path here — the shape this used to be — meant two concurrent same-
// language run_code calls sharing this room's sandbox would both write to
// the exact same file, each free to clobber the other's script mid-write or
// mid-execution. `ext` (not a fixed `file`) lets run() below build a fresh,
// unique path per call instead.
const RUNNERS: Record<string, { ext: string; cmd: (path: string) => string }> = {
  python: { ext: "py", cmd: (p) => `python3 ${p}` },
  javascript: { ext: "js", cmd: (p) => `node ${p}` },
  typescript: { ext: "ts", cmd: (p) => `npx -y tsx ${p}` },
  bash: { ext: "sh", cmd: (p) => `bash ${p}` },
  shell: { ext: "sh", cmd: (p) => `bash ${p}` },
};

function runnerFor(language: string) {
  return RUNNERS[language.trim().toLowerCase()] ?? RUNNERS.bash;
}

/**
 * E2B sandbox execution for a single run_code call. When `existingSandboxId`
 * is given, reconnects to that same sandbox (auto-resuming it if it was left
 * paused) instead of creating a fresh one, so files/state written by a
 * previous call are still there. If reconnecting fails — expired,
 * garbage-collected, or never existed — falls back to a fresh sandbox rather
 * than failing the call. This class is agnostic to what the ID is scoped to
 * (currently `rooms.sandbox_id` — the whole room shares one sandbox); the
 * caller decides what to pass in and where to persist what comes back.
 *
 * On a normal finish the sandbox is paused, not killed, so it survives for
 * the next call: `run()` returns the sandbox ID for the caller to persist.
 * `cancel()` still kills outright — an interrupt means abandon this run, not
 * preserve it.
 */
export class SandboxRun {
  private sandboxPromise: Promise<Sandbox>;
  private cancelled = false;

  constructor(
    private code: string,
    private language: string,
    private existingSandboxId?: string | null
  ) {
    this.sandboxPromise = this.acquire();
  }

  private async acquire(): Promise<Sandbox> {
    if (this.existingSandboxId) {
      try {
        return await Sandbox.connect(this.existingSandboxId, {
          timeoutMs: SANDBOX_TIMEOUT_MS,
        });
      } catch (err) {
        console.warn(
          `[sandbox] could not reconnect to ${this.existingSandboxId}, starting a fresh sandbox instead:`,
          err
        );
      }
    }
    return Sandbox.create({ timeoutMs: SANDBOX_TIMEOUT_MS });
  }

  async run(): Promise<{ result: RunResult; sandboxId: string | null }> {
    const interrupted = {
      result: { stdout: "", stderr: "Execution was interrupted.", exit_code: -1 },
      sandboxId: null,
    };
    if (this.cancelled) return interrupted;

    let sandbox: Sandbox;
    try {
      sandbox = await this.sandboxPromise;
    } catch (err) {
      return {
        result: {
          stdout: "",
          stderr: err instanceof Error ? err.message : "Failed to start sandbox.",
          exit_code: -1,
        },
        sandboxId: null,
      };
    }
    if (this.cancelled) {
      await sandbox.kill().catch(() => {});
      return interrupted;
    }

    try {
      const runner = runnerFor(this.language);
      // Unique per call, not a fixed "main.<ext>" — see RUNNERS' own
      // comment: this sandbox is shared room-wide with no mutual exclusion,
      // so two concurrent same-language run_code calls must never be able
      // to write over the exact same file.
      const file = `/tmp/run/${randomUUID()}.${runner.ext}`;
      await sandbox.files.write(file, this.code);

      const handle = await sandbox.commands.run(runner.cmd(file), {
        background: true,
        timeoutMs: EXEC_TIMEOUT_MS,
      });

      const result = await handle.wait();
      return {
        result: {
          stdout: result.stdout,
          stderr: result.stderr,
          exit_code: result.exitCode,
        },
        sandboxId: sandbox.sandboxId,
      };
    } catch (err) {
      // A cancel() arriving mid-write or mid-launch kills the sandbox out from
      // under `files.write`/`commands.run` themselves, not just `handle.wait()`
      // — those throw too (e.g. SandboxNotFoundError), so this must catch the
      // whole block, not just the wait, to report "interrupted" instead of
      // letting that error escape uncaught.
      if (this.cancelled) return interrupted;
      if (err instanceof CommandExitError) {
        return {
          result: {
            stdout: err.stdout,
            stderr: err.stderr,
            exit_code: err.exitCode,
          },
          sandboxId: sandbox.sandboxId,
        };
      }
      throw err;
    } finally {
      if (this.cancelled) {
        await sandbox.kill().catch(() => {});
      } else {
        // Pause (not kill) so the next run_code call in this thread can
        // reconnect and pick up exactly where this one left off.
        await sandbox.pause().catch(() => {});
      }
    }
  }

  async cancel() {
    if (this.cancelled) return;
    this.cancelled = true;
    const sandbox = await this.sandboxPromise.catch(() => null);
    if (sandbox) await sandbox.kill().catch(() => {});
  }
}

const PROJECT_ROOT = "/tmp/project";

/**
 * Multi-file counterpart to SandboxRun, for Project mode — and, unlike
 * SandboxRun, genuinely interactive: the process is started with a live
 * stdin channel held open (`stdin: true`) and stdout/stderr are streamed to
 * the caller as they're produced via callbacks, not batched into a single
 * result after the process exits. This is what actually fixes the EOFError
 * a script calling input() used to hit — previously `commands.run()` here
 * had no stdin channel at all, so any input() call would read EOF
 * immediately and crash before a human could ever respond.
 *
 * Same connect-existing-or-create-fresh, pause-on-success/kill-on-cancel
 * sandbox lifecycle as SandboxRun. The two classes still aren't merged —
 * their run() shapes differ even more now (interactive/streaming vs.
 * one-shot/batched) than the multi-file-vs-single-file split already
 * justified.
 */
export class SandboxProjectRun {
  private sandboxPromise: Promise<Sandbox>;
  private cancelled = false;
  // Set once the interactive command actually starts — sendStdin()/kill()
  // before that point are no-ops rather than throwing, since a Stop click
  // or stdin submission racing the sandbox's own startup is expected, not
  // exceptional.
  private handle: CommandHandle | null = null;

  constructor(
    private files: { path: string; content: string }[],
    private entryPath: string,
    private entryLanguage: string,
    private existingSandboxId?: string | null
  ) {
    this.sandboxPromise = this.acquire();
  }

  private async acquire(): Promise<Sandbox> {
    if (this.existingSandboxId) {
      try {
        return await Sandbox.connect(this.existingSandboxId, {
          timeoutMs: INTERACTIVE_SANDBOX_TIMEOUT_MS,
        });
      } catch (err) {
        console.warn(
          `[sandbox] could not reconnect to ${this.existingSandboxId}, starting a fresh sandbox instead:`,
          err
        );
      }
    }
    return Sandbox.create({ timeoutMs: INTERACTIVE_SANDBOX_TIMEOUT_MS });
  }

  /**
   * Writes every project file, starts the entry file as a live, interactive
   * command, and resolves once it exits (normally, killed, or errored) —
   * `onStdout`/`onStderr` fire incrementally the whole time it's running,
   * which is the caller's only way to see output before then. Every project
   * file is rewritten on each run so edits/deletes since the last run
   * (including files other than the entry point) are always reflected —
   * the sandbox's /tmp/project is disposable, derived state, never the
   * source of truth.
   */
  async run(callbacks: {
    onStdout: (data: string) => void;
    onStderr: (data: string) => void;
  }): Promise<{ result: RunResult; sandboxId: string | null }> {
    const interrupted = {
      result: { stdout: "", stderr: "Execution was interrupted.", exit_code: -1 },
      sandboxId: null,
    };
    if (this.cancelled) return interrupted;

    let sandbox: Sandbox;
    try {
      sandbox = await this.sandboxPromise;
    } catch (err) {
      return {
        result: {
          stdout: "",
          stderr: err instanceof Error ? err.message : "Failed to start sandbox.",
          exit_code: -1,
        },
        sandboxId: null,
      };
    }
    if (this.cancelled) {
      await sandbox.kill().catch(() => {});
      return interrupted;
    }

    try {
      for (const f of this.files) {
        // Guard against a path escaping PROJECT_ROOT (e.g. "../../etc/passwd")
        // before it ever reaches the sandbox — join-then-check, not a naive
        // prefix match on the raw path.
        const target = joinUnderRoot(PROJECT_ROOT, f.path);
        await sandbox.files.write(target, f.content);
      }

      const entryTarget = joinUnderRoot(PROJECT_ROOT, this.entryPath);
      const cmd = entryCommand(this.entryLanguage, entryTarget);

      if (this.cancelled) {
        await sandbox.kill().catch(() => {});
        return interrupted;
      }

      const handle = await sandbox.commands.run(cmd, {
        cwd: PROJECT_ROOT,
        background: true,
        stdin: true,
        // Python fully buffers stdout by default once it's not attached to
        // a TTY (which it isn't here — it's a pipe) — without this, a
        // prompt like input("Enter numbers: ") sits in Python's internal
        // buffer and never reaches onStdout until the buffer fills or the
        // process exits, which looks identical to a hang from the UI's
        // side. -u forces every stream unbuffered. Harmless for the other
        // languages (bash/node don't take -u; this only prefixes python's
        // own invocation inside entryCommand).
        envs: { PYTHONUNBUFFERED: "1" },
        onStdout: callbacks.onStdout,
        onStderr: callbacks.onStderr,
        timeoutMs: INTERACTIVE_EXEC_TIMEOUT_MS,
      });
      this.handle = handle;

      if (this.cancelled) {
        await handle.kill().catch(() => {});
        await sandbox.kill().catch(() => {});
        return interrupted;
      }

      const result = await handle.wait();
      return {
        result: {
          stdout: result.stdout,
          stderr: result.stderr,
          exit_code: result.exitCode,
        },
        sandboxId: sandbox.sandboxId,
      };
    } catch (err) {
      if (this.cancelled) return interrupted;
      if (err instanceof CommandExitError) {
        return {
          result: {
            stdout: err.stdout,
            stderr: err.stderr,
            exit_code: err.exitCode,
          },
          sandboxId: sandbox.sandboxId,
        };
      }
      throw err;
    } finally {
      this.handle = null;
      if (this.cancelled) {
        await sandbox.kill().catch(() => {});
      } else {
        await sandbox.pause().catch(() => {});
      }
    }
  }

  /** Writes to the running process's stdin. No-op if nothing is running. */
  async sendStdin(data: string) {
    if (!this.handle) return;
    await this.handle.sendStdin(data).catch((err) => {
      console.warn("[sandbox] sendStdin failed (process likely already exited):", err);
    });
  }

  /**
   * Terminates the process (if any) whether it's actively computing or
   * blocked reading stdin — SIGKILL ends a blocked read() the same as any
   * other syscall, no special-casing needed for "waiting on input" vs
   * "running" — and kills the sandbox itself, so nothing is left orphaned.
   * `run()`'s own `finally` skips the pause-for-reuse path once `cancelled`
   * is set, so this is always the sandbox's last word on this run.
   */
  async cancel() {
    if (this.cancelled) return;
    this.cancelled = true;
    if (this.handle) await this.handle.kill().catch(() => {});
    const sandbox = await this.sandboxPromise.catch(() => null);
    if (sandbox) await sandbox.kill().catch(() => {});
  }
}

export function joinUnderRoot(root: string, relativePath: string): string {
  const cleaned = relativePath.replace(/\\/g, "/").split("/").filter((seg) => seg && seg !== ".");
  const stack: string[] = [];
  for (const seg of cleaned) {
    if (seg === "..") stack.pop();
    else stack.push(seg);
  }
  return `${root}/${stack.join("/")}`;
}

function entryCommand(language: string, entryTarget: string): string {
  switch (language.trim().toLowerCase()) {
    case "python":
      return `python3 ${entryTarget}`;
    case "javascript":
      return `node ${entryTarget}`;
    case "typescript":
      return `npx -y tsx ${entryTarget}`;
    default:
      return `bash ${entryTarget}`;
  }
}
