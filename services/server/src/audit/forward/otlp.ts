import type { AuditEntry } from "@kobe/db";
import type { AuditForwardingConfig } from "./config.js";
import type { AuditSink } from "./types.js";

const SEND_TIMEOUT_MS = 10_000;
/** OTLP severity INFO. */
const SEVERITY_INFO = 9;

type Attribute = { key: string; value: { stringValue: string } | { intValue: string } };

const str = (key: string, value: string): Attribute => ({ key, value: { stringValue: value } });

function toNanos(date: Date): string {
  return (BigInt(date.getTime()) * 1_000_000n).toString();
}

/** One event as an OTLP LogRecord (JSON encoding): the action is the body, fields are attributes. */
export function logRecord(entry: AuditEntry) {
  const attributes: Attribute[] = [
    { key: "kobe.audit.seq", value: { intValue: String(entry.seq) } },
    str("kobe.audit.id", entry.id),
    str("kobe.audit.action", entry.action),
    str("kobe.audit.actor.kind", entry.actor.kind),
    str("kobe.audit.target", JSON.stringify(entry.target)),
    str("kobe.audit.hash", entry.hash),
    str("kobe.audit.prev_hash", entry.prevHash),
  ];
  if (entry.teamId) attributes.push(str("kobe.audit.team_id", entry.teamId));
  if (entry.actor.id) attributes.push(str("kobe.audit.actor.id", entry.actor.id));
  if (entry.ip) attributes.push(str("client.address", entry.ip));
  if (entry.userAgent) attributes.push(str("user_agent.original", entry.userAgent));
  return {
    timeUnixNano: toNanos(entry.at),
    observedTimeUnixNano: toNanos(new Date()),
    severityNumber: SEVERITY_INFO,
    severityText: "INFO",
    body: { stringValue: entry.action },
    attributes,
  };
}

export function exportLogsRequest(events: readonly AuditEntry[]) {
  return {
    resourceLogs: [
      {
        resource: { attributes: [str("service.name", "kobe-server")] },
        scopeLogs: [{ scope: { name: "kobe.audit" }, logRecords: events.map(logRecord) }],
      },
    ],
  };
}

export interface OtlpSinkOptions {
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

/** OTLP/HTTP logs (JSON). Any 2xx is delivery; anything else, or a network error, is a failure. */
export function otlpSink(
  config: NonNullable<AuditForwardingConfig["otlp"]>,
  options: OtlpSinkOptions = {},
): AuditSink {
  const doFetch = options.fetch ?? fetch;
  return {
    name: "otlp",
    async send(events) {
      const res = await doFetch(config.url, {
        method: "POST",
        headers: { ...config.headers, "content-type": "application/json" },
        body: JSON.stringify(exportLogsRequest(events)),
        redirect: "error",
        signal: AbortSignal.timeout(options.timeoutMs ?? SEND_TIMEOUT_MS),
      });
      await res.body?.cancel();
      // Status only: the URL and headers may carry credentials and never go into health.
      if (!res.ok) throw new Error(`OTLP collector answered HTTP ${res.status}`);
    },
  };
}
