import type { WireTuning } from "./constants.js";
import type { SandboxLimit } from "./context.js";

/** Limits and small bookkeeping one sandbox connection keeps (KOBE-706: moved out of connection.ts). */

export const MAX_BUFFERED_BYTES = 32 * 1024 * 1024;
export const POLICY_ANSWERED_MAX = 4_096;
/** `workspace.sync_now` asks in flight per connection (KOBE-599); more are answered `unsynced`. */
export const MAX_SYNC_REQUESTS = 16;
/** `{"v":1,"type":"<type>"` at the start of a frame (whitespace tolerated). */
const FRAME_PREFIX = /^\s*\{\s*"v"\s*:\s*1\s*,\s*"type"\s*:\s*"([a-z._]{1,32})"/;
/** Ended leases kept to answer late frames with `run_not_active`; older ones are forgotten. */
export const ENDED_LEASES_MAX = 256;
/** `session.renew` frames with an invalid token a connection may send before it is closed. */
export const INVALID_RENEWALS_MAX = 3;

export function remember(set: Set<string>, value: string, max: number): void {
  set.add(value);
  if (set.size > max) {
    const oldest = set.values().next().value;
    if (oldest !== undefined) set.delete(oldest);
  }
}

/** Frame and byte token buckets, charged before anything is decoded. */
export class FrameRate {
  readonly #tuning: WireTuning;
  #tokens: number;
  #byteTokens: number;
  #tokensAt = Date.now();

  constructor(tuning: WireTuning) {
    this.#tuning = tuning;
    this.#tokens = tuning.frameBurst;
    this.#byteTokens = tuning.byteBurst;
  }

  /** Charges one frame of `bytes`; the limit it broke, or undefined. */
  charge(bytes: number): SandboxLimit | undefined {
    const { frameRatePerSec, frameBurst, byteRatePerSec, byteBurst } = this.#tuning;
    const now = Date.now();
    const elapsed = (now - this.#tokensAt) / 1000;
    this.#tokensAt = now;
    this.#tokens = Math.min(frameBurst, this.#tokens + elapsed * frameRatePerSec);
    this.#byteTokens = Math.min(byteBurst, this.#byteTokens + elapsed * byteRatePerSec);
    if (this.#tokens < 1) return "frame_rate";
    if (this.#byteTokens < bytes) return "byte_rate";
    this.#tokens -= 1;
    this.#byteTokens -= bytes;
    return undefined;
  }
}

/**
 * Size cap by frame type, read from the raw prefix (KOBE-23 writes `{"v":1,"type":…` first):
 * only `pi.event` / `command.result` may use the full 4 MiB, `policy.check` a smaller cap, and
 * any other or unreadable type must be small — so a hostile frame is refused before parsing.
 * Before the connection is ready, only small frames pass.
 */
export function frameSizeOk(
  raw: Buffer,
  ready: boolean,
  max: WireTuning["frameMaxBytes"],
): boolean {
  if (raw.length <= max.small) return true;
  if (!ready) return false;
  const type = FRAME_PREFIX.exec(raw.subarray(0, 64).toString("latin1"))?.[1];
  if (type === "pi.event" || type === "command.result") return raw.length <= max.bulk;
  if (type === "policy.check") return raw.length <= max.policyCheck;
  if (type === "artifact.put") return raw.length <= max.artifactPut;
  if (type === "thread.compact_result") return raw.length <= max.compactResult;
  if (type === "notebook.run") return raw.length <= max.notebookRun;
  return false;
}

/** Per-run token bucket for `policy.denied` events. */
export class DeniedEventBuckets {
  readonly #tuning: WireTuning;
  readonly #buckets = new Map<string, { tokens: number; at: number }>();

  constructor(tuning: WireTuning) {
    this.#tuning = tuning;
  }

  take(runId: string): boolean {
    const { deniedEventBurst, deniedEventsPerMinute } = this.#tuning;
    const now = Date.now();
    const b = this.#buckets.get(runId) ?? { tokens: deniedEventBurst, at: now };
    b.tokens = Math.min(
      deniedEventBurst,
      b.tokens + ((now - b.at) / 60_000) * deniedEventsPerMinute,
    );
    b.at = now;
    this.#buckets.set(runId, b);
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  forget(runId: string): void {
    this.#buckets.delete(runId);
  }
}
