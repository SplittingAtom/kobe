import type { Duplex } from "node:stream";
import { LineReader } from "./lines.js";
import {
  CHANNEL_VERSION,
  EXTENSION_NAME,
  FIRST_REPLY_TIMEOUT_MS,
  HELLO_TIMEOUT_MS,
  MAX_PENDING_CHECKS,
  MAX_PENDING_WAIT_MS,
  MAX_REPLY_LINE_BYTES,
  MAX_REQUEST_LINE_BYTES,
  MAX_TRACKED_TOOL_CALL_IDS,
  MSG_CANCEL,
  MSG_CHECK,
  MSG_HELLO,
  MSG_PENDING,
  MSG_READY,
  MSG_REFUSED,
  MSG_RESULT,
  PENDING_GRACE_MS,
} from "./protocol.js";
import { stableJson } from "./plain-json.js";

/**
 * The extension's end of the fd-3 policy channel. Fail closed throughout: every outcome other than
 * an `allow` result for this exact tool call is a block, and a channel that misbehaves once (bad
 * line, second hello, oversize reply, close) stays closed for the life of the Pi process.
 *
 * The nonce lives only in this object (never in the environment or on a global), so tools Pi runs
 * cannot learn it.
 */
export type Verdict = { readonly allow: true } | { readonly allow: false; readonly reason: string };

export interface CheckRequest {
  readonly toolCallId: string;
  readonly parentToolCallId?: string | undefined;
  readonly tool: string;
  readonly input: Record<string, unknown>;
  /** `stableJson(input)` when the caller already has it (the handler's fingerprint). */
  readonly inputJson?: string;
  readonly signal?: AbortSignal | undefined;
}

export interface PolicyClientOptions {
  readonly helloTimeoutMs?: number;
  readonly firstReplyTimeoutMs?: number;
  readonly now?: () => number;
}

export type ClientState = "connecting" | "handshaken" | "ready" | "closed";

interface Pending {
  readonly toolCallId: string;
  readonly settle: (verdict: Verdict) => void;
  timer: NodeJS.Timeout;
  timeoutReason: string;
  /** Set by the first `policy.pending`: no later one can push the wait past it. */
  pendingDeadline?: number;
}

const deny = (reason: string): Verdict => ({ allow: false, reason });
const MAX_MESSAGE_LENGTH = 2000;

export class PolicyClient {
  readonly #stream: Duplex;
  readonly #options: PolicyClientOptions;
  readonly #pending = new Map<string, Pending>();
  /** Every tool call id asked about in this Pi process: each call is checked at most once. */
  readonly #seenToolCallIds = new Set<string>();
  #state: ClientState = "connecting";
  #nonce: string | undefined;
  #closeReason = "policy channel closed";
  #next = 1;
  #handshake: { resolve: () => void; reject: (error: Error) => void } | undefined;

  constructor(stream: Duplex, options: PolicyClientOptions = {}) {
    this.#stream = stream;
    this.#options = options;
    const reader = new LineReader(
      MAX_REPLY_LINE_BYTES,
      (line) => this.#onLine(line),
      () => this.close("oversize reply on the policy channel"),
    );
    stream.on("data", (chunk: Buffer) => {
      if (this.#state !== "closed") reader.push(chunk);
    });
    stream.on("error", () => this.close("policy channel error"));
    stream.on("end", () => this.close("policy channel closed"));
    stream.on("close", () => this.close("policy channel closed"));
  }

  get state(): ClientState {
    return this.#state;
  }

  /** Resolves once `channel.hello` arrived; rejects (and closes) on anything else. */
  handshake(): Promise<void> {
    if (this.#state === "closed") return Promise.reject(new Error(this.#closeReason));
    if (this.#state !== "connecting") return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => this.close("timed out waiting for channel.hello"),
        this.#options.helloTimeoutMs ?? HELLO_TIMEOUT_MS,
      );
      this.#handshake = {
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
    });
  }

