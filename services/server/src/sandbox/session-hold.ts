import type { BootstrapIdentity, SandboxProvider, UnassignedIdentity } from "./provider.js";

/**
 * Long-poll for an unclaimed warm-pool pod (KOBE-417). A client sending `Prefer: wait=<s>` (RFC
 * 7240) is held while its pod is unassigned: the bootstrap token is reviewed once, then only the
 * pod is re-read every `recheckMs` (one GET; the full claim and isolation checks once it carries a
 * claim label). The answer comes at the first recheck that sees the claim, or as 409 +
 * `Preference-Applied` after at most `maxWaitMs`, the token's expiry, or server shutdown.
 * `maxHoldsPerPod` concurrent holds per pod; extra requests are answered at once.
 */
export const SESSION_WAIT = { maxWaitMs: 20_000, recheckMs: 2_000, maxHoldsPerPod: 2 } as const;

export interface SessionWaitPolicy {
  readonly maxWaitMs: number;
  readonly recheckMs: number;
  readonly maxHoldsPerPod: number;
}

/** Seconds from `Prefer: wait=<n>`, or undefined when the client did not ask to wait. */
export function preferredWaitSeconds(prefer: string | undefined): number | undefined {
  const m = /(?:^|[,;\s])wait=(\d{1,6})(?:$|[,;\s])/i.exec(prefer ?? "");
  return m?.[1] === undefined ? undefined : Number(m[1]);
}

/**
 * Epoch ms of a JWT's `exp`, read without verifying (the TokenReview already did), or undefined
 * when the token carries none.
 */
export function tokenExpiryMs(token: string): number | undefined {
  const payload = token.split(".")[1];
  if (!payload) return undefined;
  try {
    const exp = (
      JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { exp?: unknown }
    ).exp;
    return typeof exp === "number" && Number.isFinite(exp) ? exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

/** Sleeps `ms`, or less when `signal` aborts. */
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

export interface HoldOptions {
  readonly provider: Pick<SandboxProvider, "recheckAssignment">;
  readonly policy: SessionWaitPolicy;
  /** Epoch ms after which the hold ends (the wait, capped by the token's expiry). */
  readonly deadline: number;
  readonly now: () => number;
  readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Aborts when the client goes away or the server shuts down. */
  readonly signal: AbortSignal;
}

/** Holds per pod (`namespace/pod`), so one pod cannot pin many server loops. */
export function createHoldRegistry(maxPerPod: number) {
  const held = new Map<string, number>();
  return {
    /** A release function, or undefined when the pod already has `maxPerPod` holds. */
    acquire(identity: UnassignedIdentity): (() => void) | undefined {
      const key = `${identity.namespace}/${identity.podName}`;
      const n = held.get(key) ?? 0;
      if (n >= maxPerPod) return undefined;
      held.set(key, n + 1);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const left = (held.get(key) ?? 1) - 1;
        if (left <= 0) held.delete(key);
        else held.set(key, left);
      };
    },
    size: () => held.size,
  };
}

/** Rechecks an unassigned pod until it is assigned, the deadline passes or the signal aborts. */
export async function holdWhileUnassigned(
  first: UnassignedIdentity,
  o: HoldOptions,
): Promise<BootstrapIdentity> {
  let identity: BootstrapIdentity = first;
  while (identity.state === "unassigned" && !o.signal.aborted) {
    const left = o.deadline - o.now();
    if (left <= 0) break;
    await o.sleep(Math.min(o.policy.recheckMs, left), o.signal);
    if (o.signal.aborted) break;
    identity = await o.provider.recheckAssignment(identity);
  }
  return identity;
}
