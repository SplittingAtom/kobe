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
  /** Required unless KOBE_BOOTSTRAP_TOKEN_FILE is set (then the server names the sandbox). */
  KOBE_SANDBOX_ID: uuidSchema.optional(),
  /**
   * File holding the `kobe.sandbox-wire` session token (a projected/mounted secret). Re-read on every
   * dial so a rotated token is picked up. A file, not an env var, so it is never inherited by Pi.
   */
  KOBE_SANDBOX_TOKEN_FILE: z.string().startsWith("/").default("/var/run/kobe/sandbox-wire/token"),
  /**
   * Kobe's sandbox pods (KOBE-22): the projected bootstrap token, traded at the server for the
   * sandbox id and its session tokens (session/exchange.ts). Takes precedence over the two above.
   */
  KOBE_BOOTSTRAP_TOKEN_FILE: z.string().startsWith("/").optional(),
  KOBE_WORKSPACE_DIR: z.string().startsWith("/").default("/workspace"),
  /** Pi session JSONL per thread; on the workspace volume so it survives hibernation (D13/D15). */
  KOBE_SESSION_DIR: z.string().startsWith("/").default("/workspace/.kobe/sessions"),
  KOBE_PI_BIN: z.string().min(1).default("pi"),
  /**
   * Where each Pi process gets its private runtime directory (its `PI_CODING_AGENT_DIR`, which Pi
   * 1.0.0 must be able to write, and its model file): created fresh per process, removed when it
   * exits. On the emptyDir that hibernation wipes (D12).
   */
  KOBE_PI_RUNTIME_DIR: z.string().startsWith("/").default("/tmp/kobe-pi"),
  /**
   * The model gateway (KOBE-40 shim) as sandbox pods see it; set by the server's pod spec when
   * the sandbox may reach models. Without it Pi has no model (runs fail `model_not_configured`).
   */
  KOBE_MODEL_GATEWAY_URL: z
    .url({ protocol: /^https?$/, error: "KOBE_MODEL_GATEWAY_URL must be an http(s) URL" })
    .refine((url) => {
      const parsed = new URL(url);
      return parsed.username === "" && parsed.password === "" && parsed.pathname === "/";
    }, "KOBE_MODEL_GATEWAY_URL must be a plain origin without credentials")
    .optional(),
  /** kobe-models (KOBE-41): root-owned, read-only, loaded before kobe-policy when models are wired. */
  KOBE_MODELS_EXTENSION: z
    .string()
    .startsWith("/")
    .default("/opt/kobe/pi-extensions/kobe-models/index.js"),
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
  /**
   * KOBE-27: push /workspace changes to the server this often (and restore at start, pull before
   * runs). Set by the server's pod spec; 0 (the default outside Kobe pods) turns sync off.
   */
  KOBE_WORKSPACE_SYNC_INTERVAL_MS: z.coerce.number().int().min(0).max(3_600_000).default(0),
});

export interface Config {
  /** Server base URL the agent dials out to; sandboxes accept no inbound connections. */
  readonly serverUrl: string;
  /** `serverUrl` with the contract path ({@link SANDBOX_WS_PATH}). */
  readonly connectUrl: string;
  /** Known up front, or (bootstrap mode) once the first session trade succeeded. */
  readonly sandboxId: string;
  readonly tokenFile: string;
  /** Bootstrap mode: trade this token for the sandbox id and session tokens. */
  readonly bootstrapTokenFile?: string;
  readonly workspaceDir: string;
  readonly sessionDir: string;
  readonly piBin: string;
  readonly piRuntimeDir: string;
  /** The model gateway origin (`http://host[:port]`, no trailing slash), when the pod has one. */
  readonly modelGatewayUrl?: string;
  readonly modelsExtension: string;
  readonly policyExtension: string;
  readonly maxPiProcesses: number;
  readonly piIdleMs: number;
  readonly outboxMaxBytes: number;
  readonly restoreMaxBytes: number;
  /** 0 = workspace sync off. */
  readonly workspaceSyncIntervalMs: number;
}

export function loadConfig(env: Readonly<Record<string, string | undefined>>): Config {
  const parsed = configSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid configuration: ${issues}`);
  }
  const c = parsed.data;
  if (c.KOBE_SANDBOX_ID === undefined && c.KOBE_BOOTSTRAP_TOKEN_FILE === undefined) {
    throw new Error(
      "Invalid configuration: KOBE_SANDBOX_ID: required unless KOBE_BOOTSTRAP_TOKEN_FILE is set",
    );
  }
  const connect = new URL(SANDBOX_WS_PATH, c.KOBE_SERVER_URL);
  return {
    serverUrl: c.KOBE_SERVER_URL,
    connectUrl: connect.toString(),
    // Bootstrap mode: replaced by the server-assigned id before the agent starts (index.ts).
    sandboxId: c.KOBE_SANDBOX_ID ?? "",
    tokenFile: c.KOBE_SANDBOX_TOKEN_FILE,
    ...(c.KOBE_BOOTSTRAP_TOKEN_FILE === undefined
      ? {}
      : { bootstrapTokenFile: c.KOBE_BOOTSTRAP_TOKEN_FILE }),
    workspaceDir: c.KOBE_WORKSPACE_DIR,
    sessionDir: c.KOBE_SESSION_DIR,
    piBin: c.KOBE_PI_BIN,
    piRuntimeDir: c.KOBE_PI_RUNTIME_DIR,
    ...(c.KOBE_MODEL_GATEWAY_URL === undefined
      ? {}
      : { modelGatewayUrl: new URL(c.KOBE_MODEL_GATEWAY_URL).origin }),
    modelsExtension: c.KOBE_MODELS_EXTENSION,
    policyExtension: c.KOBE_POLICY_EXTENSION,
    maxPiProcesses: c.KOBE_MAX_PI_PROCESSES,
    piIdleMs: c.KOBE_PI_IDLE_MS,
    outboxMaxBytes: c.KOBE_OUTBOX_MAX_BYTES,
    restoreMaxBytes: c.KOBE_RESTORE_MAX_BYTES,
    workspaceSyncIntervalMs: c.KOBE_WORKSPACE_SYNC_INTERVAL_MS,
  };
}
