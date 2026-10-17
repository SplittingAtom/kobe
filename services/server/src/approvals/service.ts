import {
  APPROVAL_TTL_MS,
  type ActorContext,
  type ApprovalResolutionBody,
  type ApproveAllBody,
  type ToolRegistry,
} from "@kobe/protocol";
import type { KobeDb } from "@kobe/db";
import type { Logger } from "pino";
import { logger as rootLogger } from "../logger.js";
import { createToolRegistry } from "../policy/registry.js";
import { WIRE_DEFAULTS } from "../sandbox-wire/constants.js";
import { ApprovalBrokerImpl } from "./broker.js";
import type { ApprovalContext, ApprovalRunHooks } from "./context.js";
import { approveAll } from "./approve-all.js";
import { decideApproval, getApproval, listMyApprovals } from "./decide.js";
import { rememberOptions, type RememberOptionsView } from "./remember-options.js";
import { sweepExpired } from "./expiry.js";
import { expireAborted } from "./expiry.js";
import type { ApprovalKeyring } from "./keys.js";
import { AuditThrottle } from "./throttle.js";
import { createApprovalVerifier, type ApprovalVerifier } from "./verify.js";
import type { ApprovalView } from "./view.js";

export interface ApprovalServiceOptions {
  readonly db: KobeDb;
  /** The site's approval key; absent → approvals are denied (logged at startup). */
  readonly keys?: ApprovalKeyring;
  /** Pending TTL (default D29's 1 h; tests shorten it). */
  readonly ttlMs?: number;
  /** Broker re-read interval without a hint (default 2 s). */
  readonly pollMs?: number;
  /** Expiry sweep interval for approvals no broker waits on (default 30 s). */
  readonly sweepMs?: number;
  readonly now?: () => Date;
  /** The wire's run event cap (default `WIRE_DEFAULTS.runMaxEvents`). */
  readonly runMaxEvents?: number;
  /** Where approvals log (default: the server logger's `approvals` child; tests read it). */
  readonly log?: Logger;
  /** The server's tool registry (default: built-in tools only; the server passes its own). */
  readonly registry?: ToolRegistry;
}

/**
 * Approvals (KOBE-37, D29): the wire's broker, the decision API, the TTL sweep and the MCP proxy's
 * verifier, sharing one context. The run router and the orchestrator's queue hook are bound after
 * construction (`bind`), since both are built after the broker the wire needs.
 */
export class ApprovalService {
  readonly broker: ApprovalBrokerImpl;
  readonly verifier: ApprovalVerifier;
  readonly #ctx: ApprovalContext;
  readonly #hooks: ApprovalRunHooks = {};
  readonly #sweepMs: number;
  #timer: NodeJS.Timeout | undefined;

  constructor(options: ApprovalServiceOptions) {
    const log = options.log ?? rootLogger.child({ component: "approvals" });
    this.#ctx = {
      db: options.db,
      keys: options.keys,
      ttlMs: options.ttlMs ?? APPROVAL_TTL_MS,
      now: options.now ?? (() => new Date()),
      log,
      hooks: this.#hooks,
      runMaxEvents: options.runMaxEvents ?? WIRE_DEFAULTS.runMaxEvents,
      throttle: new AuditThrottle(),
      registry: options.registry ?? createToolRegistry(),
    };
    this.#sweepMs = options.sweepMs ?? 30_000;
    this.broker = new ApprovalBrokerImpl(this.#ctx, { pollMs: options.pollMs ?? 2_000 });
    this.verifier = createApprovalVerifier({
      db: options.db,
      keys: options.keys,
      now: this.#ctx.now,
      log,
    });
    if (!options.keys) {
      log.error("KOBE_APPROVAL_KEY is not set: tool calls that need approval are denied");
    }
  }

  get configured(): boolean {
    return this.#ctx.keys !== undefined;
  }

  bind(hooks: ApprovalRunHooks): void {
    Object.assign(this.#hooks, hooks);
  }

  decide(
    actor: ActorContext,
    approvalId: string,
    body: ApprovalResolutionBody,
  ): Promise<ApprovalView> {
    return decideApproval(this.#ctx, actor, approvalId, body);
  }

  /** "Approve all waiting" (KOBE-289): every listed pending approval of one run, each signed. */
  approveAll(actor: ActorContext, body: ApproveAllBody): Promise<ApprovalView[]> {
    return approveAll(this.#ctx, actor, body);
  }

  /** What the card may offer for one pending approval (KOBE-289): the server's own judgement. */
  rememberOptions(actor: ActorContext, approvalId: string): Promise<RememberOptionsView> {
    return rememberOptions(this.#ctx, actor, approvalId);
  }

  get(actor: ActorContext, approvalId: string): Promise<ApprovalView> {
    return getApproval(this.#ctx, actor, approvalId);
  }

  list(
    actor: ActorContext,
    filter: { readonly status?: ApprovalView["status"]; readonly runId?: string },
  ): Promise<ApprovalView[]> {
    return listMyApprovals(this.#ctx, actor, filter);
  }

  /**
   * The connection that asked for `approvalId` is gone: expire it if pending, void it if allowed
   * but not delivered (the broker calls this on abort; exposed for operations and tests).
   */
  async abandon(teamId: string, approvalId: string): Promise<void> {
    await expireAborted(this.#ctx, teamId, approvalId);
  }

  /** Expires overdue approvals no broker is waiting on; `graceMs` lets the waiter go first. */
  sweep(graceMs = 5_000): Promise<number> {
    return sweepExpired(this.#ctx, graceMs);
  }

  start(): void {
    if (this.#timer) return;
    const tick = () => {
      this.#timer = setTimeout(
        () => {
          this.sweep()
            .catch((err: unknown) => this.#ctx.log.error({ err }, "approval sweep failed"))
            .finally(() => {
              if (this.#timer) tick();
            });
        },
        this.#sweepMs * (0.5 + Math.random()),
      );
      this.#timer.unref();
    };
    tick();
  }

  stop(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
  }
}
