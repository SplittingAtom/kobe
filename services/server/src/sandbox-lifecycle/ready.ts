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

/** What an install admin can do, by cause; appended to the audit detail (docs/install.md). */
export const REMEDY: Readonly<Record<StallDiagnosis["cause"], string>> = {
  volume_unschedulable:
    "Remedy: free or add Longhorn disk space or raise over-provisioning (docs/install.md, Longhorn sizing); the next message retries",
  volume_attach:
    "Remedy: check the Longhorn volume and node; if the workspace never ran, delete its PVC by hand (docs/install.md)",
  scheduling: "Remedy: add node capacity or check taints and quotas",
  image_pull: "Remedy: check the sandbox image tag, registry and pull secrets",
  unknown: "Remedy: kubectl describe the sandbox pod in the team namespace",
};

export type ReadyProvider = Pick<SandboxProvider, "awaitReady">;

export interface StallReport {
  readonly sandboxId: string;
  readonly stall: StallDiagnosis;
}

export interface EnsureReadyOptions {
  readonly provider: ReadyProvider;
  readonly team: { readonly id: string; readonly slug: string };
  readonly userId: string;
  /** Start of this wake (epoch ms): older cluster events are not about it. */
  readonly since: number;
  readonly log: Logger;
  readonly onStalled: (report: StallReport) => Promise<void>;
}

/**
 * Waits for the woken sandbox pod to be Ready. If it is not (a definite unrecoverable signal, or
 * the wake budget ran out), records why for install admins and fails the wake with
 * `workspace_unavailable`. Nothing is ever deleted here: the remedy is the admin to apply.
 */
export async function ensureReady(options: EnsureReadyOptions): Promise<void> {
  const { provider, team, userId, log } = options;
  const outcome = await provider.awaitReady(team, userId, options.since);
  if (outcome.ready) return;
  const report = { sandboxId: outcome.sandboxId, stall: outcome.stall };
  log.error(
    {
      team_id: team.id,
      user_id: userId,
      sandbox_id: report.sandboxId,
      cause: report.stall.cause,
      detail: report.stall.detail,
      volume_phase: report.stall.volumePhase,
      definite: report.stall.definite,
    },
    "sandbox not ready: failing the wake",
  );
  await options.onStalled(report).catch((err: unknown) => log.error({ err }, "audit failed"));
  throw new SandboxWakeError("workspace_unavailable", WORKSPACE_UNAVAILABLE_MESSAGE);
}
