/** Kobe Event Stream event types (spec §6.2). Every event is persisted to `run_events` with a monotonic `seq` before fan-out. */
export const KOBE_EVENT_TYPES = [
  "run.queued",
  "run.started",
  "sandbox.waking",
  "text.delta",
  "reasoning.delta",
  "tool.call",
  "tool.result",
  "approval.requested",
  "approval.resolved",
  "policy.denied",
  "egress.blocked",
  "steer.applied",
  "memory.updated",
  "artifact.created",
  "artifact.updated",
  "file.shared",
  "entry.committed",
  "run.completed",
  "run.failed",
  "run.interrupted",
  "run.budget_stopped",
] as const;

export type KobeEventType = (typeof KOBE_EVENT_TYPES)[number];

const EVENT_TYPE_SET: ReadonlySet<string> = new Set(KOBE_EVENT_TYPES);

export function isKobeEventType(value: unknown): value is KobeEventType {
  return typeof value === "string" && EVENT_TYPE_SET.has(value);
}
