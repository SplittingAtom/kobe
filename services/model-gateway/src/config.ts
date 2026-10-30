import { MIN_SECRET_LENGTH } from "@kobe/db";
import { verifyKeysFromEnv, type SessionVerifyKeys } from "@kobe/session-token";
import { z } from "zod";

/**
 * Model gateway shim configuration (KOBE-40), validated at startup: invalid env fails fast and
 * messages never echo values. The chart renders it; the shim holds only its audience's public
 * key(s) (session, run and server-call tokens: verify only, KOBE-513/521), the trace-span secret
 * (pseudonymisation only: no credential derives from it, KOBE-521) and the virtual-key secret
 * (never provider keys, never Bifrost's admin password, never a key that mints a credential).
 */
const int = (name: string, min: number, max: number, fallback: number) =>
  z.coerce
    .number({ error: `${name} must be a number` })
    .int(`${name} must be an integer`)
    .min(min, `${name} must be between ${min} and ${max}`)
    .max(max, `${name} must be between ${min} and ${max}`)
    .default(fallback);

const configSchema = z.object({
  PORT: int("PORT", 1, 65535, 8080),
  KOBE_DATABASE_URL: z
    .string({ error: "KOBE_DATABASE_URL is required" })
    .min(1, "KOBE_DATABASE_URL is required"),
  // Shared with the server for `k_trace` (sandbox span id remapping, KOBE-274) and the budget
  // reservation salt; authorises nothing (KOBE-521: run and server-call tokens are Ed25519).
  KOBE_TRACE_SPAN_KEY: z
    .string({ error: "KOBE_TRACE_SPAN_KEY is required" })
    .min(32, "KOBE_TRACE_SPAN_KEY must be at least 32 characters"),
  KOBE_MODELS_VIRTUAL_KEY_SECRET: z
    .string({ error: "KOBE_MODELS_VIRTUAL_KEY_SECRET is required" })
    .min(
      MIN_SECRET_LENGTH,
      `KOBE_MODELS_VIRTUAL_KEY_SECRET must be at least ${MIN_SECRET_LENGTH} characters`,
    ),
  KOBE_BIFROST_URL: z.url({
    protocol: /^https?$/,
    error: "KOBE_BIFROST_URL must be an http(s) URL",
  }),
  /** Request bodies (prompts, images) up to this size. */
  KOBE_MODEL_GATEWAY_MAX_BODY_BYTES: int(
    "KOBE_MODEL_GATEWAY_MAX_BODY_BYTES",
    1024,
    64 * 1024 * 1024,
    8 * 1024 * 1024,
  ),
  /** Request bytes held in memory at once, in total and per sandbox (memory bound). */
  KOBE_MODEL_GATEWAY_INFLIGHT_BYTES: int(
    "KOBE_MODEL_GATEWAY_INFLIGHT_BYTES",
    1024,
    4 * 1024 * 1024 * 1024,
    128 * 1024 * 1024,
  ),
  KOBE_MODEL_GATEWAY_INFLIGHT_BYTES_PER_SANDBOX: int(
    "KOBE_MODEL_GATEWAY_INFLIGHT_BYTES_PER_SANDBOX",
    1024,
    4 * 1024 * 1024 * 1024,
    32 * 1024 * 1024,
  ),
  /** Requests per sandbox: burst, then per second. */
  KOBE_MODEL_GATEWAY_RATE_BURST: int("KOBE_MODEL_GATEWAY_RATE_BURST", 1, 10_000, 60),
  KOBE_MODEL_GATEWAY_RATE_PER_SECOND: int("KOBE_MODEL_GATEWAY_RATE_PER_SECOND", 1, 10_000, 10),
  /** Concurrent model calls per sandbox and per shim replica. */
  KOBE_MODEL_GATEWAY_MAX_CALLS_PER_SANDBOX: int(
    "KOBE_MODEL_GATEWAY_MAX_CALLS_PER_SANDBOX",
    1,
    1_000,
    16,
  ),
  KOBE_MODEL_GATEWAY_MAX_CALLS: int("KOBE_MODEL_GATEWAY_MAX_CALLS", 1, 100_000, 1_024),
  /** A call with no bytes either way for this long is cut. */
  KOBE_MODEL_GATEWAY_IDLE_TIMEOUT_MS: int(
    "KOBE_MODEL_GATEWAY_IDLE_TIMEOUT_MS",
    1_000,
    3_600_000,
    300_000,
  ),
  /** How long membership, sandbox liveness and virtual keys are cached (revocation latency). */
  KOBE_MODEL_GATEWAY_CACHE_TTL_MS: int("KOBE_MODEL_GATEWAY_CACHE_TTL_MS", 0, 60_000, 5_000),
  // KOBE-118: refuse calls without a run token (off while sandbox agents are rolled out).
  KOBE_MODEL_GATEWAY_REQUIRE_RUN_TOKEN: z
    .enum(["true", "false"], {
      error: "KOBE_MODEL_GATEWAY_REQUIRE_RUN_TOKEN must be true or false",
    })
    .default("false"),
  // KOBE-42: how long a member's budget state is reused (spend hints drop it sooner).
  KOBE_MODEL_GATEWAY_BUDGET_CACHE_TTL_MS: int(
    "KOBE_MODEL_GATEWAY_BUDGET_CACHE_TTL_MS",
    0,
    60_000,
    1_000,
  ),
  // KOBE-120: how long a call's budget reservation lives if nothing ends it (a replica that
  // crashed mid-call). Longer than the longest model call; ended reservations are removed at once.
  KOBE_MODEL_GATEWAY_RESERVATION_TTL_MS: int(
    "KOBE_MODEL_GATEWAY_RESERVATION_TTL_MS",
    60_000,
    3_600_000,
    600_000,
  ),
});

