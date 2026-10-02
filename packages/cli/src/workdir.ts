import { rmSync } from "node:fs";
import { chmod, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Signals that end a restore early: Ctrl-C, a Kubernetes Job deadline or pod deletion, hangup. */
export const CLEANUP_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
type CleanupSignal = (typeof CLEANUP_SIGNALS)[number];

const SIGNAL_NUMBERS: Record<CleanupSignal, number> = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 };

/**
 * A private (0700) directory for the decrypted dump, under `base` (KOBE_TMPDIR) or the OS temp
 * directory. Point KOBE_TMPDIR at a memory-backed volume so plaintext never reaches a disk.
 */
export async function makePrivateWorkDir(base?: string): Promise<string> {
  const dir = await mkdtemp(join(base ?? tmpdir(), "kobe-restore-"));
  await chmod(dir, 0o700);
  return dir;
}

export interface SignalCleanup {
  /** What a signal does: delete `dir` synchronously, then exit with 128 + signal number. */
  handle(signal: CleanupSignal): void;
  dispose(): void;
}

/**
 * Deletes `dir` if the process is interrupted, since `finally` blocks do not run on a signal. The
 * psql child then sees its input close without COMMIT, so Postgres rolls the restore back.
 */
export function removeOnSignal(
  dir: string,
  exit: (code: number) => void = (code) => process.exit(code),
): SignalCleanup {
  const handle = (signal: CleanupSignal): void => {
    rmSync(dir, { recursive: true, force: true });
    exit(128 + SIGNAL_NUMBERS[signal]);
  };
  const listeners = CLEANUP_SIGNALS.map((s) => [s, () => handle(s)] as const);
  for (const [s, l] of listeners) process.once(s, l);
  return {
    handle,
    dispose: () => {
      for (const [s, l] of listeners) process.removeListener(s, l);
    },
  };
}
