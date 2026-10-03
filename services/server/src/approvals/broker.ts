import {
  CanonicalJsonError,
  canonicalJson,
  isActiveRunStatus,
  type JsonObject,
  type PolicyReason,
} from "@kobe/protocol";
import { SYSTEM_ACTOR, withTeam } from "@kobe/db";
import { recordAudit } from "../audit/record.js";
import { appendRunEventsInTx, withAppendTx, type NewRunEvent } from "../event-stream/append.js";
import { applyTransition, lockRunRow, lockThreadRow } from "../runs/store.js";
import type { ApprovalBroker, ApprovalOutcome, ApprovalRequest } from "../sandbox-wire/types.js";
import type { ApprovalContext } from "./context.js";
import { expireAborted, expireByTtl } from "./expiry.js";
import { insertPendingApproval, loadApproval, tokenOf, type ApprovalRow } from "./store.js";

/**
 * The approval broker (KOBE-37; `ApprovalBroker` seam of the sandbox wire, KOBE-24). For a
 * `require_approval` decision it records a pending `approvals` row (1 h TTL, D29), moves the run to
 * `waiting_approval`, appends `approval.requested` (the card), tells the sandbox `policy.pending`,
 * and waits — on a bus hint (`apr:<id>`, any replica), a poll, the TTL timer, or the connection
 * closing — until the run's user decides, the TTL passes, or the run ends. Only then does the
 * sandbox get its `policy.result`: `allow` (the signed token stays server-side), or `deny` saying
 * why.
 */

/** Largest canonical input put on an approval card (the event payload cap is 256 KiB). */
export const APPROVAL_INPUT_SHOWN_MAX_BYTES = 192 * 1024;

export interface BrokerTuning {
  /** Re-read a pending approval this often even without a hint (default 2 s). */
  readonly pollMs: number;
}

type Waiter = () => void;

const DENY_PREFIX = "The tool call was denied: ";

/** Why a decided row means deny, in the words the tool error and the card use. */
function denyMessage(row: ApprovalRow): string {
  if (row.status === "denied") return "You denied this tool call.";
  switch (row.cause) {
    case "ttl":
      return "The approval request expired after 1 hour without an answer.";
    case "budget_exhausted":
      return "The budget is used up, so the pending approval expired.";
    case "run_cancelled":
      return "The run was stopped while the approval was pending.";
    case "run_failed":
      return "The run failed while the approval was pending.";
    default:
      return "The run was interrupted while the approval was pending.";
  }
}

/** Reason for an approval that ended without being allowed (the contract has no own code). */
function denyReasons(row: ApprovalRow, prompted: readonly PolicyReason[]): PolicyReason[] {
  if (row.cause === "budget_exhausted") {
    return [{ code: "budget_exhausted", stage: "prompt", message: denyMessage(row) }];
  }
  return prompted.map((r) => ({
    ...r,
    message: `${denyMessage(row)} (${r.message})`.slice(0, 1000),
  }));
}

export class ApprovalBrokerImpl implements ApprovalBroker {
  readonly #ctx: ApprovalContext;
  readonly #tuning: BrokerTuning;
  readonly #waiters = new Map<string, Waiter>();
  /** Expiries of approvals whose connection closed, still being written (awaited on close). */
  readonly #aborting = new Set<Promise<unknown>>();
  readonly #finishers = new Set<() => void>();
  #closed = false;

  constructor(ctx: ApprovalContext, tuning: BrokerTuning) {
    this.#ctx = ctx;
    this.#tuning = tuning;
  }

  /** Approvals this replica is waiting on (tests, metrics). */
  get waiting(): number {
    return this.#waiters.size;
  }

  onHint(approvalId: string): void {
    this.#waiters.get(approvalId)?.();
  }

