import { spawn, spawnSync } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";

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
 * process of its uid is gone (`--kill-all`), its runtime directory is removed, and `kobe-reclaim`
 * has given everything the uid still owns in the shared trees (/workspace, $HOME, /tmp, /dev/shm)
 * to the workspace group and removed its System V IPC objects. Files outlive the uid (the
 * workspace is shared, D13), but nothing stays private to it: the next thread that gets the uid
 * can reach exactly what every other thread can.
 */
export const PI_UID_MIN = 2000;
export const PI_UID_MAX = 2063;
/**
 * Partner (tool) uids (KOBE-166, docs/design/paired-tool-uid.md): each Pi identity `P` is paired
 * with the uid `P + PARTNER_UID_OFFSET` in [{@link PARTNER_UID_MIN}, {@link PARTNER_UID_MAX}]
 * (uid = gid, groups {gid, workspace group}). The pair is allocated and reclaimed as one: a
 * partner uid is never in use without its Pi's identity being held, and the identity goes back
 * to the pool only after both uids have no process left. The tool executor (KOBE-167,
 * exec/) is the one process that runs as a partner uid, with everything the tools start.
 */
export const PARTNER_UID_OFFSET = 1000;
export const PARTNER_UID_MIN = PI_UID_MIN + PARTNER_UID_OFFSET;
export const PARTNER_UID_MAX = PI_UID_MAX + PARTNER_UID_OFFSET;
/** How long a new Pi waits for an identity (all in use, or still being reclaimed). */
export const ACQUIRE_TIMEOUT_MS = 30_000;
/** Bounded so a wedged helper cannot hold a slot or the agent's exit forever. */
const HELPER_TIMEOUT_MS = 10_000;

export interface PiIdentity {
  readonly uid: number;
  readonly gid: number;
}

/** The partner (tool) identity paired with a Pi identity. */
export function partnerOf(identity: PiIdentity): PiIdentity {
  const uid = identity.uid + PARTNER_UID_OFFSET;
  return { uid, gid: uid };
}

/** Run a helper invocation to completion; resolves with its exit code and stderr. */
export type HelperRunner = (
  helper: string,
  args: readonly string[],
  timeoutMs?: number,
) => Promise<{ code: number | null; stderr: string }>;

/**
 * The reclaim walks the shared trees (a large /workspace, node_modules, venvs) and may take
 * minutes under gVisor; it is retried a few times before the identity is given up.
 */
export const RECLAIM_TIMEOUT_MS = 5 * 60_000;
export const RECLAIM_RETRY_DELAYS_MS = [5_000, 30_000] as const;

