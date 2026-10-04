import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Duplex } from "node:stream";
import { idSchema, parseJsonStrict, toolInputSchema } from "@kobe/protocol";
import { z } from "zod";
import { LineSplitter, encodeJsonl } from "../jsonl.js";
import {
  CHANNEL_VERSION,
  EXTENSION_NAME,
  MSG_CANCEL,
  MSG_CHECK,
  MSG_HELLO,
  MSG_READY,
  MSG_REFUSED,
  MAX_REQUEST_LINE_BYTES,
} from "../kobe-policy/protocol.js";

/**
 * Sandbox-local channel between the kobe-policy Pi extension (KOBE-36) and kobe-sandbox-agent.
 *
 * Transport: fd 3 of each `pi --mode rpc` process (`KOBE_POLICY_FD=3` in Pi's env) is one end of a
 * socket pair the agent created when it spawned Pi. Nothing listens. Pi spawns its tools with
 * explicit stdio pipes, and Node/libuv does not pass fd 3 on to them (verified on Linux with Node
 * 22 and on macOS, `agent.runs.test.ts` "grandchild"); a socket cannot be re-opened through
 * `/proc/<pi>/fd/3` either. That is an observation about Pi's spawn path, not a boundary: a tool
 * has its Pi's uid (each Pi its own, KOBE-71), so the nonce below still matters; it cannot ptrace
 * its Pi (an ancestor; Yama scope 1, gVisor included) nor reach another thread's. JSONL, LF-split.
 *
 * Handshake: the agent's first line is `{"type":"channel.hello","nonce"}` (random per spawn);
 * kobe-policy reads it at load, before any tool can run, and puts `nonce` in every request. A request
 * with a wrong or missing nonce closes the channel (all pending checks of the thread are denied).
 * Once loaded and self-checked (last extension, `--no-extensions`), kobe-policy answers
 * `{"type":"channel.ready","nonce","extension":"kobe-policy","version":1}` — the agent starts no
 * run on a Pi that has not (KOBE-36), so a Pi without a working kobe-policy never runs a prompt — or
 * `{"type":"channel.refused","nonce","reason"}`, which closes the channel. Message shapes and limits
 * shared with the extension live in `kobe-policy/protocol.ts`.
 *
 * extension → agent: `{"type":"policy.check","nonce","request_id","tool_call_id",
 *   "parent_tool_call_id"?,"tool","input"}` — the agent adds `run_id` / `thread_id` itself (the
 *   extension cannot name another thread's run), forwards a `policy.check` frame and relays the
 *   server's answer.
 * agent → extension: the server's `policy.pending` / `policy.result` with the extension's
 *   `request_id` (`v` and any `approval` token removed: the token is a server-to-proxy matter and
 *   never needs to cross a channel tool code might reach), or a sandbox-local
 *   `{"type":"policy.result","request_id","decision":"deny","reasons":[],"message"}` when the agent
 *   cannot ask. Fail closed: the extension blocks the call on deny, on channel close, and on its own
 *   timeout.
 *
 * Limits: one request line ≤ the wire frame cap (a `write` tool input can legitimately be large, and
 * it must fit one `policy.check` frame anyway); ≤ {@link POLICY_CHANNEL_RATE} requests per second
 * (burst {@link POLICY_CHANNEL_BURST}, excess denied); replies buffered towards a reader that does
 * not read are capped ({@link POLICY_CHANNEL_MAX_WRITE_BUFFER}, then the channel is closed).
 */
export const POLICY_CHANNEL_MAX_LINE_BYTES = MAX_REQUEST_LINE_BYTES;
export const POLICY_CHANNEL_MAX_WRITE_BUFFER = 1024 * 1024;
export const POLICY_CHANNEL_RATE = 20;
export const POLICY_CHANNEL_BURST = 50;

export const policyChannelCheckSchema = z.strictObject({
  type: z.literal(MSG_CHECK),
  nonce: z.string().min(1).max(128),
  request_id: idSchema,
  tool_call_id: idSchema,
  parent_tool_call_id: idSchema.optional(),
  tool: z.string().min(1).max(256),
  input: toolInputSchema,
});
export type PolicyChannelCheck = z.infer<typeof policyChannelCheckSchema>;

export type PolicyChannelReply = Record<string, unknown> & {
  readonly type: "policy.result" | "policy.pending";
  readonly request_id: string;
};

export function localDeny(requestId: string, message: string): PolicyChannelReply {
  return { type: "policy.result", request_id: requestId, decision: "deny", reasons: [], message };
}

export interface PolicyChannelHandlers {
  readonly onCheck: (check: PolicyChannelCheck) => void;
  /** The extension stopped waiting for this request (its timeout, or Stop). */
  readonly onCancel?: (requestId: string) => void;
  /** The channel is unusable (bad nonce, unread replies, closed): deny everything pending. */
  readonly onClosed: (reason: string) => void;
  readonly onDiagnostic?: (message: string) => void;
  readonly now?: () => number;
}

const readySchema = z.strictObject({
  type: z.literal(MSG_READY),
  nonce: z.string(),
  extension: z.literal(EXTENSION_NAME),
  version: z.literal(CHANNEL_VERSION),
});
const refusedSchema = z.strictObject({
  type: z.literal(MSG_REFUSED),
  nonce: z.string(),
  reason: z.string().max(1000),
});

