/**
 * The context gauge's numbers (CE14, KOBE-211): how full the thread's context is, as the prompt of
 * its newest model call against the thread model's context window. Pure; the gauge
 * (`components/shell/context-gauge.tsx`) renders it.
 *
 * Prompt size = input + cache read + cache write. Both sources keep the three disjoint: Pi's
 * `Usage` (pi-ai 1.0.0 subtracts cached and cache-write tokens from OpenAI/Gemini prompt counts;
 * Anthropic reports them apart) and the gateway's `run_usage` (`normalize.ts`). Summing all three
 * counts every prompt token once whichever way a provider reported it.
 */
import { formatTokens } from "../admin/usage-format";

/** Orange from this share of the window. */
export const GAUGE_WARN_PERCENT = 65;
/** Red from this share: time to compact. */
export const GAUGE_FULL_PERCENT = 85;

export type GaugeLevel = "ok" | "warn" | "full";

const count = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/**
 * The prompt tokens of a committed assistant message (Pi's `usage` on the entry that `message_end`
 * finalised); undefined for anything else, or a call that read nothing.
 */
export function messageContextTokens(
  payload: Readonly<Record<string, unknown>> | undefined,
): number | undefined {
  const message = payload?.message as { role?: unknown; usage?: unknown } | undefined;
  if (message?.role !== "assistant") return undefined;
  const usage = message.usage as
    { input?: unknown; cacheRead?: unknown; cacheWrite?: unknown } | undefined;
  if (typeof usage !== "object" || usage === null) return undefined;
  const tokens = count(usage.input) + count(usage.cacheRead) + count(usage.cacheWrite);
  return tokens > 0 ? tokens : undefined;
}

/** An entry as far as the compaction check needs it. */
interface EntryLike {
  readonly type: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly payloadOffloaded: boolean;
}

/**
 * Pi compacted the context after the newest model call (`entries` in seq order): that call's prompt
 * is the size before compaction (the server leaves the compaction's own summary calls out of
 * `latest_call`, KOBE-213), and the size after it is unknown until the next call. An offloaded
 * message may be a later answer, so it counts as one.
 */
export function compactedSinceLastCall(entries: readonly EntryLike[]): boolean {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const e = entries[i] as EntryLike;
    if (e.type === "compaction") return true;
    if (e.type !== "message") continue;
    if (e.payloadOffloaded || messageContextTokens(e.payload) !== undefined) return false;
  }
  return false;
}

/** What the thread usage read said (`GET /v1/threads/{id}/usage`) and which run it followed. */
export interface UsageRead {
  /** The run whose end the read waited for; null for the read on open. */
  readonly afterRun: string | null;
  readonly latestCall:
    | {
        readonly runId: string;
        readonly model: string;
        readonly inputTokens: number;
        readonly cacheReadTokens: number;
        readonly cacheWriteTokens?: number | undefined;
      }
    | null
    | undefined;
}

/** The streamed side: the run on screen (`LiveRun`). */
export interface LiveContext {
  readonly runId: string;
  /** The model alias the run uses (`run.started`). */
  readonly model?: string | undefined;
  /** Newest message's prompt tokens; null: Pi compacted since; absent: nothing yet. */
  readonly contextTokens?: number | null | undefined;
}

export interface ContextSize {
  readonly tokens: number;
  /** Who counted them: a catalog alias (streamed) or a gateway model (`run_usage`). */
  readonly counter: { readonly alias: string } | { readonly gatewayModel: string } | null;
}

/**
 * The newest context size, or null when unknown (no call yet, or compacted since the last one).
 * While a run streams, its newest message wins. After it ended, `run_usage` wins only once a read
 * made after the end holds a call of that run (a stale read keeps the streamed value; the usage
 * provider reads again, bounded). With no run streamed, `run_usage` as loaded.
 *
 * `compacted` (the entries hold a compaction after every call) wins over both: the streamed
 * messages are entries too, so the run on screen streamed nothing since. Compact now after a run
 * ended in this tab leaves that run's size on `live` (KOBE-293).
 */
export function newestContextSize(
  live: LiveContext | undefined,
  read: UsageRead | null,
  compacted: boolean,
): ContextSize | null {
  if (compacted) return null;
  const call = read?.latestCall;
  const stored: ContextSize | null = call
    ? {
        tokens: call.inputTokens + call.cacheReadTokens + (call.cacheWriteTokens ?? 0),
        counter: { gatewayModel: call.model },
      }
    : null;
  const streamed = live?.contextTokens;
  if (live === undefined || streamed === undefined) return stored;
  if (streamed === null) return null;
  const storedIsThisRun = read?.afterRun === live.runId && call?.runId === live.runId;
  if (storedIsThisRun && stored !== null) return stored;
  return { tokens: streamed, counter: live.model === undefined ? null : { alias: live.model } };
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
  readonly tokens: number;
  /** The thread model's context window; null when the catalog leaves it blank. */
  readonly window: number | null;
  /** The thread model's name, when known: whose window the scale is. */
  readonly model: string | null;
  /** The model that counted the tokens, when it is not `model` (tokenizers differ). */
  readonly countedBy?: string | null | undefined;
}

/**
 * "142k of 200k tokens (71%) · Claude", or "142k tokens · Claude" without a window; when another
 * model counted them, "· counted by GLM 5.3" follows.
 */
export function gaugeLabel({ tokens, window, model, countedBy }: GaugeReading): string {
  const amount =
    window === null
      ? `${formatTokens(tokens)} tokens`
      : // Rounded down, so the share shown never reaches a threshold the colour hasn't.
        `${formatTokens(tokens)} of ${formatTokens(window)} tokens (${Math.floor(contextPercent(tokens, window))}%)`;
  const parts = [amount, ...(model === null ? [] : [model])];
  if (countedBy) parts.push(`counted by ${countedBy}`);
  return parts.join(" · ");
}
