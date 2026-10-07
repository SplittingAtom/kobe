import { MIN_SECRET_LENGTH } from "@kobe/db";
import { z } from "zod";

/**
 * Model gateway shim configuration (KOBE-40), validated at startup: invalid env fails fast and
 * messages never echo values. The chart renders it; the shim holds only its own session key and
 * the virtual-key secret (never provider keys, never Bifrost's admin password).
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
  KOBE_SESSION_KEY_MODEL_GATEWAY: z
    .string({ error: "KOBE_SESSION_KEY_MODEL_GATEWAY is required" })
    .min(32, "KOBE_SESSION_KEY_MODEL_GATEWAY must be at least 32 characters"),
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
});

export interface Config {
  readonly port: number;
  readonly databaseUrl: string;
  readonly sessionKey: string;
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
  /** Run token mandatory on every call (KOBE-118 enforcement); default off for rollout. */
  readonly requireRunToken: boolean;
}

export function loadConfig(env: Readonly<Record<string, string | undefined>>): Config {
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
    sessionKey: c.KOBE_SESSION_KEY_MODEL_GATEWAY,
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
    requireRunToken: c.KOBE_MODEL_GATEWAY_REQUIRE_RUN_TOKEN === "true",
  };
}
