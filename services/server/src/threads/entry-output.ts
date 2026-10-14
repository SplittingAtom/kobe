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
/** Offloaded bodies read at once per server process; more wait their turn. */
const BLOB_READS_AT_ONCE = 4;

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
  const preview = textOf(message.content).slice(0, OUTPUT_PREVIEW_CHARS);
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
  const text = textOf(message.content);
  return {
    tool_call_id: message.toolCallId,
    tool_name: typeof message.toolName === "string" ? message.toolName : "",
    is_error: message.isError === true,
    text: text.slice(0, OUTPUT_TEXT_MAX_CHARS),
    truncated: text.length > OUTPUT_TEXT_MAX_CHARS,
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
 * or where its offloaded body is. Every predicate names the team and the thread.
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
  const text = row.text ?? "";
  return {
    kind: "inline",
    output: {
      tool_call_id: row.tool_call_id,
      tool_name: row.tool_name ?? "",
      is_error: row.is_error === true,
      text: text.slice(0, OUTPUT_TEXT_MAX_CHARS),
      truncated: text.length > OUTPUT_TEXT_MAX_CHARS,
    },
  };
}

/** A per-process limit on concurrent reads; a finished read hands its slot to the next waiter. */
function limiter(max: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active < max) active += 1;
    else await new Promise<void>((resolve) => waiting.push(resolve));
    try {
      return await fn();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active -= 1;
    }
  };
}
const blobReads = limiter(BLOB_READS_AT_ONCE);

/** An offloaded tool output, read with the cap and the per-process read limit. */
export async function readOffloadedOutput(
  blobs: BlobStore | undefined,
  ids: { readonly teamId: string; readonly threadId: string; readonly entryId: string },
  key: string,
): Promise<ToolOutput | OffloadedFailure | "not_a_tool_output"> {
  const read = await blobReads(() =>
    readOffloadedJson(blobs, { ...ids, reader: "tool output" }, key, MAX_OUTPUT_BLOB_BYTES),
  );
  if (!read.ok) return read.reason;
  return toolOutputOf(read.body) ?? "not_a_tool_output";
}
