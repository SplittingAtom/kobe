import { spawn, spawnSync } from "node:child_process";
import { stat } from "node:fs/promises";

/**
 * Pi identities (KOBE-71): every Pi process, and so every tool it runs, gets a uid of its own
 * from a pool, through the image's `kobe-runas` helper (images/sandbox/runas/kobe-runas.c). The
 * agent keeps its own uid, so a thread's tools cannot read the agent's files (the bootstrap
 * token), write another thread's runtime directory, or signal/ptrace the agent or another
 * thread's processes.
 *
 * The pool is the agent's supplementary groups in [{@link PI_UID_MIN}, {@link PI_UID_MAX}]: the pod
 * spec lists them (KOBE-22 manifests) so the agent can hand each Pi a directory only that Pi's
 * group can read (uid = gid per identity). An identity is handed out again only after every
 * process of its uid is gone (`--kill-all`) and its runtime directory removed, so nothing a tool
 * left running or wrote reaches the next thread that gets the uid.
 */
export const PI_UID_MIN = 2000;
export const PI_UID_MAX = 2063;
/** How long a new Pi waits for an identity (all in use, or still being reclaimed). */
export const ACQUIRE_TIMEOUT_MS = 30_000;
/** Bounded so a wedged helper cannot hold a slot or the agent's exit forever. */
const HELPER_TIMEOUT_MS = 10_000;

export interface PiIdentity {
  readonly uid: number;
  readonly gid: number;
}

/** Run a helper invocation to completion; resolves with its exit code and stderr. */
export type HelperRunner = (
  helper: string,
  args: readonly string[],
) => Promise<{ code: number | null; stderr: string }>;

const runHelper: HelperRunner = (helper, args) =>
  new Promise((resolve) => {
    let child;
    try {
      child = spawn(helper, [...args], {
        stdio: ["ignore", "ignore", "pipe"],
        env: { PATH: "/usr/local/bin:/usr/bin:/bin" },
        timeout: HELPER_TIMEOUT_MS,
        killSignal: "SIGKILL",
      });
    } catch (error) {
      // EPERM is thrown, not emitted: e.g. exec refused because the capabilities are not allowed.
      resolve({ code: null, stderr: (error as Error).message });
      return;
    }
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (text: string) => {
      stderr = (stderr + text).slice(-2048);
    });
    child.on("error", (error) => resolve({ code: null, stderr: error.message }));
    child.on("close", (code) => resolve({ code, stderr: stderr.trim() }));
  });

export class PiIdentityError extends Error {}

export class PiIdentities {
  readonly helper: string;
  readonly #all: readonly PiIdentity[];
  readonly #free: PiIdentity[];
  readonly #waiting: ((identity: PiIdentity) => void)[] = [];
  readonly #run: HelperRunner;

  constructor(helper: string, uids: readonly number[], run: HelperRunner = runHelper) {
    if (uids.length === 0) throw new PiIdentityError("no Pi identities");
    for (const uid of uids) {
      if (!Number.isInteger(uid) || uid < PI_UID_MIN || uid > PI_UID_MAX) {
        throw new PiIdentityError(`uid ${uid} is not a Pi identity`);
      }
    }
    this.helper = helper;
    this.#all = [...new Set(uids)].sort((a, b) => a - b).map((uid) => ({ uid, gid: uid }));
    this.#free = [...this.#all];
    this.#run = run;
  }

  get size(): number {
    return this.#all.length;
  }

  get available(): number {
    return this.#free.length;
  }

  /** The identity whose private group `gid` is (a Pi runtime directory's group). */
  byGid(gid: number): PiIdentity | undefined {
    return this.#all.find((identity) => identity.gid === gid);
  }

  /**
   * A free identity; waits while every identity is in use or still being reclaimed, at most
   * `timeoutMs` (identities whose reclaim failed are never handed out again).
   */
  acquire(timeoutMs = ACQUIRE_TIMEOUT_MS): Promise<PiIdentity> {
    const identity = this.#free.shift();
    if (identity !== undefined) return Promise.resolve(identity);
    return new Promise((resolve, reject) => {
      const waiter = (granted: PiIdentity) => {
        clearTimeout(timer);
        resolve(granted);
      };
      const timer = setTimeout(() => {
        const index = this.#waiting.indexOf(waiter);
        if (index !== -1) this.#waiting.splice(index, 1);
        reject(new PiIdentityError("no Pi identity is free"));
      }, timeoutMs);
      this.#waiting.push(waiter);
    });
  }

