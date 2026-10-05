import type { ApprovalMode, ErrorInfo, PiThreadConfig, RunTrigger } from "@kobe/protocol";
import type { AgentScope, KobeTx } from "@kobe/db";
import type { Omission } from "../resolver/resolve.js";

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
  /** The thread's pin (D19); all null = the install default agent. */
  readonly agentScope: AgentScope | null;
  readonly agentId: string | null;
  readonly agentVersion: number | null;
  /** The run's mode as fixed at creation (already clamped to the install/team floor). */
  readonly approvalMode: ApprovalMode;
}

export type AgentResolution =
  | {
      readonly ok: true;
      /**
       * The exact version the run uses; null = the install default agent. `version` null = the
       * agent's draft (a builder test thread, KOBE-85).
       */
      readonly agent: {
        readonly agentId: string;
        readonly version: number | null;
        /** With `version` null: the revision of the draft that ran (KOBE-85). */
        readonly draftRevision?: number;
      } | null;
      /**
       * The run's effective mode: the input's, made stricter by the pinned version's manifest
       * (KOBE-46 `effectiveApprovalMode`). Never looser than the input.
       */
      readonly approvalMode: ApprovalMode;
      /** Pi thread configuration from the version (model alias, prompt, skills; KOBE-41/47). */
      readonly config?: Omit<PiThreadConfig, "agent" | "approval_mode">;
      /** What the effective-config resolver left out (KOBE-76; KOBE-77 turns it into notices). */
      readonly omissions?: readonly Omission[];
    }
  | { readonly ok: false; readonly error: ErrorInfo };

/**
 * KOBE-46/47 seam: resolve the thread's pinned agent version for a run start and apply the
 * manifest clamps. The resolver must never fall back to another version or the default agent; an
 * error fails the run (`run.failed`).
 */
export interface RunAgentResolver {
  resolve(tx: KobeTx, input: AgentResolutionInput): Promise<AgentResolution>;
  /**
   * KOBE-44 seam for KOBE-47: the model alias the thread's agent pins, if any — the same alias
   * `resolve` puts in `config.model.alias`. The chat shows it (the picker is locked: the agent's
   * pin wins over the conversation's choice, user decision 2026-10-04). Absent or undefined: the
   * agent pins no model (today's resolvers: agents carry no model until KOBE-47). Called on thread
   * reads: it must only read Postgres through `tx` (history reads never wake a sandbox, D14).
   */
  pinnedModel?(tx: KobeTx, input: AgentPinInput): Promise<string | undefined>;
}

/** The thread's agent pin as `pinnedModel` reads it (no run yet). */
export interface AgentPinInput {
  readonly teamId: string;
  readonly ownerUserId: string;
  readonly threadId: string;
  readonly agentScope: AgentScope | null;
  readonly agentId: string | null;
  readonly agentVersion: number | null;
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
