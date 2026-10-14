/**
 * Rich history (CE12, KOBE-208): what the reasoning blocks, tool cards and answer footers read
 * from the Pi entries besides their text. Pure helpers; `tree.ts` puts their answers on the parts.
 *
 * Timing uses Pi's own clock: an entry's `timestamp` (ISO, written when Pi appended it) and an
 * assistant message's `timestamp` (epoch ms, when its step started). An offloaded entry has no
 * payload here, so its server `createdAt` stands in.
 */
import { parseEntry, type ParsedEntry } from "./entries";
import type { ThreadEntry } from "./types";

export interface PartTiming {
  readonly startedAt: number;
  readonly completedAt?: number;
}

function epoch(value: unknown): number | undefined {
  const ms = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(ms) ? ms : undefined;
}

/** When Pi appended the entry; an offloaded entry's server time. */
export function entryTime(entry: ThreadEntry): number | undefined {
  return entry.payloadOffloaded ? epoch(entry.createdAt) : epoch(entry.payload.timestamp);
}

/** When the assistant step that wrote this entry started (Pi's `message.timestamp`). */
export function stepStart(entry: ThreadEntry): number | undefined {
  const message = entry.payload.message;
  if (message === null || typeof message !== "object") return undefined;
  const at = (message as { readonly timestamp?: unknown }).timestamp;
  return typeof at === "number" && Number.isFinite(at) ? at : undefined;
}

/** A finished part's timing, or undefined when either end is unknown or they disagree. */
export function timing(
  startedAt: number | undefined,
  completedAt: number | undefined,
): PartTiming | undefined {
  if (startedAt === undefined || completedAt === undefined || completedAt < startedAt) {
    return undefined;
  }
  return { startedAt, completedAt };
}

/**
 * Which tool call each offloaded entry answers (toolCallId → entryId). An offloaded body's role is
 * unknown here, but Pi appends tool results right after the step that called them, in call order:
 * an offloaded entry under that step (directly or after other results) answers its first call
 * that has no result yet. An offloaded entry anywhere else stays a notice.
 */
export function offloadedResults(
  entries: readonly ThreadEntry[],
  parsed: ReadonlyMap<string, ParsedEntry>,
  answered: (toolCallId: string) => boolean,
): ReadonlyMap<string, string> {
  const byId = new Map(entries.map((e) => [e.entryId, e] as const));
  const assigned = new Map<string, string>();
  for (const entry of entries) {
    if (parsed.get(entry.entryId)?.kind !== "offloaded") continue;
    let step = entry.parentId === null ? undefined : byId.get(entry.parentId);
    const seen = new Set<string>();
    while (step && !seen.has(step.entryId)) {
      const kind = parsed.get(step.entryId)?.kind;
      if (kind !== "toolResult" && kind !== "offloaded") break;
      seen.add(step.entryId);
      step = step.parentId === null ? undefined : byId.get(step.parentId);
    }
    const p = step ? parsed.get(step.entryId) : undefined;
    if (p?.kind !== "assistant") continue;
    const call = p.pieces.find(
      (piece) =>
        piece.kind === "toolCall" && !answered(piece.toolCallId) && !assigned.has(piece.toolCallId),
    );
    if (call?.kind === "toolCall") assigned.set(call.toolCallId, entry.entryId);
  }
  return assigned;
}

/** The fields a tool's input is usually about, in the order they are preferred for its summary. */
const SUMMARY_KEYS = ["command", "cmd", "path", "file_path", "query", "url", "pattern", "code"];

/** A tool input in one line for the card's header: its main field, else compact JSON. */
export function inputSummary(args: Readonly<Record<string, unknown>>, max = 80): string {
  const values = Object.values(args);
  const main =
    SUMMARY_KEYS.map((k) => args[k]).find((v) => typeof v === "string" && v.trim() !== "") ??
    (values.length === 1 && typeof values[0] === "string" ? values[0] : undefined);
  const text = typeof main === "string" ? main : values.length === 0 ? "" : JSON.stringify(args);
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** `0.4 s`, `12 s`, `2 min 5 s`. */
export function formatDuration(ms: number): string {
  if (ms < 10_000) return `${(Math.max(0, ms) / 1000).toFixed(1)} s`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  const rest = seconds % 60;
  return `${Math.floor(seconds / 60)} min${rest > 0 ? ` ${rest} s` : ""}`;
}

/** The tool output in an entry body read back from object storage, if it is a tool result. */
export function toolResultOf(
  entryId: string,
  payload: unknown,
): { readonly text: string; readonly isError: boolean } | undefined {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const p = parseEntry({
    entryId,
    parentId: null,
    seq: 0,
    type: "message",
    payload: payload as Readonly<Record<string, unknown>>,
    payloadOffloaded: false,
    createdAt: "",
  });
  return p.kind === "toolResult" ? { text: p.text, isError: p.isError } : undefined;
}
