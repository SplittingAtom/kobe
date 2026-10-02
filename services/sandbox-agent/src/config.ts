import { z } from "zod";

const configSchema = z.object({
  KOBE_SERVER_URL: z.url({
    protocol: /^wss?$/,
    error: "KOBE_SERVER_URL must be a ws:// or wss:// URL",
  }),
});

export interface Config {
  /** Server endpoint the agent dials out to; sandboxes accept no inbound connections. */
  readonly serverUrl: string;
}

export function loadConfig(env: Readonly<Record<string, string | undefined>>): Config {
  const parsed = configSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid configuration: ${issues}`);
  }
  return { serverUrl: parsed.data.KOBE_SERVER_URL };
}
