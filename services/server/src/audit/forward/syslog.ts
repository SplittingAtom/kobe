import { hostname as osHostname } from "node:os";
import net from "node:net";
import tls from "node:tls";
import type { AuditEntry } from "@kobe/db";
import type { AuditForwardingConfig } from "./config.js";
import type { AuditSink } from "./types.js";

/** Facility 13 (log audit) and severity 6 (informational): PRI = 13 * 8 + 6. */
export const SYSLOG_PRI = 110;
/**
 * Structured-data ID. `kobe@32473` uses the enterprise number RFC 5612 reserves for documentation;
 * SIEM rules should match the APP-NAME `kobe-audit` and the MSGID (the action).
 */
export const SYSLOG_SD_ID = "kobe@32473";
const SEND_TIMEOUT_MS = 10_000;

/** PRINTUSASCII without space, at most `max` characters, "-" when nothing is left (RFC 5424 §6). */
function header(value: string, max: number): string {
  const clean = value.replace(/[^\x21-\x7e]/g, "").slice(0, max);
  return clean === "" ? "-" : clean;
}

/** SD-PARAM values escape `"`, `\` and `]` (RFC 5424 §6.3.3). */
function sdValue(value: string): string {
  return value.replace(/[\\"\]]/g, (c) => `\\${c}`);
}

export interface SyslogFormatOptions {
  readonly hostname?: string;
  readonly procId?: string | number;
}

/** One event as an RFC 5424 message: structured data carries the ids, the body the full event. */
export function formatSyslogMessage(entry: AuditEntry, options: SyslogFormatOptions = {}): string {
  const params: [string, string | null][] = [
    ["seq", String(entry.seq)],
    ["id", entry.id],
    ["team", entry.teamId],
    ["actorKind", entry.actor.kind],
    ["actor", entry.actor.id],
    ["hash", entry.hash],
  ];
  const sd = `[${SYSLOG_SD_ID}${params
    .filter(([, v]) => v !== null)
    .map(([k, v]) => ` ${k}="${sdValue(v ?? "")}"`)
    .join("")}]`;
  const body = JSON.stringify({
    seq: entry.seq,
    id: entry.id,
    at: entry.at.toISOString(),
    teamId: entry.teamId,
    actor: entry.actor,
    action: entry.action,
    target: entry.target,
    ip: entry.ip,
    userAgent: entry.userAgent,
    prevHash: entry.prevHash,
    hash: entry.hash,
  });
  return [
    `<${SYSLOG_PRI}>1`,
    entry.at.toISOString(),
    header(options.hostname ?? osHostname(), 255),
    "kobe-audit",
    header(String(options.procId ?? process.pid), 128),
    header(entry.action, 32),
    `${sd} ${body}`,
  ].join(" ");
}

/** TCP octet-counting framing (RFC 6587 §3.4.1): safe for messages containing newlines. */
export function frame(message: string): Buffer {
  const payload = Buffer.from(message, "utf8");
  return Buffer.concat([Buffer.from(`${payload.length} `, "ascii"), payload]);
}

export interface SyslogSinkOptions extends SyslogFormatOptions {
  /** Extra TLS options (a private CA in tests). */
  readonly tlsOptions?: tls.ConnectionOptions;
  readonly timeoutMs?: number;
}

/**
 * Syslog over TCP or TLS. One connection per batch: written, flushed, closed. TCP gives no
 * acknowledgement, so delivery is at-least-once only up to the socket; the event `id` in the
 * structured data lets the SIEM drop duplicates after a retry.
 */
export function syslogSink(
  config: NonNullable<AuditForwardingConfig["syslog"]>,
  options: SyslogSinkOptions = {},
): AuditSink {
  return {
    name: "syslog",
    send(events) {
      const data = Buffer.concat(events.map((e) => frame(formatSyslogMessage(e, options))));
      return new Promise<void>((resolve, reject) => {
        const socket = config.tls
          ? tls.connect({
              host: config.host,
              port: config.port,
              servername: net.isIP(config.host) ? "" : config.host,
              ...options.tlsOptions,
            })
          : net.connect({ host: config.host, port: config.port });
        let failure: Error | undefined;
        socket.setTimeout(options.timeoutMs ?? SEND_TIMEOUT_MS, () =>
          socket.destroy(new Error("syslog connection timed out")),
        );
        socket.on("error", (err) => {
          failure = err;
        });
        socket.on("close", () => (failure ? reject(failure) : resolve()));
        // TLS: write once the handshake (and certificate check) succeeded.
        socket.once(config.tls ? "secureConnect" : "connect", () => socket.end(data));
      });
    },
  };
}
