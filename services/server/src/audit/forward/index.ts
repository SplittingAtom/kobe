import type { AuditForwardingConfig } from "./config.js";
import { otlpSink } from "./otlp.js";
import { syslogSink } from "./syslog.js";
import type { AuditSink, ForwardDestination } from "./types.js";

export function sinksFor(config: AuditForwardingConfig): AuditSink[] {
  return [
    ...(config.syslog ? [syslogSink(config.syslog)] : []),
    ...(config.otlp ? [otlpSink(config.otlp)] : []),
  ];
}

export function destinationsOf(config: AuditForwardingConfig): ForwardDestination[] {
  return [
    ...(config.syslog ? (["syslog"] as const) : []),
    ...(config.otlp ? (["otlp"] as const) : []),
  ];
}
