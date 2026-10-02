import { z } from "zod";

const configSchema = z.object({
  PORT: z.coerce
    .number({ error: "PORT must be a number" })
    .int("PORT must be an integer")
    .min(1, "PORT must be between 1 and 65535")
    .max(65535, "PORT must be between 1 and 65535")
    .default(8080),
  // One image, two processes: the API server and the Postgres-leased scheduler (spec D32).
  KOBE_PROCESS: z
    .enum(["server", "scheduler"], { error: "KOBE_PROCESS must be server or scheduler" })
    .default("server"),
  // App-role connection (never the owner); team data is reachable only through withTeam().
  KOBE_DATABASE_URL: z.url({
    protocol: /^postgres(ql)?$/,
    error: "KOBE_DATABASE_URL must be a postgres:// URL",
  }),
  // RuntimeClass sandboxes run under; the isolation gate verifies its handler (spec D4). Unset
  // keeps the server up with agents disabled, so the admin console can show the fix.
  KOBE_RUNTIME_CLASS: z
    .string()
    .trim()
    .transform((v) => (v === "" ? undefined : v))
    .pipe(
      z
        .string()
        .max(253)
        .regex(/^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/, "KOBE_RUNTIME_CLASS must be a RuntimeClass name")
        .optional(),
    )
    .optional(),
});

/** Auth settings: required by the API server only (the scheduler never sees these secrets). */
const authSchema = z.object({
  // Public origin of the install: cookie scope and the WebAuthn relying party.
  KOBE_PUBLIC_URL: z
    .url({ protocol: /^https?$/, error: "KOBE_PUBLIC_URL must be an http(s) URL" })
    .refine(
      (u) => URL.canParse(u) && new URL(u).pathname === "/",
      "KOBE_PUBLIC_URL must be an origin without a path",
    )
    .transform((u) => new URL(u).origin),
  KOBE_AUTH_SECRET: z.string().min(32, "KOBE_AUTH_SECRET must be at least 32 characters"),
  KOBE_SETUP_TOKEN: z.string().min(24, "KOBE_SETUP_TOKEN must be at least 24 characters"),
  // Comma-separated CIDRs of the proxies in front of the server (Traefik / load balancer).
  KOBE_TRUSTED_PROXIES: z
    .string()
    .default("")
    .transform((v) =>
      v
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    )
    .pipe(z.array(z.cidrv4().or(z.cidrv6()), { error: "KOBE_TRUSTED_PROXIES must be CIDRs" })),
});

export interface AuthConfig {
  readonly publicUrl: string;
  readonly authSecret: string;
  readonly setupToken: string;
  readonly trustedProxies: readonly string[];
}

export interface Config {
  readonly port: number;
  readonly process: "server" | "scheduler";
  readonly databaseUrl: string;
  /** Sandbox RuntimeClass; undefined means agents stay disabled. */
  readonly runtimeClassName: string | undefined;
  /** Present for the API server only. */
  readonly auth?: AuthConfig;
}

function fail(error: z.ZodError): never {
  // Messages only (never input values), so secrets can't leak into logs.
  const issues = error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
  throw new Error(`Invalid configuration: ${issues}`);
}

export function loadConfig(env: Readonly<Record<string, string | undefined>>): Config {
  const base = configSchema.safeParse(env);
  if (!base.success) fail(base.error);
  const config = {
    port: base.data.PORT,
    process: base.data.KOBE_PROCESS,
    databaseUrl: base.data.KOBE_DATABASE_URL,
    runtimeClassName: base.data.KOBE_RUNTIME_CLASS,
  };
  if (config.process !== "server") return config;
  const auth = authSchema.safeParse(env);
  if (!auth.success) fail(auth.error);
  return {
    ...config,
    auth: {
      publicUrl: auth.data.KOBE_PUBLIC_URL,
      authSecret: auth.data.KOBE_AUTH_SECRET,
      setupToken: auth.data.KOBE_SETUP_TOKEN,
      trustedProxies: auth.data.KOBE_TRUSTED_PROXIES,
    },
  };
}