export interface Config {
  readonly port: number;
  readonly databaseUrl: string;
  /**
   * The trace-span secret (KOBE_TRACE_SPAN_KEY, KOBE-521): `k_trace` and the budget reservation
   * salt derive from it. A pseudonymisation secret: no credential any service accepts derives
   * from it.
   */
  readonly traceSpanSecret: string;
  /**
   * Public key(s) of the `kobe.model-gateway` pair (KOBE-513/521): session, run and server-call
   * tokens are verified with them; the gateway holds no key that signs any of them.
   */
  readonly sessionVerifyKeys: SessionVerifyKeys;
  readonly virtualKeySecret: string;
  readonly bifrostUrl: string;
  readonly maxBodyBytes: number;
  readonly inflightBytes: number;
  readonly inflightBytesPerSandbox: number;
  readonly rateBurst: number;
  readonly ratePerSecond: number;
  readonly maxCallsPerSandbox: number;
  readonly maxCalls: number;
  readonly idleTimeoutMs: number;
  readonly cacheTtlMs: number;
  readonly budgetCacheTtlMs: number;
  /** Expiry of a budget reservation that nothing ends (crashed replica), KOBE-120. */
  readonly reservationTtlMs: number;
  /** Run token mandatory on every call (KOBE-118 enforcement); default off for rollout. */
  readonly requireRunToken: boolean;
}

/**
 * KOBE-521 ac-1: the gateway must hold nothing that mints a credential the server or the gateway
 * accepts. The retired shared master secret and any session-token private key are refused at
 * startup (an old values file or a hand-edited Deployment), never silently ignored.
 */
function refuseMintingMaterial(env: Readonly<Record<string, string | undefined>>): void {
  const found = Object.keys(env).filter(
    (name) =>
      env[name] !== undefined &&
      (name === "KOBE_SESSION_KEY_MODEL_GATEWAY" || name.startsWith("KOBE_SESSION_SIGNING_KEY_")),
  );
  if (found.length > 0) {
    throw new Error(
      `Invalid configuration: ${found.join(", ")} must not be set on the model gateway: it verifies ` +
        "run and server-call tokens with the public key only (KOBE-521, docs/install.md)",
    );
  }
}

export function loadConfig(env: Readonly<Record<string, string | undefined>>): Config {
  refuseMintingMaterial(env);
  const parsed = configSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid configuration: ${issues}`);
  }
  const c = parsed.data;
  if (
    c.KOBE_MODEL_GATEWAY_INFLIGHT_BYTES_PER_SANDBOX < c.KOBE_MODEL_GATEWAY_MAX_BODY_BYTES ||
    c.KOBE_MODEL_GATEWAY_INFLIGHT_BYTES < c.KOBE_MODEL_GATEWAY_INFLIGHT_BYTES_PER_SANDBOX
  ) {
    throw new Error(
      "Invalid configuration: need max body ≤ in-flight bytes per sandbox ≤ in-flight bytes",
    );
  }
  return {
    port: c.PORT,
    databaseUrl: c.KOBE_DATABASE_URL,
    traceSpanSecret: c.KOBE_TRACE_SPAN_KEY,
    sessionVerifyKeys: verifyKeysFromEnv(env, "kobe.model-gateway"),
    virtualKeySecret: c.KOBE_MODELS_VIRTUAL_KEY_SECRET,
    bifrostUrl: c.KOBE_BIFROST_URL.replace(/\/+$/, ""),
    maxBodyBytes: c.KOBE_MODEL_GATEWAY_MAX_BODY_BYTES,
    inflightBytes: c.KOBE_MODEL_GATEWAY_INFLIGHT_BYTES,
    inflightBytesPerSandbox: c.KOBE_MODEL_GATEWAY_INFLIGHT_BYTES_PER_SANDBOX,
    rateBurst: c.KOBE_MODEL_GATEWAY_RATE_BURST,
    ratePerSecond: c.KOBE_MODEL_GATEWAY_RATE_PER_SECOND,
    maxCallsPerSandbox: c.KOBE_MODEL_GATEWAY_MAX_CALLS_PER_SANDBOX,
    maxCalls: c.KOBE_MODEL_GATEWAY_MAX_CALLS,
    idleTimeoutMs: c.KOBE_MODEL_GATEWAY_IDLE_TIMEOUT_MS,
    cacheTtlMs: c.KOBE_MODEL_GATEWAY_CACHE_TTL_MS,
    budgetCacheTtlMs: c.KOBE_MODEL_GATEWAY_BUDGET_CACHE_TTL_MS,
    reservationTtlMs: c.KOBE_MODEL_GATEWAY_RESERVATION_TTL_MS,
    requireRunToken: c.KOBE_MODEL_GATEWAY_REQUIRE_RUN_TOKEN === "true",
  };
}
