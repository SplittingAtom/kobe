import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, chown, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import {
  EGRESS_TOKEN_FILE_NAME,
  EgressTokenFile,
  egressEnv,
  type EgressWiring,
} from "../egress/egress-wiring.js";
import { removeRuntimeDir } from "../models/runtime-dir.js";
import { partnerOf, type PiIdentities, type PiIdentity } from "../pi/identities.js";
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
  /**
   * Egress (NB17): the kernel reaches the internet as the shell tool does, through egress-proxy
   * with the team's allowlist. `runtimeRoot` is the agent's private runtime directory; each
   * kernel's rotating token file lives in a directory there only the kernel's uid may read.
   */
  readonly egress?: { readonly wiring: EgressWiring; readonly runtimeRoot: string } | undefined;
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

/**
 * The kernel's egress token: a file the agent rewrites on every rotation, in a fresh directory
 * agent-owned with the kernel uid's group (2750): the kernel reads it, nothing else of the sandbox
 * can. The variables name the file, never the token; the bridge turns them into proxy variables
 * before each cell (as the shell tool's BASH_ENV script does per command).
 */
interface KernelEgress {
  readonly env: Record<string, string>;
  close(): Promise<void>;
}

async function kernelEgress(
  options: KernelLauncherOptions,
  threadId: string,
  identity: PiIdentity | undefined,
): Promise<KernelEgress | undefined> {
  const egress = options.egress;
  if (egress === undefined) return undefined;
  const dir = path.join(egress.runtimeRoot, `kernel-${randomBytes(16).toString("hex")}`);
  await mkdir(egress.runtimeRoot, { recursive: true, mode: 0o700 });
  await mkdir(dir, { mode: 0o700 });
  if (identity !== undefined && options.identities !== undefined) {
    const gid = options.identities.paired ? partnerOf(identity).gid : identity.gid;
    await chown(dir, -1, gid);
    await chmod(dir, 0o2750);
  }
  const file = new EgressTokenFile(
    path.join(dir, EGRESS_TOKEN_FILE_NAME),
    identity === undefined ? 0o600 : 0o640,
  );
  await file.write(await egress.wiring.tokens.current());
  const unsubscribe = egress.wiring.tokens.onChange((token) => {
    file.write(token).catch((error: unknown) => {
      options.onDiagnostic?.(`kernel egress token not written: ${(error as Error).message}`);
    });
  });
  return {
    env: egressEnv(egress.wiring, file.path, threadId),
    async close() {
      unsubscribe();
      await removeRuntimeDir(dir, options.identities).catch((error: unknown) => {
        options.onDiagnostic?.(`kernel egress dir not removed: ${(error as Error).message}`);
      });
    },
  };
}

export function createKernelLauncher(options: KernelLauncherOptions): BridgeLauncher {
  return async (threadId) => {
    const identities = options.identities;
    const identity = identities === undefined ? undefined : await identities.acquire();
    let egress: KernelEgress | undefined;
    try {
      egress = await kernelEgress(options, threadId, identity);
      const env = { ...kernelEnv(options.parentEnv, options.home), ...egress?.env };
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
      return bridgeOf(child, options, identity, egress);
    } catch (error) {
      await egress?.close();
      if (identity !== undefined) await reclaim(options, identity);
      throw error;
    }
  };
}

function bridgeOf(
  child: ChildProcess,
  options: KernelLauncherOptions,
  identity: PiIdentity | undefined,
  egress: KernelEgress | undefined,
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
          await egress?.close();
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
        await egress?.close();
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
