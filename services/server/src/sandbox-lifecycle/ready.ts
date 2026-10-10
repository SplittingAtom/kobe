import type { Logger } from "pino";
import type { SandboxProvider } from "../sandbox/provider.js";
import type { StallDiagnosis } from "../sandbox/stall-diagnosis.js";
import { SandboxWakeError } from "../sandbox-wire/types.js";

/**
 * What a member sees when their workspace cannot start for a cluster reason (KOBE-192): no node,
 * volume or event text. The reason is in the audit log (`sandbox.wake_stalled`) and the server log.
 */
export const WORKSPACE_UNAVAILABLE_MESSAGE =
  "Your workspace could not be started because the cluster could not provide it. Ask your install admin to check the cluster, then try again.";

export type ReadyProvider = Pick<SandboxProvider, "awaitReady" | "retryStalledVolume">;

export interface StallReport {
  readonly sandboxId: string;
  readonly stall: StallDiagnosis;
}

export interface EnsureReadyOptions {
  readonly provider: ReadyProvider;
  readonly team: { readonly id: string; readonly slug: string };
  readonly userId: string;
  /**
   * Kobe has never seen this sandbox come up (no identity recorded). The one-time volume retry is
   * only allowed then: a sandbox that ran before may hold data on its volume.
   */
  readonly neverStarted: boolean;
  readonly log: Logger;
  readonly onStalled: (report: StallReport & { readonly retried: boolean }) => Promise<void>;
  readonly onRetried: (report: StallReport) => Promise<void>;
}

/**
 * Waits for the woken sandbox's pod to be Ready (within the wake timeout). If it is not, and its
 * workspace volume never worked, retries once on a fresh volume; if it still is not, records why
 * for install admins and fails the wake with `workspace_unavailable`.
 */
export async function ensureReady(options: EnsureReadyOptions): Promise<void> {
  const { provider, team, userId, log } = options;
  let outcome = await provider.awaitReady(team, userId);
  if (outcome.ready) return;
  let retried = false;
  const first = { sandboxId: outcome.sandboxId, stall: outcome.stall };
  if (options.neverStarted && (await provider.retryStalledVolume(team, userId)) === "retried") {
    retried = true;
    log.warn(
      { team_id: team.id, sandbox_id: first.sandboxId, cause: first.stall.cause },
      "workspace volume never worked: deleted the unused volume and pod once to reschedule",
    );
    await options.onRetried(first).catch((err: unknown) => log.error({ err }, "audit failed"));
    outcome = await provider.awaitReady(team, userId);
    if (outcome.ready) return;
  }
  const report = { sandboxId: outcome.sandboxId, stall: outcome.stall };
  log.error(
    {
      team_id: team.id,
      user_id: userId,
      sandbox_id: report.sandboxId,
      cause: report.stall.cause,
      detail: report.stall.detail,
      volume_phase: report.stall.volumePhase,
      retried,
    },
    "sandbox not ready within the wake timeout",
  );
  await options
    .onStalled({ ...report, retried })
    .catch((err: unknown) => log.error({ err }, "audit failed"));
  throw new SandboxWakeError("workspace_unavailable", WORKSPACE_UNAVAILABLE_MESSAGE);
}
