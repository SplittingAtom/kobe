import type { KobeDb } from "@kobe/db";
import type { Logger } from "pino";
import type { SandboxRouter } from "../sandbox-wire/types.js";
import type { ApprovalKeyring } from "./keys.js";
import type { AuditThrottle } from "./throttle.js";

/** Late-bound run seams: the wire's router and the orchestrator's queue hook (created after us). */
export interface ApprovalRunHooks {
  router?: SandboxRouter;
  onRunEnded?: (event: {
    readonly teamId: string;
    readonly runId: string;
    readonly threadId: string;
  }) => Promise<void> | void;
}

export interface ApprovalContext {
  readonly db: KobeDb;
  /** Absent: approvals can't be signed, so every approval request is denied (fail closed). */
  readonly keys: ApprovalKeyring | undefined;
  /** Pending TTL (D29: 1 h). */
  readonly ttlMs: number;
  readonly now: () => Date;
  readonly log: Logger;
  readonly hooks: ApprovalRunHooks;
  /** The wire's run event cap (`WireTuning.runMaxEvents`): no new approval past it. */
  readonly runMaxEvents: number;
  /** Throttles server-side `approval.rejected` rows. */
  readonly throttle: AuditThrottle;
}

/** An API-facing failure with its HTTP status and stable code. */
export class ApprovalError extends Error {
  constructor(
    readonly code:
      | "approval_not_found"
      | "approval_resolved"
      | "approval_expired"
      | "run_not_active"
      | "invalid_remember"
      | "glob_too_broad"
      | "too_many_rules"
      | "approvals_unavailable"
      | "approval_unavailable",
    readonly status: 400 | 404 | 409 | 503,
    message: string,
  ) {
    super(message);
    this.name = "ApprovalError";
  }
}
