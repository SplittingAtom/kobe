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
  /** Seals provider API keys in Postgres (server only). */
  readonly providerKeySecret: string;
  /** Seals the members' Bifrost virtual keys (server and model-gateway shim). */
  readonly virtualKeySecret: string;
  /** Full reconcile period, besides change hints. */
  readonly syncIntervalMs: number;
}

const secret = (name: string) =>
  z
    .string({ error: `${name} is required` })
    .min(MIN_SECRET_LENGTH, `${name} must be at least ${MIN_SECRET_LENGTH} characters`);

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
  KOBE_MODELS_SYNC_INTERVAL_MS: z.coerce
    .number({ error: "KOBE_MODELS_SYNC_INTERVAL_MS must be a number" })
    .int()
    .min(1_000, "KOBE_MODELS_SYNC_INTERVAL_MS must be between 1000 and 3600000")
    .max(3_600_000, "KOBE_MODELS_SYNC_INTERVAL_MS must be between 1000 and 3600000")
    .default(30_000),
});

const KEYS = Object.keys(schema.shape) as (keyof typeof schema.shape)[];

export function loadModelsConfig(
  env: Readonly<Record<string, string | undefined>>,
): ModelsConfig | undefined {
  if (KEYS.every((k) => env[k] === undefined || env[k] === "")) return undefined;
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
    providerKeySecret: c.KOBE_MODELS_PROVIDER_KEY_SECRET,
    virtualKeySecret: c.KOBE_MODELS_VIRTUAL_KEY_SECRET,
    syncIntervalMs: c.KOBE_MODELS_SYNC_INTERVAL_MS,
  };
}
