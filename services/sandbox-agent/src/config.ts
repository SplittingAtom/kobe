import { SANDBOX_WS_PATH, uuidSchema } from "@kobe/protocol";
import { z } from "zod";

const positiveInt = (fallback: number) => z.coerce.number().int().positive().default(fallback);

const configSchema = z.object({
  KOBE_SERVER_URL: z
    .url({ protocol: /^wss?$/, error: "KOBE_SERVER_URL must be a ws:// or wss:// URL" })
    .refine((url) => {
      const parsed = new URL(url);
      return parsed.username === "" && parsed.password === "";
    }, "KOBE_SERVER_URL must not carry credentials"),
  KOBE_SANDBOX_ID: uuidSchema,
  /**
   * File holding the `kobe.sandbox-wire` session token (a projected/mounted secret). Re-read on every
   * dial so a rotated token is picked up. A file, not an env var, so it is never inherited by Pi.
   */
  KOBE_SANDBOX_TOKEN_FILE: z.string().startsWith("/").default("/var/run/kobe/sandbox-wire/token"),
  KOBE_WORKSPACE_DIR: z.string().startsWith("/").default("/workspace"),
  /** Pi session JSONL per thread; on the workspace volume so it survives hibernation (D13/D15). */
  KOBE_SESSION_DIR: z.string().startsWith("/").default("/workspace/.kobe/sessions"),
  KOBE_PI_BIN: z.string().min(1).default("pi"),
  /** Pi's config dir (`PI_CODING_AGENT_DIR`): root-owned, read-only, empty in the image. */
  KOBE_PI_AGENT_DIR: z.string().startsWith("/").default("/opt/kobe/pi-agent"),
  /** kobe-policy (KOBE-36): root-owned, read-only, loaded last into every Pi. No way to omit it. */
  KOBE_POLICY_EXTENSION: z
    .string()
    .startsWith("/")
    .default("/opt/kobe/pi-extensions/kobe-policy/index.js"),
  KOBE_MAX_PI_PROCESSES: positiveInt(8),
  KOBE_PI_IDLE_MS: positiveInt(10 * 60_000),
  /** Un-acked outbound pi.event bytes across all runs before the agent gives up on a run. */
  KOBE_OUTBOX_MAX_BYTES: positiveInt(64 * 1024 * 1024),
  KOBE_RESTORE_MAX_BYTES: positiveInt(512 * 1024 * 1024),
});

export interface Config {
  /** Server base URL the agent dials out to; sandboxes accept no inbound connections. */
  readonly serverUrl: string;
  /** `serverUrl` with the contract path ({@link SANDBOX_WS_PATH}). */
  readonly connectUrl: string;
  readonly sandboxId: string;
  readonly tokenFile: string;
  readonly workspaceDir: string;
  readonly sessionDir: string;
  readonly piBin: string;
  readonly piAgentDir: string;
  readonly policyExtension: string;
  readonly maxPiProcesses: number;
  readonly piIdleMs: number;
  readonly outboxMaxBytes: number;
  readonly restoreMaxBytes: number;
}

export function loadConfig(env: Readonly<Record<string, string | undefined>>): Config {
  const parsed = configSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid configuration: ${issues}`);
  }
  const c = parsed.data;
  const connect = new URL(SANDBOX_WS_PATH, c.KOBE_SERVER_URL);
  return {
    serverUrl: c.KOBE_SERVER_URL,
    connectUrl: connect.toString(),
    sandboxId: c.KOBE_SANDBOX_ID,
    tokenFile: c.KOBE_SANDBOX_TOKEN_FILE,
    workspaceDir: c.KOBE_WORKSPACE_DIR,
    sessionDir: c.KOBE_SESSION_DIR,
    piBin: c.KOBE_PI_BIN,
    piAgentDir: c.KOBE_PI_AGENT_DIR,
    policyExtension: c.KOBE_POLICY_EXTENSION,
    maxPiProcesses: c.KOBE_MAX_PI_PROCESSES,
    piIdleMs: c.KOBE_PI_IDLE_MS,
    outboxMaxBytes: c.KOBE_OUTBOX_MAX_BYTES,
    restoreMaxBytes: c.KOBE_RESTORE_MAX_BYTES,
  };
}
