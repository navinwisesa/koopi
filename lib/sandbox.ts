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
 * One-shot E2B sandbox execution: a fresh sandbox per call, torn down as soon
 * as the command finishes. `cancel()` kills the in-flight command (and the
 * sandbox underneath it) — the Stop button's interrupt path for tool calls.
 */
export class SandboxRun {
  private sandboxPromise: Promise<Sandbox>;
  private cancelled = false;

  constructor(
    private code: string,
    private language: string
  ) {
    this.sandboxPromise = Sandbox.create({ timeoutMs: SANDBOX_TIMEOUT_MS });
  }

  async run(): Promise<RunResult> {
    if (this.cancelled) {
      return { stdout: "", stderr: "Execution was interrupted.", exit_code: -1 };
    }

    const sandbox = await this.sandboxPromise;
    if (this.cancelled) {
      await sandbox.kill().catch(() => {});
      return { stdout: "", stderr: "Execution was interrupted.", exit_code: -1 };
    }

    const runner = runnerFor(this.language);
    await sandbox.files.write(runner.file, this.code);

    const handle = await sandbox.commands.run(runner.cmd(runner.file), {
      background: true,
      timeoutMs: EXEC_TIMEOUT_MS,
    });

    try {
      const result = await handle.wait();
      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exit_code: result.exitCode,
      };
    } catch (err) {
      if (this.cancelled) {
        return { stdout: "", stderr: "Execution was interrupted.", exit_code: -1 };
      }
      if (err instanceof CommandExitError) {
        return {
          stdout: err.stdout,
          stderr: err.stderr,
          exit_code: err.exitCode,
        };
      }
      throw err;
    } finally {
      await sandbox.kill().catch(() => {});
    }
  }

  async cancel() {
    if (this.cancelled) return;
    this.cancelled = true;
    const sandbox = await this.sandboxPromise.catch(() => null);
    if (sandbox) await sandbox.kill().catch(() => {});
  }
}
