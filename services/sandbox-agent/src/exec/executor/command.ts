import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { access } from "node:fs/promises";
import { constants as osConstants } from "node:os";
import { constants as FS } from "node:fs";
import type { ExecRequest, ExecError } from "../../kobe-exec/protocol.js";

/**
 * Runs one `exec` request the way Pi's own bash tool runs a command (verified Pi 1.0.0
 * `core/tools/bash.js` createLocalShellOperations, `utils/shell.js`, `utils/child-process.js`):
 * `/bin/bash -c <command>` (else `sh`), in its own process group, stdin closed, stdout and stderr
 * streamed as they come; a timeout or an abort kills the whole group; a shell killed by a signal
 * reports 128 + signal; after the shell exits the streams get a short idle grace so a detached
 * descendant holding a pipe does not hang the call, while one still writing is read to the end.
 */
export const POST_EXIT_IDLE_MS = 100;

export type CommandOutcome =
  | { readonly kind: "exit"; readonly exitCode: number; readonly signal: string | null }
  | { readonly kind: "error"; readonly error: ExecError };

export interface CommandHandlers {
  /** One chunk of output. Returns false when the reader is saturated (stop reading until drain). */
  readonly onData: (stream: "stdout" | "stderr", chunk: Buffer) => boolean;
  /** Called once the reader can take more. */
  readonly whenDrained: (resume: () => void) => void;
}

export interface RunningCommand {
  readonly done: Promise<CommandOutcome>;
  /** Kill the process group; the outcome becomes `aborted`. */
  abort(): void;
}

type ExecArgs = Extract<ExecRequest, { op: "exec" }>;

function shellFor(): string {
  return existsSync("/bin/bash") ? "/bin/bash" : "sh";
}

function killGroup(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
}

export function runCommand(
  request: ExecArgs,
  baseEnv: Readonly<Record<string, string | undefined>>,
  handlers: CommandHandlers,
): RunningCommand {
  let abort: () => void = () => undefined;
  const done = start(request, baseEnv, handlers, (fn) => (abort = fn));
  return { done, abort: () => abort() };
}

async function start(
  request: ExecArgs,
  baseEnv: Readonly<Record<string, string | undefined>>,
  handlers: CommandHandlers,
  setAbort: (fn: () => void) => void,
): Promise<CommandOutcome> {
  try {
    await access(request.cwd, FS.F_OK);
  } catch {
    return {
      kind: "error",
      error: {
        code: "ENOENT",
        message: `Working directory does not exist: ${request.cwd}\nCannot execute bash commands.`,
      },
    };
  }
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(baseEnv)) if (value !== undefined) env[name] = value;
  Object.assign(env, request.env ?? {});
  const [file, args] =
    request.argv === undefined
      ? [shellFor(), ["-c", request.command as string]]
      : [request.argv[0] as string, request.argv.slice(1)];
  let child: ChildProcess;
  try {
    child = spawn(file, [...args], {
      cwd: request.cwd,
      env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch (error) {
    return { kind: "error", error: { code: "spawn_failed", message: (error as Error).message } };
  }
  return new Promise<CommandOutcome>((resolve) => {
    let settled = false;
    let aborted = false;
    let timedOut = false;
    let exited = false;
    let exitCode: number | null = null;
    let idle: NodeJS.Timeout | undefined;
    let timer: NodeJS.Timeout | undefined;
    let open = 2;
    let paused = false;

    const finish = (outcome: CommandOutcome) => {
      if (settled) return;
      settled = true;
      if (idle) clearTimeout(idle);
      if (timer) clearTimeout(timer);
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve(outcome);
    };
    const finishExit = () => {
      if (aborted) {
        finish({ kind: "error", error: { code: "aborted", message: "aborted" } });
      } else if (timedOut) {
        finish({
          kind: "error",
          error: { code: "timeout", message: `timeout:${request.timeout_s ?? ""}` },
        });
      } else {
        const signal = child.signalCode;
        const code = exitCode ?? (signal ? 128 + (osConstants.signals[signal] ?? 0) : 1);
        finish({ kind: "exit", exitCode: code, signal });
      }
    };
    const armIdle = () => {
      if (!exited || settled || paused) return;
      if (idle) clearTimeout(idle);
      idle = setTimeout(finishExit, POST_EXIT_IDLE_MS);
    };
    const streamEnded = () => {
      open -= 1;
      if (exited && open === 0) finishExit();
    };

    setAbort(() => {
      if (settled) return;
      aborted = true;
      killGroup(child);
    });
    if (request.timeout_s !== undefined) {
      timer = setTimeout(() => {
        timedOut = true;
        killGroup(child);
      }, request.timeout_s * 1000);
    }

    for (const name of ["stdout", "stderr"] as const) {
      const stream = child[name];
      stream?.on("data", (chunk: Buffer) => {
        if (settled) return;
        if (!handlers.onData(name, chunk)) {
          paused = true;
          if (idle) clearTimeout(idle);
          child.stdout?.pause();
          child.stderr?.pause();
          handlers.whenDrained(() => {
            paused = false;
            child.stdout?.resume();
            child.stderr?.resume();
            armIdle();
          });
        }
        armIdle();
      });
      stream?.on("end", streamEnded);
      stream?.on("error", streamEnded);
    }
    child.on("error", (error) => {
      finish({ kind: "error", error: { code: "spawn_failed", message: error.message } });
    });
    child.on("exit", (code) => {
      exited = true;
      exitCode = code;
      if (open === 0) finishExit();
      else armIdle();
    });
  });
}
