import { z } from "zod";
import { validateCidrs } from "./address-policy.js";

/**
 * Egress proxy configuration (spec D28), validated at startup: invalid env fails fast. The chart
 * renders it from `egressProxy.*` values.
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

const configSchema = z.object({
  PORT: int("PORT", 1, 65535, 8080),
  KOBE_DATABASE_URL: z
    .string({ error: "KOBE_DATABASE_URL is required" })
    .min(1, "KOBE_DATABASE_URL is required"),
  KOBE_SESSION_KEY_EGRESS_PROXY: z
    .string({ error: "KOBE_SESSION_KEY_EGRESS_PROXY is required" })
    .min(
      MIN_KEY_LENGTH,
      `KOBE_SESSION_KEY_EGRESS_PROXY must be at least ${MIN_KEY_LENGTH} characters`,
    ),
  /** Destination ports a sandbox may CONNECT to (HTTPS only by default). */
  KOBE_EGRESS_ALLOWED_PORTS: list,
  /** Internal targets explicitly allowed (CIDRs); still subject to the domain allowlist. */
  KOBE_EGRESS_ALLOWED_INTERNAL_CIDRS: list,
  /** Cluster pod/Service CIDRs and other ranges to refuse beyond the built-in private ranges. */
  KOBE_EGRESS_DENIED_CIDRS: list,
  KOBE_EGRESS_MAX_CONNECTIONS_PER_SANDBOX: int(
    "KOBE_EGRESS_MAX_CONNECTIONS_PER_SANDBOX",
    1,
    10_000,
    64,
  ),
  KOBE_EGRESS_MAX_CONNECTIONS: int("KOBE_EGRESS_MAX_CONNECTIONS", 1, 100_000, 4_096),
  /** Per sandbox, both directions together; 0 disables the limit. */
  KOBE_EGRESS_BANDWIDTH_BYTES_PER_SECOND: int(
    "KOBE_EGRESS_BANDWIDTH_BYTES_PER_SECOND",
    0,
    10_000_000_000,
    20 * 1024 * 1024,
  ),
  KOBE_EGRESS_IDLE_TIMEOUT_MS: int("KOBE_EGRESS_IDLE_TIMEOUT_MS", 1_000, 86_400_000, 300_000),
  /** Request head and TLS ClientHello must arrive within this. */
  KOBE_EGRESS_HANDSHAKE_TIMEOUT_MS: int("KOBE_EGRESS_HANDSHAKE_TIMEOUT_MS", 100, 120_000, 10_000),
  /** Request-head deadline before authentication (slow-loris bound). */
  KOBE_EGRESS_PREAUTH_TIMEOUT_MS: int("KOBE_EGRESS_PREAUTH_TIMEOUT_MS", 100, 60_000, 5_000),
  /** Unauthenticated sockets per source address (one sandbox pod = one address) and in total. */
  KOBE_EGRESS_PREAUTH_PER_SOURCE: int("KOBE_EGRESS_PREAUTH_PER_SOURCE", 1, 10_000, 16),
  KOBE_EGRESS_PREAUTH_TOTAL: int("KOBE_EGRESS_PREAUTH_TOTAL", 1, 100_000, 1_024),
  /** Longest tunnel lifetime; tunnels also close when their session token expires. */
  KOBE_EGRESS_MAX_TUNNEL_SECONDS: int("KOBE_EGRESS_MAX_TUNNEL_SECONDS", 1, 86_400, 3_600),
  /** How often open tunnels are re-checked against the allowlist and membership. */
  KOBE_EGRESS_RECHECK_MS: int("KOBE_EGRESS_RECHECK_MS", 1_000, 3_600_000, 30_000),
  KOBE_EGRESS_CONNECT_TIMEOUT_MS: int("KOBE_EGRESS_CONNECT_TIMEOUT_MS", 100, 120_000, 10_000),
  KOBE_EGRESS_DNS_TIMEOUT_MS: int("KOBE_EGRESS_DNS_TIMEOUT_MS", 100, 60_000, 3_000),
  KOBE_EGRESS_CACHE_TTL_MS: int("KOBE_EGRESS_CACHE_TTL_MS", 1_000, 3_600_000, 60_000),
  KOBE_EGRESS_AUDIT_FLUSH_MS: int("KOBE_EGRESS_AUDIT_FLUSH_MS", 1_000, 3_600_000, 60_000),
});

