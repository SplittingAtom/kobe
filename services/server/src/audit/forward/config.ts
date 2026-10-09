import { z } from "zod";

/** Audit forwarding as configured by Helm values (`auditForwarding.*`, KOBE-19). */
export interface AuditForwardingConfig {
  readonly syslog?: { readonly host: string; readonly port: number; readonly tls: boolean };
  readonly otlp?: { readonly url: string; readonly headers: Readonly<Record<string, string>> };
}

const emptyToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);

const envSchema = z.object({
  // tcp://host:514 (plain) or tls://host:6514
  KOBE_AUDIT_SYSLOG_URL: z.preprocess(
    emptyToUndefined,
    z
      .string()
      .refine(
        (v) => URL.canParse(v),
        "KOBE_AUDIT_SYSLOG_URL must be tcp://host:port or tls://host:port",
      )
      .optional(),
  ),
  // The collector's OTLP/HTTP logs endpoint, e.g. https://collector:4318/v1/logs
  KOBE_AUDIT_OTLP_URL: z.preprocess(
    emptyToUndefined,
    z.url({ protocol: /^https?$/, error: "KOBE_AUDIT_OTLP_URL must be an http(s) URL" }).optional(),
  ),
  // "Name=value,Name2=value2" (OTEL_EXPORTER_OTLP_HEADERS style); from a Secret.
  KOBE_AUDIT_OTLP_HEADERS: z.string().optional(),
});

function parseSyslog(raw: string): NonNullable<AuditForwardingConfig["syslog"]> {
  const url = new URL(raw);
  if (url.protocol !== "tcp:" && url.protocol !== "tls:") {
    throw new Error(
      "Invalid configuration: KOBE_AUDIT_SYSLOG_URL must start with tcp:// or tls://",
    );
  }
  const port = Number(url.port);
  if (!url.hostname || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Invalid configuration: KOBE_AUDIT_SYSLOG_URL needs a host and a port");
  }
  return { host: url.hostname.replace(/^\[|\]$/g, ""), port, tls: url.protocol === "tls:" };
}

export function parseOtlpHeaders(raw: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const pair of (raw ?? "").split(",")) {
    const at = pair.indexOf("=");
    if (at < 1) continue;
    headers[pair.slice(0, at).trim()] = decodeURIComponent(pair.slice(at + 1).trim());
  }
  return headers;
}

/** Reads the forwarding env vars; invalid values fail at startup (messages never echo values). */
export function loadAuditForwardingConfig(
  env: Readonly<Record<string, string | undefined>>,
): AuditForwardingConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid configuration: ${issues}`);
  }
  const { KOBE_AUDIT_SYSLOG_URL: syslog, KOBE_AUDIT_OTLP_URL: otlp } = parsed.data;
  return {
    ...(syslog ? { syslog: parseSyslog(syslog) } : {}),
    ...(otlp
      ? { otlp: { url: otlp, headers: parseOtlpHeaders(parsed.data.KOBE_AUDIT_OTLP_HEADERS) } }
      : {}),
  };
}
