import type { ApprovalMode, ErrorInfo, PiThreadConfig, RunTrigger } from "@kobe/protocol";
import type { KobeTx } from "@kobe/db";

/**
 * Seams the orchestrator calls on the run-start path, filled in by later tickets. Each runs inside
 * the run-start transaction, under the thread row lock (lock order thread → agent → run).
 */

export interface AgentResolutionInput {
  readonly teamId: string;
  /** The thread owner: the user the run executes as. */
  readonly ownerUserId: string;
  readonly threadId: string;
  readonly runId: string;
  readonly trigger: RunTrigger;
  /** The thread's pin (D19); both null = the install default agent. */
  readonly agentId: string | null;
  readonly agentVersion: number | null;
  /** The run's mode as fixed at creation (already clamped to the install/team floor). */
  readonly approvalMode: ApprovalMode;
}

export type AgentResolution =
  | {
      readonly ok: true;
      /** The exact version the run uses; null = the install default agent. */
      readonly agent: { readonly agentId: string; readonly version: number } | null;
      /**
       * The run's effective mode: the input's, made stricter by the pinned version's manifest
       * (KOBE-46 `effectiveApprovalMode`). Never looser than the input.
       */
      readonly approvalMode: ApprovalMode;
      /** Pi thread configuration from the version (model alias, prompt, skills; KOBE-41/47). */
      readonly config?: Omit<PiThreadConfig, "agent" | "approval_mode">;
    }
  | { readonly ok: false; readonly error: ErrorInfo };

/**
 * KOBE-46/47 seam: resolve the thread's pinned agent version for a run start and apply the
 * manifest clamps. The resolver must never fall back to another version or the default agent; an
 * error fails the run (`run.failed`).
 */
export interface RunAgentResolver {
  resolve(tx: KobeTx, input: AgentResolutionInput): Promise<AgentResolution>;
}

/**
 * Default until KOBE-46 lands on main: the thread's pin is passed through unchanged and the mode is
 * not tightened (no versions exist, so no thread can pin one yet: `resolveAgentPin` accepts only
 * null). KOBE-46/47 replace it with `resolvePinnedAgent` + `versionAllowsCall` +
 * `effectiveApprovalMode`.
 */
export const PASS_THROUGH_AGENTS: RunAgentResolver = {
  resolve(_tx, input) {
    const agent =
      input.agentId !== null && input.agentVersion !== null
        ? { agentId: input.agentId, version: input.agentVersion }
        : null;
    return Promise.resolve({ ok: true, agent, approvalMode: input.approvalMode });
  },
};

/** KOBE-42 seam: may this user start a new run in this team now (D30: blocked at 100 %)? */
export interface RunBudgetGate {
  allowsNewRun(
    tx: KobeTx,
    input: { readonly teamId: string; readonly userId: string },
  ): Promise<boolean>;
}

export const NO_BUDGETS: RunBudgetGate = { allowsNewRun: () => Promise.resolve(true) };

/** D4: agents run only under a verified gVisor/Kata RuntimeClass (`IsolationGate.status()`). */
export type IsolationProbe = () => "available" | "checking" | "missing";
