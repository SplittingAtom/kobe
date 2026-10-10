import { spawn, type ChildProcess } from "node:child_process";
import type { PiIdentities, PiIdentity } from "../pi/identities.js";
import type { ExecutorHandle } from "./relay.js";

/**
 * Starting a thread's tool executor (KOBE-167). Under a Pi identity it runs through `kobe-runas`
 * as the identity's partner uid (groups {own gid, workspace group}, umask 002, no capabilities,
 * `no_new_privs`, stdio only: see images/sandbox/runas/kobe-runas.c), after any leftovers of the
 * previous executor of the pair are killed; the agent can signal that uid only through the
 * helper. Without identities (development, tests outside the image) it is a plain child of the
 * agent, which is also the uid Pi and its tools have there: nothing is lost or gained.
 */
export const EXECUTOR_GRACE_MS = 2000;

/** Variables of Pi's launch environment the tools get, and nothing else from it. */
const TOOL_ENV = ["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "TMPDIR", "HOME"] as const;

/**
 * The executor's environment (every command inherits it): the same allow-list Pi's tools had (no
 * Pi variable such as the agent dir, the model file or the channel fds), the egress wiring they
 * are meant to have (no secret in it: the token stays in a file, KOBE-39) and Node's
 * inspector-off option, since the tools can signal their executor.
 */
export function executorEnv(
  launchEnv: Readonly<Record<string, string>>,
  egress: Readonly<Record<string, string>> = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of TOOL_ENV) {
    const value = launchEnv[name];
    if (value !== undefined) env[name] = value;
  }
  env.NODE_OPTIONS = "--disable-sigusr1";
  return { ...env, ...egress };
}

export interface StartExecutorOptions {
  readonly nodeBin: string;
  /** `dist/exec/executor/main.js`, readable by every partner uid. */
  readonly entry: string;
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string;
  readonly runAs?: { readonly identities: PiIdentities; readonly identity: PiIdentity } | undefined;
  readonly onDiagnostic?: (message: string) => void;
  readonly graceMs?: number;
}

export async function startExecutor(options: StartExecutorOptions): Promise<ExecutorHandle> {
  const { runAs } = options;
  let file = options.nodeBin;
  let args: readonly string[] = [options.entry];
  if (runAs !== undefined) {
    // Whatever the previous executor of this pair left running goes first: a new executor must
    // never inherit a process (or a lock) of the old one.
    await runAs.identities.killPartner(runAs.identity);
    file = runAs.identities.helper;
    args = runAs.identities.partnerCommand(runAs.identity, options.nodeBin, args, options.env);
  }
  const child = spawn(file, [...args], {
    cwd: options.cwd,
    env: { ...options.env },
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
    windowsHide: true,
  });
  return handleOf(child, options);
}

function handleOf(child: ChildProcess, options: StartExecutorOptions): ExecutorHandle {
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    child.on("error", (error) => {
      options.onDiagnostic?.(`tool executor failed to start: ${error.message}`);
      resolve({ code: null, signal: null });
    });
    child.on("exit", (code, signal) => resolve({ code, signal }));
  });
  let exitedAlready = false;
  void exited.then(() => (exitedAlready = true));
  return {
    stdin: child.stdin as NonNullable<ChildProcess["stdin"]>,
    stdout: child.stdout as NonNullable<ChildProcess["stdout"]>,
    stderr: child.stderr as NonNullable<ChildProcess["stderr"]>,
    exited,
    kill() {
      const runAs = options.runAs;
      child.stdin?.end();
      if (runAs !== undefined) {
        // Only the helper can signal another uid; it kills the executor and all it started.
        void runAs.identities.killPartner(runAs.identity).catch((error: unknown) => {
          options.onDiagnostic?.(`stopping the tool executor: ${(error as Error).message}`);
        });
        return;
      }
      // The executor kills its commands when its input ends; the group kill is the backstop.
      const timer = setTimeout(() => {
        if (exitedAlready || child.pid === undefined) return;
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          // already gone
        }
      }, options.graceMs ?? EXECUTOR_GRACE_MS);
      timer.unref();
    },
  };
}
