import { MIN_SECRET_LENGTH } from "@kobe/db";
import { z } from "zod";

/**
 * Model gateway settings (KOBE-40), validated at startup. All unset: models are not configured
 * (development without the chart); the admin API then refuses provider keys and nothing syncs.
 * Partly set is an error (fail fast). The chart renders every variable.
 */
export interface ModelsConfig {
  /** Bifrost's admin/inference base URL (the in-cluster Service). */
  readonly bifrostUrl: string;
  readonly adminUsername: string;
  readonly adminPassword: string;
  /** Seals provider API keys in Postgres (server only); current first, then a previous one. */
  readonly providerKeySecrets: readonly string[];
  /** Seals the members' Bifrost virtual keys (server and shim); current first, then previous. */
  readonly virtualKeySecrets: readonly string[];
  /**
   * Operator switch (Helm `bifrost.allowUnsafeProviderEndpoints`, never the admin API): lets
   * vendor providers take a base URL and keyed providers a plain-http endpoint. Test installs only.
   */
  readonly allowUnsafeEndpoints: boolean;
  /** Full reconcile period, besides change hints. */
  readonly syncIntervalMs: number;
}

const secret = (name: string) =>
  z
    .string({ error: `${name} is required` })
    .min(MIN_SECRET_LENGTH, `${name} must be at least ${MIN_SECRET_LENGTH} characters`);

/** A previous secret kept for opening values sealed before a rotation; empty: none. */
const optionalSecret = (name: string) =>
  z
    .string()
    .default("")
    .refine(
      (v) => v === "" || v.length >= MIN_SECRET_LENGTH,
      `${name} must be at least ${MIN_SECRET_LENGTH} characters`,
    );

const schema = z.object({
  KOBE_BIFROST_URL: z.url({
    protocol: /^https?$/,
    error: "KOBE_BIFROST_URL must be an http(s) URL",
  }),
  KOBE_BIFROST_ADMIN_USERNAME: z
    .string()
    .regex(/^[A-Za-z0-9_.-]{1,64}$/, "KOBE_BIFROST_ADMIN_USERNAME must be a plain user name")
    .default("kobe"),
  KOBE_BIFROST_ADMIN_PASSWORD: secret("KOBE_BIFROST_ADMIN_PASSWORD"),
  KOBE_MODELS_PROVIDER_KEY_SECRET: secret("KOBE_MODELS_PROVIDER_KEY_SECRET"),
  KOBE_MODELS_VIRTUAL_KEY_SECRET: secret("KOBE_MODELS_VIRTUAL_KEY_SECRET"),
  KOBE_MODELS_PROVIDER_KEY_SECRET_PREVIOUS: optionalSecret(
    "KOBE_MODELS_PROVIDER_KEY_SECRET_PREVIOUS",
  ),
  KOBE_MODELS_VIRTUAL_KEY_SECRET_PREVIOUS: optionalSecret(
    "KOBE_MODELS_VIRTUAL_KEY_SECRET_PREVIOUS",
  ),
  KOBE_MODELS_ALLOW_UNSAFE_ENDPOINTS: z
    .enum(["true", "false"], { error: "KOBE_MODELS_ALLOW_UNSAFE_ENDPOINTS must be true or false" })
    .default("false"),
  KOBE_MODELS_SYNC_INTERVAL_MS: z.coerce
    .number({ error: "KOBE_MODELS_SYNC_INTERVAL_MS must be a number" })
    .int()
    .min(1_000, "KOBE_MODELS_SYNC_INTERVAL_MS must be between 1000 and 3600000")
    .max(3_600_000, "KOBE_MODELS_SYNC_INTERVAL_MS must be between 1000 and 3600000")
    .default(30_000),
});

/** The variables whose presence means "models are configured" (the rest have defaults). */
const REQUIRED = [
  "KOBE_BIFROST_URL",
  "KOBE_BIFROST_ADMIN_PASSWORD",
  "KOBE_MODELS_PROVIDER_KEY_SECRET",
  "KOBE_MODELS_VIRTUAL_KEY_SECRET",
] as const;

export function loadModelsConfig(
  env: Readonly<Record<string, string | undefined>>,
): ModelsConfig | undefined {
  if (REQUIRED.every((k) => env[k] === undefined || env[k] === "")) return undefined;
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    // Messages name the variable; values are never echoed (they are secrets).
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid model gateway configuration: ${issues}`);
  }
  const c = parsed.data;
  if (c.KOBE_MODELS_PROVIDER_KEY_SECRET === c.KOBE_MODELS_VIRTUAL_KEY_SECRET) {
    throw new Error(
      "Invalid model gateway configuration: the provider-key and virtual-key secrets must differ",
    );
  }
  return {
    bifrostUrl: c.KOBE_BIFROST_URL,
    adminUsername: c.KOBE_BIFROST_ADMIN_USERNAME,
    adminPassword: c.KOBE_BIFROST_ADMIN_PASSWORD,
    providerKeySecrets: [
      c.KOBE_MODELS_PROVIDER_KEY_SECRET,
      c.KOBE_MODELS_PROVIDER_KEY_SECRET_PREVIOUS,
    ].filter((v) => v !== ""),
    virtualKeySecrets: [
      c.KOBE_MODELS_VIRTUAL_KEY_SECRET,
      c.KOBE_MODELS_VIRTUAL_KEY_SECRET_PREVIOUS,
    ].filter((v) => v !== ""),
    allowUnsafeEndpoints: c.KOBE_MODELS_ALLOW_UNSAFE_ENDPOINTS === "true",
    syncIntervalMs: c.KOBE_MODELS_SYNC_INTERVAL_MS,
  };
}
