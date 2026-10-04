import { z } from "zod";
import { validateCidrs } from "./address-policy.js";

/**
 * MCP proxy configuration (spec D27), validated at startup: invalid env fails fast. The chart
 * renders it from `mcpProxy.*` values. The proxy has no database: the server decides every call
 * (internal listener) and the proxy holds only its own session-token key and the internal key.
 */
const MIN_KEY_LENGTH = 32;

const int = (name: string, min: number, max: number, fallback: number) =>
  z.coerce
    .number({ error: `${name} must be a number` })
    .int(`${name} must be an integer`)
    .min(min, `${name} must be between ${min} and ${max}`)
    .max(max, `${name} must be between ${min} and ${max}`)
    .default(fallback);

const list = z
  .string()
  .default("")
  .transform((v) =>
    v
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s !== ""),
  );

const key = (name: string) =>
  z
    .string({ error: `${name} is required` })
    .min(MIN_KEY_LENGTH, `${name} must be at least ${MIN_KEY_LENGTH} characters`);

const configSchema = z.object({
  PORT: int("PORT", 1, 65535, 8080),
  /** Verifies sandboxes' `kobe.mcp-proxy` session tokens (never another audience's key). */
  KOBE_SESSION_KEY_MCP_PROXY: key("KOBE_SESSION_KEY_MCP_PROXY"),
  /** The server's internal listener (policy re-check), e.g. http://kobe-server:8082. */
  KOBE_MCP_SERVER_URL: z.url({
    protocol: /^https?$/,
    error: "KOBE_MCP_SERVER_URL must be an http(s) URL",
  }),
  KOBE_MCP_INTERNAL_KEY: key("KOBE_MCP_INTERNAL_KEY"),
  /** Plain-http connector URLs (development and the e2e suite only; credentials would leak). */
  KOBE_MCP_ALLOW_INSECURE_HTTP: z
    .enum(["true", "false"], { error: "KOBE_MCP_ALLOW_INSECURE_HTTP must be true or false" })
    .default("false"),
  /** Upstream ports connectors may use. */
  KOBE_MCP_ALLOWED_PORTS: list,
  /** Internal targets explicitly allowed (on-premises MCP servers), as CIDRs. */
  KOBE_MCP_ALLOWED_INTERNAL_CIDRS: list,
  /** More ranges to refuse (cluster pod/Service CIDRs when not private). */
  KOBE_MCP_DENIED_CIDRS: list,
  KOBE_MCP_MAX_REQUEST_BYTES: int(
    "KOBE_MCP_MAX_REQUEST_BYTES",
    1_024,
    16 * 1024 * 1024,
    1024 * 1024,
  ),
  KOBE_MCP_MAX_RESPONSE_BYTES: int(
    "KOBE_MCP_MAX_RESPONSE_BYTES",
    1_024,
    64 * 1024 * 1024,
    4 * 1024 * 1024,
  ),
  /** Whole upstream call (connect, initialize, call); under Pi's 60 s MCP request timeout. */
  KOBE_MCP_UPSTREAM_TIMEOUT_MS: int("KOBE_MCP_UPSTREAM_TIMEOUT_MS", 1_000, 600_000, 55_000),
  KOBE_MCP_SERVER_TIMEOUT_MS: int("KOBE_MCP_SERVER_TIMEOUT_MS", 100, 60_000, 10_000),
  /** Concurrent calls per sandbox and per replica. */
  KOBE_MCP_CALLS_PER_SANDBOX: int("KOBE_MCP_CALLS_PER_SANDBOX", 1, 1_000, 8),
  KOBE_MCP_MAX_CONCURRENT_CALLS: int("KOBE_MCP_MAX_CONCURRENT_CALLS", 1, 100_000, 256),
  /** Requests per sandbox: a burst, then this many per second. */
  KOBE_MCP_REQUEST_BURST: int("KOBE_MCP_REQUEST_BURST", 1, 10_000, 60),
  KOBE_MCP_REQUESTS_PER_SECOND: int("KOBE_MCP_REQUESTS_PER_SECOND", 1, 10_000, 10),
});

