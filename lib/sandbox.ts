import { Sandbox, CommandExitError } from "e2b";

export type RunResult = {
  stdout: string;
  stderr: string;
  exit_code: number;
};

const SANDBOX_TIMEOUT_MS = 60_000;
const EXEC_TIMEOUT_MS = 20_000;

const RUNNERS: Record<string, { file: string; cmd: (path: string) => string }> = {
  python: { file: "/tmp/run/main.py", cmd: (p) => `python3 ${p}` },
  javascript: { file: "/tmp/run/main.js", cmd: (p) => `node ${p}` },
  typescript: { file: "/tmp/run/main.ts", cmd: (p) => `npx -y tsx ${p}` },
  bash: { file: "/tmp/run/main.sh", cmd: (p) => `bash ${p}` },
  shell: { file: "/tmp/run/main.sh", cmd: (p) => `bash ${p}` },
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
      await sandbox.files.write(runner.file, this.code);

      const handle = await sandbox.commands.run(runner.cmd(runner.file), {
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
 * Multi-file counterpart to SandboxRun, for Project mode. Writes every file
 * in the project into one sandbox working directory (preserving relative
 * paths, so imports between files resolve normally) and then executes a
 * single entry file from within that directory — same
 * connect-existing-or-create-fresh, pause-on-success/kill-on-cancel lifecycle
 * as SandboxRun, deliberately not reimplemented differently here. The two
 * classes aren't merged into one because their run() shapes genuinely
 * differ (one file written vs. N files written + a chosen entry path) and
 * forcing a single method to cover both would obscure both cases.
 */
export class SandboxProjectRun {
  private sandboxPromise: Promise<Sandbox>;
  private cancelled = false;

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
      // Every project file is rewritten on each run so edits/deletes made
      // since the last run (including in files other than the entry point)
      // are always reflected — the sandbox's /tmp/project is treated as
      // disposable, derived state, never the source of truth.
      for (const f of this.files) {
        // Guard against a path escaping PROJECT_ROOT (e.g. "../../etc/passwd")
        // before it ever reaches the sandbox — join-then-check, not a naive
        // prefix match on the raw path.
        const target = joinUnderRoot(PROJECT_ROOT, f.path);
        await sandbox.files.write(target, f.content);
      }

      const entryTarget = joinUnderRoot(PROJECT_ROOT, this.entryPath);
      const cmd = entryCommand(this.entryLanguage, entryTarget);

      const handle = await sandbox.commands.run(cmd, {
        cwd: PROJECT_ROOT,
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

function joinUnderRoot(root: string, relativePath: string): string {
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
