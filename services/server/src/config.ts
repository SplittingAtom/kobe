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
});

export interface Config {
  readonly port: number;
  readonly process: "server" | "scheduler";
}

export function loadConfig(env: Readonly<Record<string, string | undefined>>): Config {
  const parsed = configSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid configuration: ${issues}`);
  }
  return { port: parsed.data.PORT, process: parsed.data.KOBE_PROCESS };
}
