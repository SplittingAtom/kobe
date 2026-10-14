/**
 * The context gauge's numbers (CE14, KOBE-211): how full the thread's context is, as the input of
 * its newest model call (prompt plus cache read) against the thread model's context window.
 * Pure; the gauge (`components/shell/context-gauge.tsx`) renders it.
 */
import { formatTokens } from "../admin/usage-format";

/** Orange from this share of the window. */
export const GAUGE_WARN_PERCENT = 65;
/** Red from this share: time to compact. */
export const GAUGE_FULL_PERCENT = 85;

export type GaugeLevel = "ok" | "warn" | "full";

const count = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/**
 * Prompt plus cache-read tokens of a committed assistant message (Pi's `usage` on the entry that
 * `message_end` finalised); undefined for anything else, or a call that read nothing.
 */
export function messageContextTokens(
  payload: Readonly<Record<string, unknown>> | undefined,
): number | undefined {
  const message = payload?.message as { role?: unknown; usage?: unknown } | undefined;
  if (message?.role !== "assistant") return undefined;
  const usage = message.usage as { input?: unknown; cacheRead?: unknown } | undefined;
  if (typeof usage !== "object" || usage === null) return undefined;
  const tokens = count(usage.input) + count(usage.cacheRead);
  return tokens > 0 ? tokens : undefined;
}

/** What the thread usage read said (`GET /v1/threads/{id}/usage`) and which run it followed. */
export interface UsageRead {
  /** The run whose end the read waited for; null for the read on open. */
  readonly afterRun: string | null;
  readonly latestCall:
    { readonly inputTokens: number; readonly cacheReadTokens: number } | null | undefined;
}

/**
 * The newest context size: run_usage's latest row on load, each streamed assistant message while
 * a run goes, and run_usage again once it was re-read after that run ended. Null: no call yet.
 */
export function newestContextTokens(
  live: { readonly runId: string; readonly contextTokens?: number | undefined } | undefined,
  read: UsageRead | null,
): number | null {
  const call = read?.latestCall;
  const stored = call ? call.inputTokens + call.cacheReadTokens : undefined;
  const streamed = live?.contextTokens;
  const storedIsNewer = live === undefined || read?.afterRun === live.runId;
  return (storedIsNewer ? (stored ?? streamed) : (streamed ?? stored)) ?? null;
}

/** Share of the window used, unrounded (may pass 100 when the window is set too small). */
export function contextPercent(tokens: number, window: number): number {
  return (tokens / window) * 100;
}

export function gaugeLevel(percent: number): GaugeLevel {
  if (percent >= GAUGE_FULL_PERCENT) return "full";
  return percent >= GAUGE_WARN_PERCENT ? "warn" : "ok";
}

export interface GaugeReading {
  /** Null before the thread's first model call. */
  readonly tokens: number | null;
  /** The thread model's context window; null when the catalog leaves it blank. */
  readonly window: number | null;
  /** The thread model's name, when known. */
  readonly model: string | null;
}

/** "142k of 200k tokens (71%) · Claude", or "142k tokens · Claude" without a window. */
export function gaugeLabel({ tokens, window, model }: GaugeReading): string {
  const used = tokens ?? 0;
  const amount =
    window === null
      ? `${formatTokens(used)} tokens`
      : // Rounded down, so the share shown never reaches a threshold the colour hasn't.
        `${formatTokens(used)} of ${formatTokens(window)} tokens (${Math.floor(contextPercent(used, window))}%)`;
  return model === null ? amount : `${amount} · ${model}`;
}
