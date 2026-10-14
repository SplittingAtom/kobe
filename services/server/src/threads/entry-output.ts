import { sql, type KobeTx } from "@kobe/db";
import type { BlobStore } from "../retention/blobs.js";
import { readOffloadedJson, type OffloadedFailure } from "./offloaded-body.js";

/**
 * Large tool outputs in the chat (CE12, KOBE-208). The entry list carries a tool result's output
 * in full only up to {@link OUTPUT_INLINE_MAX_BYTES}; a larger one is trimmed to a preview and
 * flagged `payload_truncated`, and the chat reads it with `GET .../entries/{entryId}/output` when
 * its card opens. The output route answers only what the card shows (text, error flag), whether
 * the entry is stored inline or offloaded to the thread's object tree (D15).
 */
export const OUTPUT_INLINE_MAX_BYTES = 64 * 1024;
/** Characters of a trimmed output the list keeps (shown while the full one loads). */
export const OUTPUT_PREVIEW_CHARS = 2_000;
/** The most text the output route answers; beyond it `truncated` is set. */
export const OUTPUT_TEXT_MAX_CHARS = 1_000_000;
/** Largest offloaded body read back (bytes). */
export const MAX_OUTPUT_BLOB_BYTES = 8 * 1024 * 1024;
/**
 * Offloaded reads per server process: at most this many at once, this many more waiting (each at
 * most this long, else 503), and each read (request and body) bounded in time. No S3 read timeout
 * exists elsewhere to reuse; these keep a stalled store from holding the route for every team.
 */
const BLOB_READS = { max: 4, queueMax: 16, waitMs: 5_000, readMs: 15_000 } as const;

export interface ToolOutput {
  readonly tool_call_id: string;
  readonly tool_name: string;
  readonly is_error: boolean;
  readonly text: string;
  readonly truncated: boolean;
}

const record = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;

/**
 * The first `max` UTF-16 units of `text`, one fewer when that would split a surrogate pair: the
 * one cut used for previews and capped outputs, so an emoji is never halved.
 */
export function cutText(text: string, max: number): string {
  if (text.length <= max) return text;
  const code = text.charCodeAt(max - 1);
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? max - 1 : max);
}

function capped(text: string): { text: string; truncated: boolean } {
  return {
    text: cutText(text, OUTPUT_TEXT_MAX_CHARS),
    truncated: text.length > OUTPUT_TEXT_MAX_CHARS,
  };
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      const p = record(part);
      return p?.type === "text" && typeof p.text === "string" ? p.text : "";
    })
    .join("");
}

/** A tool result's payload with a large output cut to a preview (for the entry list). */
export function trimLargeOutput(payload: unknown): { payload: unknown; truncated: boolean } {
  const message = record(record(payload)?.message);
  if (message?.role !== "toolResult") return { payload, truncated: false };
  const size = Buffer.byteLength(JSON.stringify(message.content ?? null), "utf8");
  if (size <= OUTPUT_INLINE_MAX_BYTES) return { payload, truncated: false };
  const preview = cutText(textOf(message.content), OUTPUT_PREVIEW_CHARS);
  return {
    payload: {
      ...(payload as Record<string, unknown>),
      message: { ...message, content: [{ type: "text", text: preview }] },
    },
    truncated: true,
  };
}

/** The output in a Pi tool result entry, or undefined when it is something else. */
export function toolOutputOf(payload: unknown): ToolOutput | undefined {
  const message = record(record(payload)?.message);
  if (message?.role !== "toolResult" || typeof message.toolCallId !== "string") return undefined;
  return {
    tool_call_id: message.toolCallId,
    tool_name: typeof message.toolName === "string" ? message.toolName : "",
    is_error: message.isError === true,
    ...capped(textOf(message.content)),
  };
}

type Row = {
  blob_ref: string | null;
  role: string | null;
  tool_call_id: string | null;
  tool_name: string | null;
  is_error: boolean | null;
  text: string | null;
};

export type OutputLookup =
  | { readonly kind: "missing" }
  | { readonly kind: "not_a_tool_output" }
  | { readonly kind: "inline"; readonly output: ToolOutput }
  | { readonly kind: "offloaded"; readonly blobRef: string };

/**
 * An entry's tool output as stored inline, extracted in SQL (the payload itself is not loaded),
 * or where its offloaded body is. Every predicate names the team and the thread. SQL's `left`
 * only bounds what is fetched (in code points, enough to tell truncation); the cut itself is
 * `cutText`'s, the same as everywhere else.
 */