  /** Hand an identity back: only once none of its processes is left (see {@link reclaim}). */
  release(identity: PiIdentity): void {
    if (!this.#all.includes(identity) || this.#free.includes(identity)) return;
    const next = this.#waiting.shift();
    if (next !== undefined) next(identity);
    else this.#free.push(identity);
  }

  /**
   * `bin args…` as `identity`: the helper execs the program, so the pid is the program's. The
   * helper runs in secure-execution mode (file capabilities), where the C library drops
   * "unsafe" variables from the environment it passes on; of Pi's allow-listed environment that
   * is `TMPDIR` only, so it is set again through env(1) after the switch.
   */
  command(
    identity: PiIdentity,
    bin: string,
    args: readonly string[],
    env: Readonly<Record<string, string>> = {},
  ): readonly string[] {
    const tmpdir = env.TMPDIR === undefined ? [] : ["/usr/bin/env", `TMPDIR=${env.TMPDIR}`];
    return [String(identity.uid), ...tmpdir, bin, ...args];
  }

  /** SIGKILL every process of the identity's uid (Pi and every tool it left behind). */
  async killAll(identity: PiIdentity): Promise<void> {
    const { code, stderr } = await this.#run(this.helper, [String(identity.uid), "--kill-all"]);
    if (code !== 0) throw new PiIdentityError(`kill-all as ${identity.uid} failed: ${stderr}`);
  }

  /**
   * {@link killAll}, retried with backoff (a fork storm or a process in uninterruptible sleep can
   * outlast one helper run) for about a minute before the identity is given up.
   */
  async killAllPatiently(
    identity: PiIdentity,
    delaysMs: readonly number[] = [500, 1000, 2000, 4000, 8000, 15_000, 30_000],
  ): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        await this.killAll(identity);
        return;
      } catch (error) {
        const delay = delaysMs[attempt];
        if (delay === undefined) throw error;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  /** Synchronous {@link killAll} for the agent's own exit (no event loop left to wait on). */
  killAllSync(identity: PiIdentity): void {
    spawnSync(this.helper, [String(identity.uid), "--kill-all"], {
      stdio: "ignore",
      env: { PATH: "/usr/local/bin:/usr/bin:/bin" },
      timeout: HELPER_TIMEOUT_MS,
    });
  }

  /** Signal a process group of the identity (as the identity: the agent itself cannot). */
  async signalGroup(identity: PiIdentity, pgid: number, signal: "TERM" | "KILL"): Promise<void> {
    await this.#run(this.helper, [
      String(identity.uid),
      "/bin/kill",
      "-s",
      signal,
      "--",
      `-${pgid}`,
    ]);
  }

  /**
   * Remove what the identity's processes left in `dir` that the agent cannot remove itself (a
   * tool may create owner-only directories in the Pi's writable dirs). Runs as the identity, so
   * it can delete exactly what that uid could.
   */
  async removeContents(identity: PiIdentity, dir: string): Promise<void> {
    await this.#run(this.helper, [
      String(identity.uid),
      "/usr/bin/find",
      dir,
      "-mindepth",
      "1",
      "-delete",
    ]);
  }

  /** Run `/bin/true` as the first identity: proves the helper and its capabilities work. */
  async probe(): Promise<void> {
    const first = this.#all[0] as PiIdentity;
    const { code, stderr } = await this.#run(this.helper, [String(first.uid), "/bin/true"]);
    if (code !== 0) {
      throw new PiIdentityError(
        `cannot start processes as a Pi identity (${this.helper}, exit ${String(code)}): ${stderr}`,
      );
    }
  }
}

/** The Pi identities among the agent's supplementary groups. */
export function identityUids(groups: readonly number[]): number[] {
  return groups.filter((gid) => Number.isInteger(gid) && gid >= PI_UID_MIN && gid <= PI_UID_MAX);
}

/**
 * The helper must be a root-owned file nobody else can change (it carries the capabilities that
 * switch uids; the agent only ever runs it, never trusts a writable copy).
 */
export async function checkHelperFile(helper: string): Promise<void> {
  if (!helper.startsWith("/"))
    throw new PiIdentityError("the Pi identity helper path must be absolute");
  const info = await stat(helper).catch((error: unknown) => {
    throw new PiIdentityError(`Pi identity helper ${helper}: ${(error as Error).message}`);
  });
  if (!info.isFile()) throw new PiIdentityError(`Pi identity helper ${helper} is not a file`);
  if (info.uid !== 0 || (info.mode & 0o022) !== 0) {
    throw new PiIdentityError(
      `Pi identity helper ${helper} must be root-owned and not group/world-writable`,
    );
  }
}

/**
 * Pi identities from the helper and the agent's groups, checked: the helper file, at least
 * `minimum` identities, and one real switch. Fails closed: Kobe's pods ask for separation, and
 * an agent that cannot provide it must not start Pi under the agent's uid instead.
 */
export async function loadPiIdentities(
  helper: string,
  minimum: number,
  groups: readonly number[] = process.getgroups?.() ?? [],
  run?: HelperRunner,
): Promise<PiIdentities> {
  await checkHelperFile(helper);
  const uids = identityUids(groups);
  if (uids.length < minimum) {
    throw new PiIdentityError(
      `${uids.length} Pi identities (supplementary groups ${PI_UID_MIN}-${PI_UID_MAX}) for ` +
        `${minimum} Pi processes: the pod must list one group per process`,
    );
  }
  const identities = new PiIdentities(helper, uids, run);
  await identities.probe();
  return identities;
}
