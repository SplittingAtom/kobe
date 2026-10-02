import {
  parseEventPayload,
  type KobeEvent,
  type KobeEventPayload,
  type KobeEventType,
} from "../events.js";

/**
 * In-memory stand-in for `run_events` (test use only): per-run gapless `seq` from 1, payloads
 * validated against the contract, replay with `readAfter(run, cursor)` as SSE resume does.
 */
export interface InMemoryEventLog {
  append<T extends KobeEventType>(
    runId: string,
    type: T,
    payload: KobeEventPayload<T>,
  ): KobeEvent<T>;
  readAfter(runId: string, after: number): readonly KobeEvent[];
  subscribe(runId: string, listener: (event: KobeEvent) => void): () => void;
}

export function createInMemoryEventLog(now: () => Date = () => new Date()): InMemoryEventLog {
  const logs = new Map<string, readonly KobeEvent[]>();
  const listeners = new Map<string, ReadonlySet<(event: KobeEvent) => void>>();

  return {
    append(runId, type, payload) {
      const existing = logs.get(runId) ?? [];
      const event = {
        run_id: runId,
        seq: existing.length + 1,
        ts: now().toISOString(),
        type,
        payload: parseEventPayload(type, payload),
      } as KobeEvent<typeof type>;
      logs.set(runId, [...existing, event as KobeEvent]);
      for (const listener of listeners.get(runId) ?? []) listener(event as KobeEvent);
      return event;
    },
    readAfter(runId, after) {
      return (logs.get(runId) ?? []).filter((event) => event.seq > after);
    },
    subscribe(runId, listener) {
      listeners.set(runId, new Set([...(listeners.get(runId) ?? []), listener]));
      return () => {
        const remaining = [...(listeners.get(runId) ?? [])].filter((l) => l !== listener);
        listeners.set(runId, new Set(remaining));
      };
    },
  };
}