export async function findToolOutput(
  tx: KobeTx,
  teamId: string,
  threadId: string,
  entryId: string,
): Promise<OutputLookup> {
  const m = sql`e.payload -> 'message'`;
  const res = await tx.execute<Row>(sql`
    SELECT e.blob_ref,
           ${m} ->> 'role' AS role,
           ${m} ->> 'toolCallId' AS tool_call_id,
           ${m} ->> 'toolName' AS tool_name,
           (${m} -> 'isError') = 'true'::jsonb AS is_error,
           left(CASE jsonb_typeof(${m} -> 'content')
                  WHEN 'string' THEN ${m} ->> 'content'
                  WHEN 'array' THEN (
                    SELECT string_agg(p.part ->> 'text', '' ORDER BY p.n)
                      FROM jsonb_array_elements(${m} -> 'content') WITH ORDINALITY AS p(part, n)
                     WHERE p.part ->> 'type' = 'text')
                END, ${OUTPUT_TEXT_MAX_CHARS + 1}) AS text
      FROM thread_entries e
     WHERE e.team_id = ${teamId} AND e.thread_id = ${threadId} AND e.entry_id = ${entryId}`);
  const row = res.rows[0];
  if (!row) return { kind: "missing" };
  if (row.blob_ref !== null) return { kind: "offloaded", blobRef: row.blob_ref };
  if (row.role !== "toolResult" || row.tool_call_id === null) return { kind: "not_a_tool_output" };
  return {
    kind: "inline",
    output: {
      tool_call_id: row.tool_call_id,
      tool_name: row.tool_name ?? "",
      is_error: row.is_error === true,
      ...capped(row.text ?? ""),
    },
  };
}

export type Limited<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: "busy" | "aborted" };

interface Waiter {
  readonly start: () => void;
}

/**
 * A per-process limit on concurrent reads. A finished read hands its slot to the next waiter; the
 * queue is bounded and each wait is timed (both answer `busy`); a waiter whose request is aborted
 * leaves the queue and never takes a slot.
 */
export function createReadLimiter(opts: {
  readonly max: number;
  readonly queueMax: number;
  readonly waitMs: number;
}) {
  let active = 0;
  const waiting: Waiter[] = [];
  const release = () => {
    const next = waiting.shift();
    if (next) next.start();
    else active -= 1;
  };
  const turn = (signal?: AbortSignal) =>
    new Promise<"go" | "busy" | "aborted">((resolve) => {
      if (signal?.aborted) return resolve("aborted");
      if (active < opts.max) {
        active += 1;
        return resolve("go");
      }
      if (waiting.length >= opts.queueMax) return resolve("busy");
      const leave = (reason: "busy" | "aborted") => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        const i = waiting.indexOf(waiter);
        if (i !== -1) waiting.splice(i, 1);
        resolve(reason);
      };
      const onAbort = () => leave("aborted");
      const waiter: Waiter = {
        start: () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          resolve("go");
        },
      };
      const timer = setTimeout(() => leave("busy"), opts.waitMs);
      signal?.addEventListener("abort", onAbort, { once: true });
      waiting.push(waiter);
    });
  return async <T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<Limited<T>> => {
    const go = await turn(signal);
    if (go !== "go") return { ok: false, reason: go };
    try {
      return { ok: true, value: await fn() };
    } finally {
      release();
    }
  };
}

export type OffloadedOutput = ToolOutput | OffloadedFailure | "not_a_tool_output" | "busy";

/** Reads offloaded tool outputs within {@link createReadLimiter}'s bounds and a time limit each. */
export function createOutputReader(opts: {
  readonly max: number;
  readonly queueMax: number;
  readonly waitMs: number;
  readonly readMs: number;
}) {
  const run = createReadLimiter(opts);
  return async (
    blobs: BlobStore | undefined,
    ids: { readonly teamId: string; readonly threadId: string; readonly entryId: string },
    key: string,
    signal?: AbortSignal,
  ): Promise<OffloadedOutput> => {
    const read = await run(() => {
      const bound = AbortSignal.timeout(opts.readMs);
      const both = signal ? AbortSignal.any([signal, bound]) : bound;
      return readOffloadedJson(
        blobs,
        { ...ids, reader: "tool output" },
        key,
        MAX_OUTPUT_BLOB_BYTES,
        both,
      );
    }, signal);
    if (!read.ok) return read.reason;
    if (!read.value.ok) return read.value.reason;
    return toolOutputOf(read.value.body) ?? "not_a_tool_output";
  };
}

/** An offloaded tool output, read with the cap, the per-process limits and a time limit. */
export const readOffloadedOutput = createOutputReader(BLOB_READS);
