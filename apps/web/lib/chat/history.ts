/**
 * Rich history (CE12, KOBE-208): what the reasoning blocks, tool cards and answer footers read
 * from the Pi entries besides their text. Pure helpers; `tree.ts` puts their answers on the parts.
 *
 * Timing uses only Pi's own clock, never the server's: an entry's `timestamp` (ISO, written when
 * Pi appended it) and an assistant message's `timestamp` (epoch ms, when its step started). An
 * offloaded entry has no payload here, so nothing it ends is timed.
 */
import type { ThreadEntry } from "./types";

export interface PartTiming {
  readonly startedAt: number;
  readonly completedAt?: number;
}

function epoch(value: unknown): number | undefined {
  const ms = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(ms) ? ms : undefined;
}

/** When Pi appended the entry (unknown for an offloaded one). */
export function entryTime(entry: ThreadEntry): number | undefined {
  return epoch(entry.payload.timestamp);
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
