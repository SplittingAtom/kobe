import { chmod, chown, mkdir } from "node:fs/promises";
import path from "node:path";
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
export async function prepareToolDir(
  runtimeDir: string,
  identity: PiIdentity,
): Promise<string> {
  const dir = `${runtimeDir}-tool`;
  await mkdir(dir, { mode: 0o700 });
  await chown(dir, -1, partnerOf(identity).gid);
  await chmod(dir, 0o2750);
  return dir;
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