export class PolicyChannel {
  readonly #stream: Duplex;
  readonly #nonce = randomBytes(24).toString("base64url");
  readonly #handlers: PolicyChannelHandlers;
  #tokens = POLICY_CHANNEL_BURST;
  #refilledAt: number;
  #closed = false;
  #closeReason = "policy channel closed";
  #ready = false;
  readonly #readyWaiters = new Set<{ resolve: () => void; reject: (error: Error) => void }>();

  constructor(stream: Duplex, handlers: PolicyChannelHandlers) {
    this.#stream = stream;
    this.#handlers = handlers;
    this.#refilledAt = this.#now();
    const splitter = new LineSplitter({
      maxLineBytes: POLICY_CHANNEL_MAX_LINE_BYTES,
      onLine: (line) => this.#onLine(line),
      onOversize: () => handlers.onDiagnostic?.("oversize policy request dropped"),
    });
    stream.on("data", (chunk: Buffer) => {
      if (!this.#closed) splitter.push(chunk);
    });
    stream.on("error", () => undefined);
    stream.on("close", () => this.close("policy channel closed"));
    this.#write({ type: MSG_HELLO, nonce: this.#nonce });
  }

  get closed(): boolean {
    return this.#closed;
  }

  get ready(): boolean {
    return this.#ready;
  }

  /**
   * Resolves once kobe-policy reported `channel.ready`; rejects when it refused, the channel closed,
   * or `timeoutMs` passed first.
   */
  waitReady(timeoutMs: number): Promise<void> {
    if (this.#ready) return Promise.resolve();
    if (this.#closed) return Promise.reject(new Error(this.#closeReason));
    return new Promise<void>((resolve, reject) => {
      const waiter = {
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (error: Error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
      const timer = setTimeout(() => {
        this.#readyWaiters.delete(waiter);
        reject(new Error("kobe-policy extension did not report ready"));
      }, timeoutMs);
      this.#readyWaiters.add(waiter);
    });
  }

  reply(message: PolicyChannelReply): void {
    const { approval: _approval, ...safe } = message;
    this.#write(safe);
  }

  close(reason: string): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#closeReason = reason;
    this.#stream.destroy();
    for (const waiter of this.#readyWaiters) waiter.reject(new Error(reason));
    this.#readyWaiters.clear();
    this.#handlers.onClosed(reason);
  }

  #write(message: Record<string, unknown>): void {
    if (this.#closed || this.#stream.destroyed || !this.#stream.writable) return;
    if (this.#stream.writableLength > POLICY_CHANNEL_MAX_WRITE_BUFFER) {
      this.close("policy channel reader is not reading");
      return;
    }
    this.#stream.write(encodeJsonl(message));
  }

  #now(): number {
    return this.#handlers.now?.() ?? Date.now();
  }

  #takeToken(): boolean {
    const now = this.#now();
    const refill = ((now - this.#refilledAt) / 1000) * POLICY_CHANNEL_RATE;
    this.#tokens = Math.min(POLICY_CHANNEL_BURST, this.#tokens + refill);
    this.#refilledAt = now;
    if (this.#tokens < 1) return false;
    this.#tokens -= 1;
    return true;
  }

  #nonceMatches(candidate: unknown): boolean {
    if (typeof candidate !== "string") return false;
    const a = Buffer.from(candidate);
    const b = Buffer.from(this.#nonce);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  #onLine(line: string): void {
    if (this.#closed) return;
    const strict = parseJsonStrict(line);
    const value = strict.ok ? strict.value : undefined;
    if (!this.#nonceMatches((value as { nonce?: unknown } | undefined)?.nonce)) {
      this.close("policy request without the channel nonce");
      return;
    }
    const type = (value as { type?: unknown }).type;
    if (type === MSG_READY || type === MSG_REFUSED) {
      this.#onLifecycle(value);
      return;
    }
    const requestId = extractRequestId(value);
    if (type === MSG_CANCEL) {
      // Frees a slot rather than taking one, so it spends no rate tokens.
      if (this.#ready && requestId !== undefined) this.#handlers.onCancel?.(requestId);
      return;
    }
    if (!this.#ready) {
      if (requestId !== undefined) this.reply(localDeny(requestId, "kobe-policy is not ready"));
      return;
    }
    if (!this.#takeToken()) {
      if (requestId !== undefined) this.reply(localDeny(requestId, "policy requests rate-limited"));
      return;
    }
    const parsed = policyChannelCheckSchema.safeParse(value);
    if (parsed.success) {
      this.#handlers.onCheck(parsed.data);
      return;
    }
    // Answer what we can identify so the extension never waits on a malformed request.
    if (requestId !== undefined) this.reply(localDeny(requestId, "malformed policy request"));
    this.#handlers.onDiagnostic?.("malformed policy request");
  }

  #onLifecycle(value: unknown): void {
    const refused = refusedSchema.safeParse(value);
    if (refused.success) {
      this.close(`kobe-policy refused to start: ${refused.data.reason}`);
      return;
    }
    if (this.#ready || !readySchema.safeParse(value).success) {
      this.close("unexpected policy channel message");
      return;
    }
    this.#ready = true;
    for (const waiter of this.#readyWaiters) waiter.resolve();
    this.#readyWaiters.clear();
  }
}

function extractRequestId(value: unknown): string | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const id = (value as { request_id?: unknown }).request_id;
  return idSchema.safeParse(id).success ? (id as string) : undefined;
}
