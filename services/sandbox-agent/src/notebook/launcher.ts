import { spawn, type ChildProcess } from "node:child_process";
import { stat } from "node:fs/promises";
import type { PiIdentities, PiIdentity } from "../pi/identities.js";
import { SHARED_SCRATCH_DIRS } from "../threads/thread.js";
import type { BridgeLauncher, BridgeProcess } from "./session.js";

/**
 * Starting a thread kernel's bridge (docs/specs/notebooks.md NB10). Under Pi identities each kernel
 * takes an identity of its own from the pool and runs as its partner (tool) uid through
 * `kobe-runas`, stdio only, like the tool executor; on stop every process of the pair is killed,
 * what the uid left in the shared trees is reclaimed for the workspace group, and only then is the
 * identity released (a failed reclaim keeps it out of use). Without identities (development,
 * tests) it is a plain child in its own process group.
 */
export interface KernelLauncherOptions {
  /** The Python interpreter (absolute in the image: `/usr/local/bin/python3`). */
  readonly python: string;
  /** The root-owned bridge program (`KOBE_KERNEL_BRIDGE`). */
  readonly bridge: string;
  readonly workspaceDir: string;
  /** The tools' shared HOME. */
  readonly home: string;
  readonly parentEnv: Readonly<Record<string, string | undefined>>;
  readonly identities?: PiIdentities | undefined;
  readonly onDiagnostic?: (message: string) => void;
  /** How long a plain child gets between end of input and SIGKILL. */
  readonly graceMs?: number;
}

/** What the kernel inherits: the tools' allow-list, never a token, a channel fd or a proxy. */
const KERNEL_ENV = ["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "TMPDIR"] as const;

export function kernelEnv(
  parentEnv: Readonly<Record<string, string | undefined>>,
  home: string,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of KERNEL_ENV) {
    const value = parentEnv[name];
    if (value !== undefined) env[name] = value;
  }
  env.HOME = home;
  env.PYTHONDONTWRITEBYTECODE = "1";
  env.PYTHONUNBUFFERED = "1";
  return env;
}

export function createKernelLauncher(options: KernelLauncherOptions): BridgeLauncher {
  return async () => {
    const identities = options.identities;
    const identity = identities === undefined ? undefined : await identities.acquire();
    try {
      const env = kernelEnv(options.parentEnv, options.home);
      let file = options.python;
      let args: readonly string[] = [options.bridge];
      if (identities !== undefined && identity !== undefined) {
        file = identities.helper;
        args = identities.paired
          ? identities.partnerCommand(identity, options.python, args, env)
          : identities.command(identity, options.python, args, env);
      }
      const child = spawn(file, [...args], {
        cwd: options.workspaceDir,
        env,
        stdio: ["pipe", "pipe", "pipe"],
        detached: true,
        windowsHide: true,
      });
      return bridgeOf(child, options, identity);
    } catch (error) {
      if (identity !== undefined) await reclaim(options, identity);
      throw error;
    }
  };
}

function bridgeOf(
  child: ChildProcess,
  options: KernelLauncherOptions,
  identity: PiIdentity | undefined,
): BridgeProcess {
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    child.on("error", (error) => {
      options.onDiagnostic?.(`the kernel bridge failed to start: ${error.message}`);
      resolve({ code: null, signal: null });
    });
    child.on("exit", (code, signal) => resolve({ code, signal }));
  });
  let gone = false;
  void exited.then(() => (gone = true));
  let killed: Promise<void> | undefined;
  return {
    stdin: child.stdin as NonNullable<ChildProcess["stdin"]>,
    stdout: child.stdout as NonNullable<ChildProcess["stdout"]>,
    stderr: child.stderr as NonNullable<ChildProcess["stderr"]>,
    exited,
    kill() {
      killed ??= (async () => {
        child.stdin?.end();
        if (identity !== undefined) {
          await reclaim(options, identity);
          return;
        }
        // The bridge shuts its kernel down when its input ends; the group kill is the backstop.
        await Promise.race([exited, delay(options.graceMs ?? 2000)]);
        if (!gone && child.pid !== undefined) {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            // already gone
          }
        }
      })();
      return killed;
    },
  };
}

/** Kill everything of the identity, reclaim its files, release it (or keep it out of use). */
async function reclaim(options: KernelLauncherOptions, identity: PiIdentity): Promise<void> {
  const identities = options.identities;
  if (identities === undefined) return;
  try {
    await identities.killAllPatiently(identity);
    const gid = (await stat(options.workspaceDir)).gid;
    await identities.reclaimFiles(identity, gid, [
      options.workspaceDir,
      options.home,
      ...SHARED_SCRATCH_DIRS,
    ]);
  } catch (error) {
    options.onDiagnostic?.(
      `kernel identity ${identity.uid} not reclaimed: ${(error as Error).message}`,
    );
    return;
  }
  identities.release(identity);
}

const delay = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms).unref();
  });
