import type { AuditEntry } from "@kobe/db";

export const FORWARD_DESTINATIONS = ["syslog", "otlp"] as const;
export type ForwardDestination = (typeof FORWARD_DESTINATIONS)[number];

/** A SIEM destination. `send` resolves once the batch is handed over and rejects on any failure. */
export interface AuditSink {
  readonly name: ForwardDestination;
  send(events: readonly AuditEntry[]): Promise<void>;
}
