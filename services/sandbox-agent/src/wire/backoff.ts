/**
 * Reconnect delays: exponential with full jitter and a floor, so a server restart does not get every
 * sandbox in the install reconnecting in lockstep (reconnect storm), and a flapping server never
 * sees a tight loop from one sandbox.
 */
export interface BackoffPolicy {
  readonly baseMs: number;
  readonly maxMs: number;
  readonly floorMs: number;
}

export const DEFAULT_BACKOFF: BackoffPolicy = { baseMs: 500, maxMs: 30_000, floorMs: 250 };

export function backoffDelay(
  attempt: number,
  policy: BackoffPolicy = DEFAULT_BACKOFF,
  random: () => number = Math.random,
): number {
  const ceiling = Math.min(policy.maxMs, policy.baseMs * 2 ** Math.min(attempt, 30));
  return Math.max(policy.floorMs, Math.floor(random() * ceiling));
}