  onResync(): void {
    for (const check of this.#waiters.values()) check();
  }

  /**
   * Shutdown, after the wire closed its connections (each pending check was aborted, so its
   * approval is being expired): waits for those writes, then stops every remaining wait.
   */
  async close(): Promise<void> {
    this.#closed = true;
    await Promise.allSettled([...this.#aborting]);
    for (const finish of [...this.#finishers]) finish();
  }

  async request(
    req: ApprovalRequest,
    onPending: (pending: { readonly approvalId: string; readonly expiresAt: string }) => void,
  ): Promise<ApprovalOutcome> {
    const deny = (message: string): ApprovalOutcome => ({
      decision: "deny",
      reasons: req.decision.reasons,
      message: `${DENY_PREFIX}${message}`.slice(0, 2000),
    });
    if (!this.#ctx.keys) {
      return deny("approvals are not configured on this server (KOBE_APPROVAL_KEY).");
    }
    if (req.signal.aborted || this.#closed) return deny("the run's connection closed.");
    let canonical: string;
    try {
      canonical = canonicalJson(req.input);
    } catch (err) {
      if (err instanceof CanonicalJsonError) return deny("its input is not plain JSON.");
      throw err;
    }
    if (Buffer.byteLength(canonical, "utf8") > APPROVAL_INPUT_SHOWN_MAX_BYTES) {
      return deny("its input is too large to review for approval (over 192 KiB).");
    }
    const created = await this.#create(req, canonical);
    if (created.kind !== "created") {
      return deny(
        created.kind === "replay"
          ? "this tool call id already asked for approval in this run."
          : "the run is no longer active.",
      );
    }
    onPending({ approvalId: created.id, expiresAt: created.expiresAt.toISOString() });
    const row = await this.#wait(req.teamId, created.id, created.expiresAt, req.signal);
    if (row === "aborted" || row === undefined) return deny("the run's connection closed.");
    if (row.status === "allowed") {
      // The signed token stays server-side (approval.ts: "neither the key nor the token ever
      // enters a sandbox"); the MCP proxy finds it by (run, tool_call_id). For built-in and kobe
      // tools this allow is itself the authorisation.
      if (!tokenOf(row)) return deny("the approval could not be verified.");
      return {
        decision: "allow",
        reasons: [{ code: "approval_granted", stage: "prompt", message: "Approved by you." }],
      };
    }
    return {
      decision: "deny",
      reasons: denyReasons(row, req.decision.reasons),
      message: `${DENY_PREFIX}${denyMessage(row)}`,
    };
  }

  async #create(
    req: ApprovalRequest,
    canonical: string,
  ): Promise<
    | { readonly kind: "created"; readonly id: string; readonly expiresAt: Date }
    | { readonly kind: "inactive" | "replay" }
  > {
    const { teamId } = req;
    const expiresAt = new Date(this.#ctx.now().getTime() + this.#ctx.ttlMs);
    return withAppendTx(this.#ctx.db, teamId, async (tx) => {
      const thread = await lockThreadRow(tx, teamId, req.threadId);
      const run = await lockRunRow(tx, teamId, req.runId);
      if (
        !thread ||
        !run ||
        run.threadId !== thread.id ||
        thread.ownerUserId !== req.userId ||
        !isActiveRunStatus(run.status)
      ) {
        return { kind: "inactive" as const };
      }
      const id = await insertPendingApproval(tx, {
        teamId,
        runId: run.id,
        threadId: thread.id,
        userId: req.userId,
        toolCallId: req.toolCallId,
        tool: req.tool,
        inputCanonical: canonical,
        risk: req.decision.risk,
        reasons: req.decision.reasons,
        expiresAt,
      });
      if (id === undefined) return { kind: "replay" as const };
      const event: NewRunEvent = {
        type: "approval.requested",
        payload: {
          approval_id: id,
          tool_call_id: req.toolCallId,
          tool: req.tool,
          input: JSON.parse(canonical) as JsonObject,
          risk: req.decision.risk,
          reasons: [...req.decision.reasons],
          expires_at: expiresAt.toISOString(),
        },
      };
      if (run.status === "running") {
        await applyTransition(tx, thread, run, "waiting_approval", "approval_requested", event);
      } else {
        await appendRunEventsInTx(tx, teamId, run.id, [event]);
      }
      await recordAudit(tx, {
        action: "approval.requested",
        actor: SYSTEM_ACTOR,
        teamId,
        target: {
          approvalId: id,
          runId: run.id,
          threadId: thread.id,
          toolCallId: req.toolCallId,
          tool: req.tool,
          risk: req.decision.risk,
          userId: req.userId,
        },
      });
      return { kind: "created" as const, id, expiresAt };
    });
  }

  /**
   * Resolves with the row once it leaves `pending` (or undefined when it vanished with its run),
   * `"aborted"` when the connection closed first. Never rejects: read errors are logged and the
   * next poll tries again.
   */
  #wait(
    teamId: string,
    approvalId: string,
    expiresAt: Date,
    signal: AbortSignal,
  ): Promise<ApprovalRow | "aborted" | undefined> {
    const ctx = this.#ctx;
    return new Promise((resolve) => {
      let done = false;
      let busy = false;
      let again = false;
      const timers: NodeJS.Timeout[] = [];
      const finish = (value: ApprovalRow | "aborted" | undefined) => {
        if (done) return;
        done = true;
        for (const t of timers) clearTimeout(t);
        this.#waiters.delete(approvalId);
        this.#finishers.delete(stop);
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      };
      const stop = () => finish("aborted");
      this.#finishers.add(stop);
      const check = (): void => {
        if (done || this.#closed) return;
        if (busy) {
          again = true;
          return;
        }
        busy = true;
        void (async () => {
          try {
            const row = await withTeam(ctx.db, teamId, (tx) =>
              loadApproval(tx, teamId, approvalId),
            );
            if (row?.status !== "pending") {
              finish(row);
              return;
            }
            if (ctx.now() >= row.expiresAt && (await expireByTtl(ctx, teamId, approvalId))) {
              again = true;
            }
          } catch (err) {
            ctx.log.warn({ err, approval_id: approvalId }, "approval check failed; retrying");
          } finally {
            busy = false;
            if (again && !done) {
              again = false;
              check();
            }
          }
        })();
      };
      const onAbort = () => {
        if (done) return;
        // The sandbox already denied the call itself; record that the approval can't be used.
        const expiring = expireAborted(ctx, teamId, approvalId)
          .catch((err: unknown) =>
            ctx.log.warn({ err, approval_id: approvalId }, "could not expire an aborted approval"),
          )
          .finally(() => {
            this.#aborting.delete(expiring);
            finish("aborted");
          });
        this.#aborting.add(expiring);
      };
      this.#waiters.set(approvalId, check);
      signal.addEventListener("abort", onAbort, { once: true });
      const poll = setInterval(check, this.#tuning.pollMs);
      poll.unref();
      timers.push(poll);
      const due = setTimeout(check, Math.max(0, expiresAt.getTime() - ctx.now().getTime()) + 25);
      due.unref();
      timers.push(due);
      if (signal.aborted) onAbort();
      else check();
    });
  }
}