export interface Config {
  readonly port: number;
  readonly databaseUrl: string;
  readonly sessionKey: string;
  readonly allowedPorts: readonly number[];
  readonly allowedInternalCidrs: readonly string[];
  readonly deniedCidrs: readonly string[];
  readonly maxConnectionsPerSandbox: number;
  readonly maxConnections: number;
  readonly bandwidthBytesPerSecond: number;
  readonly idleTimeoutMs: number;
  readonly handshakeTimeoutMs: number;
  readonly connectTimeoutMs: number;
  readonly preAuthTimeoutMs: number;
  readonly preAuthPerSource: number;
  readonly preAuthTotal: number;
  readonly maxTunnelMs: number;
  readonly recheckMs: number;
  readonly dnsTimeoutMs: number;
  readonly cacheTtlMs: number;
  readonly auditFlushMs: number;
}

export function loadConfig(env: Readonly<Record<string, string | undefined>>): Config {
  const parsed = configSchema.safeParse(env);
  if (!parsed.success) {
    // Messages name the variable; values are never echoed (the session key is a secret).
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid configuration: ${issues}`);
  }
  const c = parsed.data;
  const ports = c.KOBE_EGRESS_ALLOWED_PORTS.length > 0 ? c.KOBE_EGRESS_ALLOWED_PORTS : ["443"];
  const allowedPorts = ports.map((p) => {
    const n = Number(p);
    if (!Number.isInteger(n) || n < 1 || n > 65535) {
      throw new Error(`Invalid configuration: KOBE_EGRESS_ALLOWED_PORTS has an invalid port`);
    }
    return n;
  });
  for (const [name, cidrs] of [
    ["KOBE_EGRESS_ALLOWED_INTERNAL_CIDRS", c.KOBE_EGRESS_ALLOWED_INTERNAL_CIDRS],
    ["KOBE_EGRESS_DENIED_CIDRS", c.KOBE_EGRESS_DENIED_CIDRS],
  ] as const) {
    try {
      validateCidrs(cidrs);
    } catch (err) {
      throw new Error(`Invalid configuration: ${name}: ${(err as Error).message}`, { cause: err });
    }
  }
  return {
    port: c.PORT,
    databaseUrl: c.KOBE_DATABASE_URL,
    sessionKey: c.KOBE_SESSION_KEY_EGRESS_PROXY,
    allowedPorts,
    allowedInternalCidrs: c.KOBE_EGRESS_ALLOWED_INTERNAL_CIDRS,
    deniedCidrs: c.KOBE_EGRESS_DENIED_CIDRS,
    maxConnectionsPerSandbox: c.KOBE_EGRESS_MAX_CONNECTIONS_PER_SANDBOX,
    maxConnections: c.KOBE_EGRESS_MAX_CONNECTIONS,
    bandwidthBytesPerSecond: c.KOBE_EGRESS_BANDWIDTH_BYTES_PER_SECOND,
    idleTimeoutMs: c.KOBE_EGRESS_IDLE_TIMEOUT_MS,
    handshakeTimeoutMs: c.KOBE_EGRESS_HANDSHAKE_TIMEOUT_MS,
    connectTimeoutMs: c.KOBE_EGRESS_CONNECT_TIMEOUT_MS,
    preAuthTimeoutMs: c.KOBE_EGRESS_PREAUTH_TIMEOUT_MS,
    preAuthPerSource: c.KOBE_EGRESS_PREAUTH_PER_SOURCE,
    preAuthTotal: c.KOBE_EGRESS_PREAUTH_TOTAL,
    maxTunnelMs: c.KOBE_EGRESS_MAX_TUNNEL_SECONDS * 1000,
    recheckMs: c.KOBE_EGRESS_RECHECK_MS,
    dnsTimeoutMs: c.KOBE_EGRESS_DNS_TIMEOUT_MS,
    cacheTtlMs: c.KOBE_EGRESS_CACHE_TTL_MS,
    auditFlushMs: c.KOBE_EGRESS_AUDIT_FLUSH_MS,
  };
}
