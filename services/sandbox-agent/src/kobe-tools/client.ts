import type { Duplex } from "node:stream";
import { LineReader } from "./lines.js";
import { parseMemoryReply } from "./memory-reply.js";
import { parseProjectReply } from "./project-reply.js";
import {
  MAX_PENDING_REQUESTS,
  MAX_REPLY_LINE_BYTES,
  TOOLS_TIMEOUT_MS,
  type MemoryPutAnswer,
  type MemoryReadAnswer,
  type SharedFileFields,
  type ToolsError,
  type ToolsRequest,
  type ToolsResponse,
  type WebSearchAnswer,
  type ProjectProposeAnswer,
  type WebSearchUnavailable,
} from "./protocol.js";

export type ToolsOutcome =
  | WebSearchAnswer
  | WebSearchUnavailable
  | MemoryPutAnswer
  | MemoryReadAnswer
  | ProjectProposeAnswer
  | { readonly ok: true; readonly artifact_id: string; readonly version: number }
  | ({ readonly ok: true } & SharedFileFields)
  | { readonly ok: false; readonly error: ToolsError };

export interface ToolsClientOptions {
  readonly timeoutMs?: number;
}

interface Pending {
  readonly resolve: (outcome: ToolsOutcome) => void;
  readonly timer: NodeJS.Timeout;
}

/**
 * Client end of the kobe-tools channel. Fail closed: every way a request cannot be answered
 * (channel closed, oversize or malformed reply, timeout, too many in flight) is an error outcome,
 * never a retry elsewhere. Resolves, never rejects.
 */
export class ToolsClient {
  readonly #stream: Duplex;
  readonly #timeoutMs: number;
  readonly #pending = new Map<string, Pending>();
  #closedReason: string | undefined;
  #next = 1;

  constructor(stream: Duplex, options: ToolsClientOptions = {}) {
    this.#stream = stream;
    this.#timeoutMs = options.timeoutMs ?? TOOLS_TIMEOUT_MS;
    const reader = new LineReader(
      MAX_REPLY_LINE_BYTES,
      (line) => this.#onLine(line),
      () => this.#close("oversize reply on the kobe-tools channel"),
    );
    stream.on("data", (chunk: Buffer) => reader.push(chunk));
    stream.on("error", () => this.#close("kobe-tools channel error"));
    stream.on("close", () => this.#close("kobe-tools channel closed"));
  }

  get closed(): boolean {
    return this.#closedReason !== undefined;
  }

  request(call: Omit<ToolsRequest, "id">): Promise<ToolsOutcome> {
    if (this.#closedReason !== undefined)
      return Promise.resolve(failure("unavailable", this.#closedReason));
    if (this.#pending.size >= MAX_PENDING_REQUESTS) {
      return Promise.resolve(failure("unavailable", "too many requests in flight"));
    }
    const id = `kt_${this.#next++}`;
    const line = `${JSON.stringify({ id, ...call })}\n`;
    return new Promise<ToolsOutcome>((resolve) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        resolve(failure("timeout", `no answer within ${this.#timeoutMs / 1000} s`));
      }, this.#timeoutMs);
      this.#pending.set(id, { resolve, timer });
      this.#stream.write(line, (error) => {
        if (error) this.#close("cannot write to the kobe-tools channel");
      });
    });
  }

  #onLine(line: string): void {
    const response = parseResponse(line);
    if (response === undefined) {
      this.#close("malformed reply on the kobe-tools channel");
      return;
    }
    const pending = this.#pending.get(response.id);
    if (pending === undefined) return; // late (timed out) or unknown: dropped
    this.#pending.delete(response.id);
    clearTimeout(pending.timer);
    const { id: _id, ...outcome } = response;
    pending.resolve(outcome);
  }

  #close(reason: string): void {
    if (this.#closedReason !== undefined) return;
    this.#closedReason = reason;
    this.#stream.destroy();
    for (const [id, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.resolve(failure("unavailable", reason));
      this.#pending.delete(id);
    }
  }
}

function failure(code: string, message: string): ToolsOutcome {
  return { ok: false, error: { code, message } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseResponse(line: string): ToolsResponse | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isRecord(value) || typeof value.id !== "string") return undefined;
  if (value.ok === true && "file_id" in value) return parseFileReply(value);
  if (value.ok === true && value.op === "project_file_propose") return parseProjectReply(value);
  if (value.ok === true && "op" in value) return parseMemoryReply(value);
  if (value.ok === true && "available" in value) return parseWebSearchReply(value);
  if (value.ok === true) {
    if (typeof value.artifact_id !== "string" || !Number.isSafeInteger(value.version))
      return undefined;
    return {
      id: value.id,
      ok: true,
      artifact_id: value.artifact_id,
      version: value.version as number,
    };
  }
  const error = value.error;
  if (value.ok !== false || !isRecord(error)) return undefined;
  if (typeof error.code !== "string" || typeof error.message !== "string") return undefined;
  return { id: value.id, ok: false, error: { code: error.code, message: error.message } };
}

const FILE_STRINGS = ["file_id", "name", "mime_type", "scan", "created_at", "sha256"] as const;

function parseFileReply(value: Record<string, unknown>): ToolsResponse | undefined {
  for (const key of FILE_STRINGS) if (typeof value[key] !== "string") return undefined;
  if (!Number.isSafeInteger(value.size_bytes)) return undefined;
  return {
    id: value.id as string,
    ok: true,
    file_id: value.file_id as string,
    name: value.name as string,
    mime_type: value.mime_type as string,
    size_bytes: value.size_bytes as number,
    scan: value.scan as string,
    created_at: value.created_at as string,
    sha256: value.sha256 as string,
  };
}

function parseWebSearchReply(value: Record<string, unknown>): ToolsResponse | undefined {
  const id = value.id as string;
  if (value.available === false) {
    if (typeof value.reason !== "string" || typeof value.message !== "string") return undefined;
    return { id, ok: true, available: false, reason: value.reason, message: value.message };
  }
  if (value.available !== true || typeof value.provider !== "string") return undefined;
  if (typeof value.query !== "string" || !Array.isArray(value.results)) return undefined;
  const results = [];
  for (const item of value.results as unknown[]) {
    if (!isRecord(item)) return undefined;
    const { title, url, snippet } = item;
    if (typeof title !== "string" || typeof url !== "string" || typeof snippet !== "string") {
      return undefined;
    }
    results.push({ title, url, snippet });
  }
  return { id, ok: true, available: true, provider: value.provider, query: value.query, results };
}