const runHelper: HelperRunner = (helper, args, timeoutMs = HELPER_TIMEOUT_MS) =>
  new Promise((resolve) => {
    let child;
    try {
      child = spawn(helper, [...args], {
        stdio: ["ignore", "ignore", "pipe"],
        env: { PATH: "/usr/local/bin:/usr/bin:/bin" },
        timeout: timeoutMs,
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
  readonly #killing = new Map<number, Promise<void>>();

  constructor(
    helper: string,
    uids: readonly number[],
    run: HelperRunner = runHelper,
    reclaimScript: string = reclaimScriptFor(helper),
    /** The agent holds the partner groups too (pod spec KOBE-166): pairs are in force. */
    readonly paired: boolean = false,
  ) {
    if (uids.length === 0) throw new PiIdentityError("no Pi identities");
    for (const uid of uids) {
      if (!Number.isInteger(uid) || uid < PI_UID_MIN || uid > PI_UID_MAX) {
        throw new PiIdentityError(`uid ${uid} is not a Pi identity`);
      }
    }
    this.helper = helper;
    this.reclaimScript = reclaimScript;
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
    return runasArgs(identity.uid, bin, args, env);
  }

  /**
   * Like {@link command}, as the identity's partner (tool) uid. The helper keeps only stdio for
   * it (fd 0-2): the executor (KOBE-167) talks to the agent's relay over them.
   */
  partnerCommand(
    identity: PiIdentity,
    bin: string,
    args: readonly string[],
    env: Readonly<Record<string, string>> = {},
  ): readonly string[] {
    return runasArgs(partnerOf(identity).uid, bin, args, env);
  }

  /** The uids that belong to `identity` and must be empty before it is reused. */
  #uidsOf(identity: PiIdentity): readonly PiIdentity[] {
    return this.paired ? [identity, partnerOf(identity)] : [identity];
  }

  /**
   * SIGKILL every process of the identity's uid (Pi and every tool it left behind). Serialised
   * per identity: a stop and an exit reclaim never race each other.
   */
  killAll(identity: PiIdentity): Promise<void> {
    const previous = this.#killing.get(identity.uid) ?? Promise.resolve();
    const next = previous.then(async () => {
      // Both uids of a pair, every one attempted even if an earlier one fails.
      const failures: string[] = [];
      for (const target of this.#uidsOf(identity)) {
        const { code, stderr } = await this.#run(this.helper, [String(target.uid), "--kill-all"]);
        if (code !== 0) failures.push(`kill-all as ${target.uid} failed: ${stderr}`);
      }
      if (failures.length > 0) throw new PiIdentityError(failures.join("; "));
    });
    const settled = next.catch(() => undefined);
    this.#killing.set(identity.uid, settled);
    void settled.then(() => {
      if (this.#killing.get(identity.uid) === settled) this.#killing.delete(identity.uid);
    });
    return next;
  }

  /**
   * SIGKILL every process of the identity's partner (tool) uid only: the executor and what it
   * started, when the executor died or is being replaced while the Pi lives on (KOBE-167).
   * Serialised with {@link killAll} of the same identity.
   */
  killPartner(identity: PiIdentity): Promise<void> {
    if (!this.paired) return Promise.reject(new PiIdentityError("no partner uid without pairs"));
    const previous = this.#killing.get(identity.uid) ?? Promise.resolve();
    const next = previous.then(async () => {
      const target = partnerOf(identity);
      const { code, stderr } = await this.#run(this.helper, [String(target.uid), "--kill-all"]);
      if (code !== 0) throw new PiIdentityError(`kill-all as ${target.uid} failed: ${stderr}`);
    });
    const settled = next.catch(() => undefined);
    this.#killing.set(identity.uid, settled);
    void settled.then(() => {
      if (this.#killing.get(identity.uid) === settled) this.#killing.delete(identity.uid);
    });
    return next;
  }

  /**
   * After {@link killAll}: as the identity, hand what it still owns under `dirs` to the workspace
   * group `gid`, delete what it owns in `purgeDirs`, and remove its System V IPC objects
   * (`kobe-reclaim`, next to the helper). Throws if anything could not be reclaimed (non-zero
   * exit, after retries): the caller must then keep the identity out of use.
   */
  async reclaimFiles(
    identity: PiIdentity,
    gid: number,
    dirs: readonly string[],
    options: {
      readonly timeoutMs?: number;
      readonly delaysMs?: readonly number[];
      /** Dirs (the Pi runtime dir) where everything the uid owns at top level is deleted. */
      readonly purgeDirs?: readonly string[];
    } = {},
  ): Promise<void> {
    for (const target of this.#uidsOf(identity)) {
      await this.#reclaimOne(target, gid, dirs, options);
    }
  }

  async #reclaimOne(
    identity: PiIdentity,
    gid: number,
    dirs: readonly string[],
    options: {
      readonly timeoutMs?: number;
      readonly delaysMs?: readonly number[];
      readonly purgeDirs?: readonly string[];
    },
  ): Promise<void> {
    const purge = options.purgeDirs ?? [];
    const delays = options.delaysMs ?? RECLAIM_RETRY_DELAYS_MS;
    for (let attempt = 0; ; attempt++) {
      const { code, stderr } = await this.#run(
        this.helper,
        [
          String(identity.uid),
          this.reclaimScript,
          String(gid),
          ...dirs,
          ...(purge.length > 0 ? ["--", ...purge] : []),
        ],
        options.timeoutMs ?? RECLAIM_TIMEOUT_MS,
      );
      if (code === 0) return;
      const delay = delays[attempt];
      if (delay === undefined) {
        throw new PiIdentityError(
          `reclaim as ${identity.uid} failed${code === null ? " (timed out)" : ""}: ${stderr}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  /** The reclaim script: `kobe-reclaim` in the helper's directory (root-owned, image). */
  readonly reclaimScript: string;

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
    for (const target of this.#uidsOf(identity)) {
      spawnSync(this.helper, [String(target.uid), "--kill-all"], {
        stdio: "ignore",
        env: { PATH: "/usr/local/bin:/usr/bin:/bin" },
        timeout: HELPER_TIMEOUT_MS,
      });
    }
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

  /**
   * As the first identity, a child process tries to ptrace its parent and read its memory
   * (`--probe-ptrace`): proves the helper switches uids, and that a tool (which shares its Pi's
   * uid) cannot reach into its Pi, where kobe-policy and the policy socket live. Behavioural,
   * not a sysctl reading: whatever the kernel (gVisor, a Kata guest), both must be refused.
   */
  async probe(): Promise<void> {
    const first = this.#all[0] as PiIdentity;
    const { code, stderr } = await this.#run(this.helper, [String(first.uid), "--probe-ptrace"]);
    if (code !== 0) {
      throw new PiIdentityError(
        `cannot start processes as a Pi identity, or a tool could ptrace its Pi (${this.helper}, ` +
          `exit ${String(code)}): ${stderr}`,
      );
    }
    if (!this.paired) return;
    const partner = partnerOf(first);
    const second = await this.#run(this.helper, [String(partner.uid), "--probe-ptrace"]);
    if (second.code !== 0) {
      throw new PiIdentityError(
        `cannot start processes as a partner (tool) identity (${this.helper}, exit ` +
          `${String(second.code)}): ${second.stderr}`,
      );
    }
  }
}

/** `kobe-runas <uid> [env TMPDIR=…] bin args…` (see {@link PiIdentities.command}). */
function runasArgs(
  uid: number,
  bin: string,
  args: readonly string[],
  env: Readonly<Record<string, string>>,
): readonly string[] {
  const tmpdir = env.TMPDIR === undefined ? [] : ["/usr/bin/env", `TMPDIR=${env.TMPDIR}`];
  return [String(uid), ...tmpdir, bin, ...args];
}

/** `kobe-reclaim`, installed next to the helper. */
export function reclaimScriptFor(helper: string): string {
  return path.join(path.dirname(helper), "kobe-reclaim");
}

/** The Pi identities among the agent's supplementary groups. */
export function identityUids(groups: readonly number[]): number[] {
  return groups.filter((gid) => Number.isInteger(gid) && gid >= PI_UID_MIN && gid <= PI_UID_MAX);
}

/**
 * Whether the agent holds the partner group of every Pi identity in `uids` (the pod spec from
 * KOBE-166 on): only then are pairs in force. A pod spec from before leaves Pi as it was.
 */
export function pairedUids(uids: readonly number[], groups: readonly number[]): boolean {
  return uids.length > 0 && uids.every((uid) => groups.includes(uid + PARTNER_UID_OFFSET));
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
  reclaimScript: string = reclaimScriptFor(helper),
): Promise<PiIdentities> {
  await checkHelperFile(helper);
  await checkHelperFile(reclaimScript);
  const uids = identityUids(groups);
  if (uids.length < minimum) {
    throw new PiIdentityError(
      `${uids.length} Pi identities (supplementary groups ${PI_UID_MIN}-${PI_UID_MAX}) for ` +
        `${minimum} Pi processes: the pod must list one group per process`,
    );
  }
  const identities = new PiIdentities(helper, uids, run, reclaimScript, pairedUids(uids, groups));
  await identities.probe();
  return identities;
}
