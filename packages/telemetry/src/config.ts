import { z } from "zod";

/**
 * Tracing configuration (KOBE-10, spec D31), validated at startup like every service config. No
 * endpoint means tracing is off and nothing is registered (zero overhead). Content capture is an
 * install-level opt-in; by default spans carry metadata only.
 */
const configSchema = z.object({
  /** OTLP/HTTP collector base URL, e.g. http://otel-collector:4318 (`/v1/traces` is appended). */
  KOBE_OTEL_ENDPOINT: z
    .url({ protocol: /^https?$/, error: "KOBE_OTEL_ENDPOINT must be an http(s) URL" })
    .optional(),
  /** Exporter headers as `name=value,name=value` (credentials for hosted backends). */
  KOBE_OTEL_HEADERS: z.string().optional(),
  /** Opt in to message, prompt, tool input/output and query-string capture on spans. */
  KOBE_OTEL_CAPTURE_CONTENT: z
    .enum(["true", "false"], { error: "KOBE_OTEL_CAPTURE_CONTENT must be true or false" })
    .default("false"),
});

export interface TelemetryConfig {
  readonly enabled: boolean;
  readonly endpoint?: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly captureContent: boolean;
  readonly serviceName: string;
}

function parseHeaders(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of (raw ?? "").split(",")) {
    const trimmed = pair.trim();
    if (trimmed === "") continue;
    const eq = trimmed.indexOf("=");
    if (eq < 1) {
      // Never echo the value: it may be a credential.
      throw new Error("Invalid configuration: KOBE_OTEL_HEADERS must be name=value pairs");
    }
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return out;
}

export function loadTelemetryConfig(
  env: Readonly<Record<string, string | undefined>>,
  service: string,
): TelemetryConfig {
  const parsed = configSchema.safeParse({
    KOBE_OTEL_ENDPOINT: env.KOBE_OTEL_ENDPOINT?.trim() || undefined,
    KOBE_OTEL_HEADERS: env.KOBE_OTEL_HEADERS,
    KOBE_OTEL_CAPTURE_CONTENT: env.KOBE_OTEL_CAPTURE_CONTENT?.trim() || undefined,
  });
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid configuration: ${issues}`);
  }
  const d = parsed.data;
  const headers = parseHeaders(d.KOBE_OTEL_HEADERS);
  const endpoint = d.KOBE_OTEL_ENDPOINT?.replace(/\/+$/, "");
  return {
    enabled: endpoint !== undefined,
    ...(endpoint === undefined ? {} : { endpoint }),
    headers,
    captureContent: d.KOBE_OTEL_CAPTURE_CONTENT === "true",
    serviceName: `kobe-${service}`,
  };
}
