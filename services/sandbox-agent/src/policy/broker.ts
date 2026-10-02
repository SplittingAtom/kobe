import type { PolicyCheckFrame } from "@kobe/protocol";
import { MAX_PENDING_CHECKS } from "../kobe-policy/protocol.js";
import { localDeny, type PolicyChannelCheck, type PolicyChannelReply } from "./channel.js";

/**
 * Routes kobe-policy checks to the server and the answers back (frames.ts `policy.check`,
 * `policy.pending`, `policy.result`). Wire `request_id`s are minted here, so two threads' extensions
 * can never collide or answer each other's checks. Every pending check is answered exactly once;
 * anything that prevents an answer from the server is a deny (fail closed).
 */
export const MAX_PENDING_POLICY_CHECKS = 512;
/** Per thread, so one thread's extension (or code abusing its channel) cannot starve the others. */
export const MAX_PENDING_POLICY_CHECKS_PER_THREAD = MAX_PENDING_CHECKS;

interface PendingCheck {
  readonly threadId: string;
  readonly runId: string;
  readonly extensionRequestId: string;
  readonly reply: (message: PolicyChannelReply) => void;
}

export interface PolicyBrokerDeps {
  /** Send a frame now; false when the wire is not ready. */
  readonly send: (frame: PolicyCheckFrame) => boolean;
}

export class PolicyBroker {
  readonly #deps: PolicyBrokerDeps;
  readonly #pending = new Map<string, PendingCheck>();
  #next = 1;

  constructor(deps: PolicyBrokerDeps) {
    this.#deps = deps;
  }

  get pendingCount(): number {
    return this.#pending.size;
  }

  check(
    threadId: string,
    runId: string | undefined,
    check: PolicyChannelCheck,
    reply: (message: PolicyChannelReply) => void,
  ): void {
    if (runId === undefined) {
      reply(localDeny(check.request_id, "no active run on this thread"));
      return;
    }
    const perThread = [...this.#pending.values()].filter((p) => p.threadId === threadId).length;
    if (
      this.#pending.size >= MAX_PENDING_POLICY_CHECKS ||
      perThread >= MAX_PENDING_POLICY_CHECKS_PER_THREAD
    ) {
      reply(localDeny(check.request_id, "too many pending policy checks"));
      return;
    }
    const requestId = `pc_${this.#next++}`;
    const frame: PolicyCheckFrame = {
      v: 1,
      type: "policy.check",
      request_id: requestId,
      run_id: runId,
      thread_id: threadId,
      tool_call_id: check.tool_call_id,
      ...(check.parent_tool_call_id === undefined
        ? {}
        : { parent_tool_call_id: check.parent_tool_call_id }),
      tool: check.tool,
      input: check.input,
    };
    this.#pending.set(requestId, {
      threadId,
      runId,
      extensionRequestId: check.request_id,
      reply,
    });
    if (!this.#deps.send(frame)) {
      this.#pending.delete(requestId);
      reply(localDeny(check.request_id, "Kobe server not reachable"));
    }
  }

  /** `policy.pending`: informational; the extension keeps waiting. */
  onPending(frame: { request_id: string } & Record<string, unknown>): boolean {
    const pending = this.#pending.get(frame.request_id);
    if (pending === undefined) return false;
    pending.reply(this.#relay(frame, pending));
    return true;
  }

  onResult(frame: { request_id: string } & Record<string, unknown>): boolean {
    const pending = this.#pending.get(frame.request_id);
    if (pending === undefined) return false;
    this.#pending.delete(frame.request_id);
    pending.reply(this.#relay(frame, pending));
    return true;
  }

  /** Connection lost: the server may have dropped the checks with it. */
  failAll(message: string): void {
    this.#failWhere(() => true, message);
  }

  failRun(runId: string, message: string): void {
    this.#failWhere((p) => p.runId === runId, message);
  }

  failThread(threadId: string, message: string): void {
    this.#failWhere((p) => p.threadId === threadId, message);
  }

  #failWhere(match: (pending: PendingCheck) => boolean, message: string): void {
    for (const [id, pending] of this.#pending) {
      if (!match(pending)) continue;
      this.#pending.delete(id);
      pending.reply(localDeny(pending.extensionRequestId, message));
    }
  }

  #relay(frame: Record<string, unknown>, pending: PendingCheck): PolicyChannelReply {
    const { v: _v, ...rest } = frame;
    return { ...rest, request_id: pending.extensionRequestId } as PolicyChannelReply;
  }
}