export interface Limits {
  readonly maxRequestBytes: number;
  readonly maxResponseBytes: number;
  readonly upstreamTimeoutMs: number;
  readonly serverTimeoutMs: number;
  readonly callsPerSandbox: number;
  readonly maxConcurrentCalls: number;
  readonly requestBurst: number;
  readonly requestsPerSecond: number;
}

export interface UpstreamPolicy {
  readonly allowInsecureHttp: boolean;
  readonly allowedPorts: readonly number[];
  readonly allowedInternalCidrs: readonly string[];
  readonly deniedCidrs: readonly string[];
}

export interface Config {
  readonly port: number;
  readonly sessionKey: string;
  readonly serverUrl: string;
  readonly internalKey: string;
  readonly upstream: UpstreamPolicy;
  readonly limits: Limits;
}

export const DEFAULT_LIMITS: Limits = {
  maxRequestBytes: 1024 * 1024,
  maxResponseBytes: 4 * 1024 * 1024,
  upstreamTimeoutMs: 55_000,
  serverTimeoutMs: 10_000,
  callsPerSandbox: 8,
  maxConcurrentCalls: 256,
  requestBurst: 60,
  requestsPerSecond: 10,
};

function ports(values: readonly string[]): number[] {
  const parsed = (values.length === 0 ? ["443"] : values).map(Number);
  if (parsed.some((p) => !Number.isInteger(p) || p < 1 || p > 65535)) {
    throw new Error("Invalid configuration: KOBE_MCP_ALLOWED_PORTS must be ports (1-65535)");
  }
  return parsed;
}

function cidrs(name: string, values: readonly string[]): readonly string[] {
  try {
    validateCidrs(values);
  } catch {
    throw new Error(`Invalid configuration: ${name} must be a comma-separated list of CIDRs`);
  }
  return values;
}

export function loadConfig(env: Readonly<Record<string, string | undefined>>): Config {
  const parsed = configSchema.safeParse(env);
  if (!parsed.success) {
    // Messages only (never values), so keys can't leak into logs.
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid configuration: ${issues}`);
  }
  const d = parsed.data;
  if (d.KOBE_SESSION_KEY_MCP_PROXY === d.KOBE_MCP_INTERNAL_KEY) {
    throw new Error("Invalid configuration: the session key and the internal key must differ");
  }
  return {
    port: d.PORT,
    sessionKey: d.KOBE_SESSION_KEY_MCP_PROXY,
    serverUrl: d.KOBE_MCP_SERVER_URL.replace(/\/+$/, ""),
    internalKey: d.KOBE_MCP_INTERNAL_KEY,
    upstream: {
      allowInsecureHttp: d.KOBE_MCP_ALLOW_INSECURE_HTTP === "true",
      allowedPorts: ports(d.KOBE_MCP_ALLOWED_PORTS),
      allowedInternalCidrs: cidrs(
        "KOBE_MCP_ALLOWED_INTERNAL_CIDRS",
        d.KOBE_MCP_ALLOWED_INTERNAL_CIDRS,
      ),
      deniedCidrs: cidrs("KOBE_MCP_DENIED_CIDRS", d.KOBE_MCP_DENIED_CIDRS),
    },
    limits: {
      maxRequestBytes: d.KOBE_MCP_MAX_REQUEST_BYTES,
      maxResponseBytes: d.KOBE_MCP_MAX_RESPONSE_BYTES,
      upstreamTimeoutMs: d.KOBE_MCP_UPSTREAM_TIMEOUT_MS,
      serverTimeoutMs: d.KOBE_MCP_SERVER_TIMEOUT_MS,
      callsPerSandbox: d.KOBE_MCP_CALLS_PER_SANDBOX,
      maxConcurrentCalls: d.KOBE_MCP_MAX_CONCURRENT_CALLS,
      requestBurst: d.KOBE_MCP_REQUEST_BURST,
      requestsPerSecond: d.KOBE_MCP_REQUESTS_PER_SECOND,
    },
  };
}
