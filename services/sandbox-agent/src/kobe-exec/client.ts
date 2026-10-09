import type { Duplex } from "node:stream";
import { LineReader } from "./lines.js";
import {
  MAX_PENDING_REQUESTS,
  MAX_REPLY_LINE_BYTES,
  OP_CANCEL,
  isRecord,
  parseReply,
  type ExecError,
} from "./protocol.js";

/** What a request ends with: its final frame's fields, or an error. Never rejects. */
export type Outcome =
  | { readonly ok: true; readonly fields: Readonly<Record<string, unknown>> }
  | { readonly ok: false; readonly error: ExecError };

export interface RequestHooks {
  /** A chunk of an `exec` request's output, as it arrives. */
  readonly onStream?: (stream: "stdout" | "stderr", data: Buffer) => void;
  /** Aborting sends a cancel; the request still ends with the executor's answer. */
  readonly signal?: AbortSignal | undefined;
}

/** What the tools need of the channel (the real one is {@link ExecClient}). */
export interface ExecTransport {
  request(body: { readonly op: string } & Record<string, unknown>, hooks?: RequestHooks): Promise<Outcome>;
}

export interface ExecClientOptions {
  /** Longest a request that is not a command may wait for its answer. */
  readonly timeoutMs?: number;
  /** After a cancel, how long to wait for the executor's answer before giving up on it. */
  readonly cancelGraceMs?: number;
}

export const FILE_OP_TIMEOUT_MS = 120_000;
export const CANCEL_GRACE_MS = 5_000;

interface Pending {
  readonly onStream: RequestHooks["onStream"];
  readonly resolve: (outcome: Outcome) => void;
  readonly timers: Set<NodeJS.Timeout>;
  readonly detach: () => void;
}

export function failure(code: string, message: string): Outcome {
  return { ok: false, error: { code, message } };
}

/** A transport that fails every request: used when the channel could not be opened. */
export function unavailableTransport(reason: string): ExecTransport {
  return {
    request: () => Promise.resolve(failure("unavailable", reason)),
  };
}

/**
 * Client end of the exec channel (fd 5). Fail closed: every way a request cannot be answered
 * (channel closed, oversize or malformed reply, timeout, too many in flight) is an error outcome,
 * never a retry elsewhere. Resolves, never rejects.
 */
export class ExecClient implements ExecTransport {
  readonly #stream: Duplex;
  readonly #options: ExecClientOptions;
  readonly #pending = new Map<string, Pending>();
  #closedReason: string | undefined;
  #next = 1;

  constructor(stream: Duplex, options: ExecClientOptions = {}) {
    this.#stream = stream;
    this.#options = options;
    const reader = new LineReader(
      MAX_REPLY_LINE_BYTES,
      (line) => this.#onLine(line),
      () => this.#close("oversize reply on the kobe-exec channel"),
    );
    stream.on("data", (chunk: Buffer) => reader.push(chunk));
    stream.on("error", () => this.#close("kobe-exec channel error"));
    stream.on("close", () => this.#close("kobe-exec channel closed"));
  }

  get closed(): boolean {
    return this.#closedReason !== undefined;
  }

  request(
    body: { readonly op: string } & Record<string, unknown>,
    hooks: RequestHooks = {},
  ): Promise<Outcome> {
    if (this.#closedReason !== undefined) return Promise.resolve(failure("unavailable", this.#closedReason));
    if (this.#pending.size >= MAX_PENDING_REQUESTS) {
      return Promise.resolve(failure("unavailable", "too many requests in flight"));
    }
    if (hooks.signal?.aborted === true) return Promise.resolve(failure("aborted", "aborted"));
    const id = `ke_${this.#next++}`;
    return new Promise<Outcome>((resolve) => {
      const timers = new Set<NodeJS.Timeout>();
      const onAbort = () => this.#cancel(id);
      hooks.signal?.addEventListener("abort", onAbort, { once: true });
      const pending: Pending = {
        onStream: hooks.onStream,
        resolve,
        timers,
        detach: () => {
          hooks.signal?.removeEventListener("abort", onAbort);
          for (const timer of timers) clearTimeout(timer);
        },
      };
      this.#pending.set(id, pending);
      if (body.op !== "exec") {
        const ms = this.#options.timeoutMs ?? FILE_OP_TIMEOUT_MS;
        timers.add(
          setTimeout(() => this.#settle(id, failure("timeout", `no answer within ${ms / 1000} s`)), ms),
        );
      }
      this.#send({ id, ...body }, () => this.#settle(id, failure("unavailable", "cannot write to the kobe-exec channel")));
    });
  }

  #send(frame: Record<string, unknown>, onError: () => void): void {
    this.#stream.write(`${JSON.stringify(frame)}\n`, (error) => {
      if (error) {
        onError();
        this.#close("cannot write to the kobe-exec channel");
      }
    });
  }

  #cancel(target: string): void {
    const pending = this.#pending.get(target);
    if (pending === undefined || this.#closedReason !== undefined) return;
    this.#send({ id: `ke_${this.#next++}`, op: OP_CANCEL, target }, () => undefined);
    const grace = this.#options.cancelGraceMs ?? CANCEL_GRACE_MS;
    pending.timers.add(setTimeout(() => this.#settle(target, failure("aborted", "aborted")), grace));
  }

  #settle(id: string, outcome: Outcome): void {
    const pending = this.#pending.get(id);
    if (pending === undefined) return;
    this.#pending.delete(id);
    pending.detach();
    pending.resolve(outcome);
  }

  #onLine(line: string): void {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      this.#close("malformed reply on the kobe-exec channel");
      return;
    }
    const reply = parseReply(value);
    if (reply === undefined) {
      this.#close("malformed reply on the kobe-exec channel");
      return;
    }
    const pending = this.#pending.get(reply.id);
    if (pending === undefined) return; // late (settled already) or unknown: dropped
    const raw = reply.raw;
    if (!reply.final) {
      const { stream, data } = raw;
      if ((stream === "stdout" || stream === "stderr") && typeof data === "string") {
        pending.onStream?.(stream, Buffer.from(data, "base64"));
      }
      return;
    }
    if (raw.ok === true) {
      const { id: _id, ok: _ok, ...fields } = raw;
      this.#settle(reply.id, { ok: true, fields });
      return;
    }
    const error = raw.error;
    if (!isRecord(error) || typeof error.code !== "string" || typeof error.message !== "string") {
      this.#close("malformed reply on the kobe-exec channel");
      return;
    }
    this.#settle(reply.id, failure(error.code, error.message));
  }

  #close(reason: string): void {
    if (this.#closedReason !== undefined) return;
    this.#closedReason = reason;
    this.#stream.destroy();
    for (const id of [...this.#pending.keys()]) this.#settle(id, failure("unavailable", reason));
  }
}
