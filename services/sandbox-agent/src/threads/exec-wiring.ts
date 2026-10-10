import { chmod, chown, mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { removeRuntimeDir } from "../models/runtime-dir.js";
import { ExecRelay } from "../exec/relay.js";
import { executorEnv, startExecutor } from "../exec/spawn-executor.js";
import { partnerOf, type PiIdentities, type PiIdentity } from "../pi/identities.js";
import type { PiProcess } from "../pi/pi-process.js";

/**
 * How a thread's Pi gets its tool executor (KOBE-167): the relay on Pi's fd 5 and the executor it
 * starts lazily as the identity's partner uid. Kept out of thread.ts, which only wires it in.
 */
export interface ExecWiring {
  /** `dist/exec/executor/main.js`, readable by every partner uid. */
  readonly executorEntry: string;
  /** The Node binary that runs it. */
  readonly nodeBin: string;
}

/**
 * The directory for what the executor's commands may read but Pi must not (the egress token): next
 * to the runtime directory, the agent's own with the *partner's* group, 2750, so only the
 * partner uid reads it and nobody can write it but the agent. The runtime directory stays
 * the Pi's group alone: the partner never reaches `agent/` or `model.json` (KOBE-166).
 */
export async function prepareToolDir(runtimeDir: string, identity: PiIdentity): Promise<string> {
  const dir = `${runtimeDir}-tool`;
  await mkdir(dir, { mode: 0o700 });
  await chown(dir, -1, partnerOf(identity).gid);
  await chmod(dir, 0o2750);
  return dir;
}

export interface PiPrivateDirs {
  readonly root: string;
  readonly home: string;
  readonly tmp: string;
}

/** Name prefix of Pi's private directories under the scratch volume (swept at agent start). */
export const PI_PRIVATE_PREFIX = "kobe-pi-";

/**
 * Pi's own HOME and TMPDIR once its tools are another uid (KOBE-196): Pi loads code from both
 * (jiti's transpile cache in `$TMPDIR/jiti`, Node's `$HOME/.node_modules`), so neither may be
 * writable by the partner uid, and `kobe-reclaim` must not hand them to the workspace group (they
 * are deleted before it runs). They live on the scratch volume (`base`, the pod's /tmp, sized for
 * tool output) and not on the small runtime volume the model file and egress token share: the bash
 * tool's "full output" logs land in this TMPDIR and are unbounded. `base` is a sticky directory, so
 * no other uid can rename or remove them. Agent-owned with the Pi's group: the root 2755, `home`
 * 2770 (the partner cannot even read it), `tmp` 2775 (the partner may read, never write: the
 * "Full output" files must stay readable to the read tool). The partner's HOME and TMPDIR stay the
 * shared ones.
 *
 * KOBE-228: the same directories without the executor (`partner: false`), where the tools are Pi's
 * own uid and mode 2770 keeps every other thread's uid out; the tools get the shared HOME/TMPDIR
 * through `KOBE_TOOL_HOME`/`KOBE_TOOL_TMPDIR` (the BASH_ENV script). Same uid means a tool of the
 * same thread can still reach them; see docs/ledger/KOBE-228.md.
 */
export async function preparePiPrivateDirs(
  base: string,
  runtimeDir: string,
  identity: PiIdentity | undefined,
  options: { readonly partner: boolean } = { partner: true },
): Promise<PiPrivateDirs> {
  const root = path.join(base, `${PI_PRIVATE_PREFIX}${path.basename(runtimeDir)}`);
  // Without a partner uid (KOBE-228) the tools are Pi's own uid: nothing is shared with them, and
  // other threads' uids (and the workspace group) get no access at all. Without any identity the
  // directories are the agent's alone (0700).
  const modes =
    identity === undefined
      ? ([0o700, 0o700, 0o700] as const)
      : options.partner
        ? ([0o2755, 0o2770, 0o2775] as const)
        : ([0o2770, 0o2770, 0o2770] as const);
  await mkdir(root, { mode: 0o700 });
  const dirs = { root, home: path.join(root, "home"), tmp: path.join(root, "tmp") };
  const entries = [
    [root, modes[0]],
    [dirs.home, modes[1]],
    [dirs.tmp, modes[2]],
  ] as const;
  for (const [dir, mode] of entries) {
    if (dir !== root) await mkdir(dir, { mode: 0o700 });
    if (identity !== undefined) await chown(dir, -1, identity.gid);
    await chmod(dir, mode);
  }
  return dirs;
}

/** What an earlier agent left under `base` (it died before its Pi exited); best effort. */
export async function sweepPiPrivateDirs(
  base: string,
  identities: PiIdentities | undefined,
): Promise<number> {
  let removed = 0;
  for (const name of await readdir(base).catch(() => [] as string[])) {
    if (!name.startsWith(PI_PRIVATE_PREFIX)) continue;
    const ok = await removeRuntimeDir(path.join(base, name), identities).then(
      () => true,
      () => false,
    );
    if (ok) removed += 1;
  }
  return removed;
}

export interface OpenRelayOptions {
  readonly pi: PiProcess;
  readonly wiring: ExecWiring;
  /** Pi's launch environment: the tools get the same allow-list from it. */
  readonly launchEnv: Readonly<Record<string, string>>;
  /** The egress variables (BASH_ENV and friends) the tools are meant to have. */
  readonly egress: Readonly<Record<string, string>>;
  readonly cwd: string;
  readonly runAs?: { readonly identities: PiIdentities; readonly identity: PiIdentity } | undefined;
  readonly onDiagnostic: (message: string) => void;
}

/** The relay between Pi's fd 5 and a lazily started executor. Throws when Pi has no fd 5. */
export function openRelay(options: OpenRelayOptions): ExecRelay {
  const channel = options.pi.execControl;
  if (channel === undefined) throw new Error("Pi was started without the exec channel");
  const env = executorEnv(options.launchEnv, options.egress);
  return new ExecRelay({
    channel,
    startExecutor: () =>
      startExecutor({
        nodeBin: options.wiring.nodeBin,
        entry: options.wiring.executorEntry,
        env,
        cwd: options.cwd,
        runAs: options.runAs,
        onDiagnostic: options.onDiagnostic,
      }),
    onDiagnostic: options.onDiagnostic,
  });
}

/** Paired identities are the only way the executor gets a uid of its own; refuse anything else. */
export function assertPaired(identities: PiIdentities | undefined): void {
  if (identities !== undefined && !identities.paired) {
    throw new Error("the tool executor needs paired (partner) uids, which this pod does not have");
  }
}