  /** Tell the agent the extension loaded and passed its self-checks; checks may follow. */
  ready(): void {
    if (this.#state !== "handshaken") return;
    this.#write({
      type: MSG_READY,
      nonce: this.#nonce,
      extension: EXTENSION_NAME,
      version: CHANNEL_VERSION,
    });
    this.#state = "ready";
  }

  /** Tell the agent why this extension will not serve, then close: every call is blocked. */
  refuse(reason: string): void {
    if (this.#state === "handshaken")
      this.#write({ type: MSG_REFUSED, nonce: this.#nonce, reason });
    this.close(`kobe-policy refused to start: ${reason}`);
  }

  check(request: CheckRequest): Promise<Verdict> {
    if (this.#state !== "ready") return Promise.resolve(deny(this.#unavailableReason()));
    if (this.#seenToolCallIds.has(request.toolCallId)) {
      return Promise.resolve(deny("this tool call id was already checked in this session"));
    }
    if (this.#seenToolCallIds.size >= MAX_TRACKED_TOOL_CALL_IDS) {
      return Promise.resolve(deny("too many tool calls in this Pi process"));
    }
    this.#seenToolCallIds.add(request.toolCallId);
    if (request.signal?.aborted === true) return Promise.resolve(deny("the run was stopped"));
    if (this.#pending.size >= MAX_PENDING_CHECKS) {
      return Promise.resolve(deny("too many policy checks in flight"));
    }
    const requestId = `kp_${this.#next++}`;
    const line = this.#checkLine(requestId, request);
    if (Buffer.byteLength(line) > MAX_REQUEST_LINE_BYTES) {
      return Promise.resolve(deny("tool input too large for a policy check"));
    }
    return new Promise<Verdict>((resolve) => {
      const onAbort = (): void => this.#giveUp(requestId, "the run was stopped");
      const pending: Pending = {
        toolCallId: request.toolCallId,
        settle: (verdict) => {
          clearTimeout(pending.timer);
          request.signal?.removeEventListener("abort", onAbort);
          resolve(verdict);
        },
        timer: this.#timer(requestId, this.#options.firstReplyTimeoutMs ?? FIRST_REPLY_TIMEOUT_MS),
        timeoutReason: "policy check timed out",
      };
      this.#pending.set(requestId, pending);
      request.signal?.addEventListener("abort", onAbort, { once: true });
      this.#stream.write(line);
    });
  }

  /**
   * The request line, built by hand from own data: `JSON.stringify` of an object would consult
   * `toJSON` (also an inherited one), so what the agent receives could differ from what runs.
   */
  #checkLine(requestId: string, request: CheckRequest): string {
    const str = (value: string): string => JSON.stringify(value);
    const parent =
      request.parentToolCallId === undefined
        ? ""
        : `,"parent_tool_call_id":${str(request.parentToolCallId)}`;
    const input = request.inputJson ?? stableJson(request.input);
    return (
      `{"type":${str(MSG_CHECK)},"nonce":${str(this.#nonce as string)},` +
      `"request_id":${str(requestId)},"tool_call_id":${str(request.toolCallId)}${parent},` +
      `"tool":${str(request.tool)},"input":${input}}\n`
    );
  }

  /** Stop waiting (timeout, Stop): block, and tell the agent so it frees its pending slot. */
  #giveUp(requestId: string, reason: string): void {
    if (!this.#pending.has(requestId)) return;
    this.#settle(requestId, deny(reason));
    if (this.#state === "ready") {
      this.#write({ type: MSG_CANCEL, nonce: this.#nonce, request_id: requestId });
    }
  }

  close(reason: string): void {
    if (this.#state === "closed") return;
    this.#state = "closed";
    this.#closeReason = reason;
    this.#handshake?.reject(new Error(reason));
    this.#handshake = undefined;
    for (const id of [...this.#pending.keys()]) this.#settle(id, deny(reason));
    this.#stream.destroy();
  }

  #unavailableReason(): string {
    if (this.#state === "closed") return this.#closeReason;
    return "kobe-policy is not ready";
  }

  #timer(requestId: string, ms: number): NodeJS.Timeout {
    return setTimeout(() => {
      const reason = this.#pending.get(requestId)?.timeoutReason ?? "policy check timed out";
      this.#giveUp(requestId, reason);
    }, ms);
  }

  #settle(requestId: string, verdict: Verdict): void {
    const pending = this.#pending.get(requestId);
    if (pending === undefined) return;
    this.#pending.delete(requestId);
    pending.settle(verdict);
  }

  #write(message: Record<string, unknown>): void {
    if (this.#stream.destroyed || !this.#stream.writable) return;
    this.#stream.write(`${JSON.stringify(message)}\n`);
  }

  #onLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      this.close("malformed line on the policy channel");
      return;
    }
    if (message === null || typeof message !== "object" || Array.isArray(message)) {
      this.close("malformed line on the policy channel");
      return;
    }
    const record = message as Record<string, unknown>;
    if (record.type === MSG_HELLO) {
      this.#onHello(record);
      return;
    }
    if (this.#state === "connecting") {
      this.close("expected channel.hello as the first line");
      return;
    }
    if (record.type === MSG_PENDING) this.#onPending(record);
    else if (record.type === MSG_RESULT) this.#onResult(record);
  }

  #onHello(record: Record<string, unknown>): void {
    if (this.#state !== "connecting") {
      this.close("unexpected second channel.hello");
      return;
    }
    const nonce = record.nonce;
    if (typeof nonce !== "string" || nonce.length === 0 || nonce.length > 128) {
      this.close("channel.hello without a valid nonce");
      return;
    }
    this.#nonce = nonce;
    this.#state = "handshaken";
    this.#handshake?.resolve();
    this.#handshake = undefined;
  }

  #onPending(record: Record<string, unknown>): void {
    const requestId = record.request_id;
    if (typeof requestId !== "string") return;
    const pending = this.#pending.get(requestId);
    if (pending === undefined) return;
    if (record.tool_call_id !== undefined && record.tool_call_id !== pending.toolCallId) {
      this.#settle(requestId, deny("policy answer was for another tool call"));
      return;
    }
    clearTimeout(pending.timer);
    const now = this.#options.now?.() ?? Date.now();
    pending.pendingDeadline ??= now + MAX_PENDING_WAIT_MS;
    pending.timeoutReason = "the approval expired before a decision arrived";
    pending.timer = this.#timer(
      requestId,
      Math.min(pendingWaitMs(record.expires_at, now), pending.pendingDeadline - now),
    );
  }

  #onResult(record: Record<string, unknown>): void {
    const requestId = record.request_id;
    if (typeof requestId !== "string") return;
    const pending = this.#pending.get(requestId);
    if (pending === undefined) return;
    this.#settle(requestId, verdictOf(record, pending.toolCallId));
  }
}

/** Until `expires_at` plus grace, at most {@link MAX_PENDING_WAIT_MS}; unparsable → the maximum. */
function pendingWaitMs(expiresAt: unknown, now: number): number {
  const expiry = typeof expiresAt === "string" ? Date.parse(expiresAt) : Number.NaN;
  if (Number.isNaN(expiry)) return MAX_PENDING_WAIT_MS;
  return Math.min(MAX_PENDING_WAIT_MS, Math.max(0, expiry - now) + PENDING_GRACE_MS);
}

function verdictOf(record: Record<string, unknown>, toolCallId: string): Verdict {
  if (record.decision === "allow") {
    return record.tool_call_id === toolCallId
      ? { allow: true }
      : deny("policy answer was for another tool call");
  }
  if (record.decision === "deny") {
    const message = typeof record.message === "string" ? record.message.trim() : "";
    return deny(message === "" ? "denied by Kobe policy" : message.slice(0, MAX_MESSAGE_LENGTH));
  }
  return deny("malformed policy answer");
}
