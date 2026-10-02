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
  // Public origin of the install: cookie scope and the WebAuthn relying party.
  KOBE_PUBLIC_URL: z
    .url({ protocol: /^https?$/, error: "KOBE_PUBLIC_URL must be an http(s) URL" })
    .refine(
      (u) => URL.canParse(u) && new URL(u).pathname === "/",
      "KOBE_PUBLIC_URL must be an origin without a path",
    )
    .transform((u) => new URL(u).origin),
  KOBE_AUTH_SECRET: z.string().min(32, "KOBE_AUTH_SECRET must be at least 32 characters"),
});

export interface Config {
  readonly port: number;
  readonly process: "server" | "scheduler";
  readonly databaseUrl: string;
  readonly publicUrl: string;
  readonly authSecret: string;
}

export function loadConfig(env: Readonly<Record<string, string | undefined>>): Config {
  const parsed = configSchema.safeParse(env);
  if (!parsed.success) {
    // Messages only (never input values), so secrets can't leak into logs.
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid configuration: ${issues}`);
  }
  const d = parsed.data;
  return {
    port: d.PORT,
    process: d.KOBE_PROCESS,
    databaseUrl: d.KOBE_DATABASE_URL,
    publicUrl: d.KOBE_PUBLIC_URL,
    authSecret: d.KOBE_AUTH_SECRET,
  };
}
