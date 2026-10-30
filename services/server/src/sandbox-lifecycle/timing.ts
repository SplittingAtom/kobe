/**
 * Sandbox cold-start timing as spans (KOBE-525): each span's duration is the latency, so the trace
 * backend's percentiles need only span names and times.
 *
 * - `sandbox.wake`: the wake (lifecycle) → the pod is Ready; children `sandbox.claim` (the
 *   SandboxClaim created or the Sandbox resumed, until its pod exists: the warm-pool claim time
 *   for a first start) and `sandbox.pod_ready` (pod exists → Ready).
 * - `sandbox.agent_hello`: the wake's start (`sandboxes.state_changed_at`) → the agent's hello on
 *   the wire, only when the hello follows the wake closely (a later reconnect is not a cold start).
 *
 * Pi ready is the run's `run.pi_ready` (sandbox-wire/run-latency.ts).
 */
export interface TimingSpan {
  readonly name: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly attributes: Readonly<Record<string, string | boolean>>;
}

export interface WakeTimings {
  readonly startMs: number;
  /** The provider returned a running sandbox (claim bound to a pod, or resumed). */
  readonly claimedMs: number;
  /** The pod is Ready. */
  readonly readyMs: number;
  /** Why the wake was announced; null for a running sandbox that was only disconnected. */
  readonly reason: "first_start" | "hibernated" | null;
  readonly resumed: boolean;
}

export function wakeSpans(t: WakeTimings): TimingSpan[] {
  const claimed = Math.max(t.startMs, t.claimedMs);
  const ready = Math.max(claimed, t.readyMs);
  const attributes = {
    "kobe.wake.reason": t.reason ?? "reconnect",
    "kobe.wake.resumed": t.resumed,
  };
  return [
    { name: "sandbox.wake", startMs: t.startMs, endMs: ready, attributes },
    { name: "sandbox.claim", startMs: t.startMs, endMs: claimed, attributes },
    { name: "sandbox.pod_ready", startMs: claimed, endMs: ready, attributes },
  ];
}

/** A hello later than this after the wake started is a reconnect, not a cold start. */
export const AGENT_HELLO_AFTER_WAKE_MAX_MS = 5 * 60_000;

export function agentHelloSpan(
  wakeStartedAt: Date | null | undefined,
  helloMs: number,
): TimingSpan | undefined {
  if (!wakeStartedAt) return undefined;
  const startMs = wakeStartedAt.getTime();
  const elapsed = helloMs - startMs;
  if (!(elapsed >= 0) || elapsed > AGENT_HELLO_AFTER_WAKE_MAX_MS) return undefined;
  return { name: "sandbox.agent_hello", startMs, endMs: helloMs, attributes: {} };
}
