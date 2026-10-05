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
   * Where the run's effective skills are materialized (KOBE-82): a directory only the agent
   * writes, readable by the Pi uids. Kobe's pod spec mounts a memory-backed volume (sticky root,
   * like the Pi runtime directories). Unset: this sandbox cannot materialize skills.
   */
  KOBE_SKILLS_DIR: z.string().startsWith("/").optional(),
  /**
   * Where the image's built-in gallery skills live (KOBE-88), root-owned and read-only; set by the
   * image (`/opt/kobe/skills`). Unset: this sandbox cannot register built-in skills.
   */
  KOBE_BUILTIN_SKILLS_DIR: z.string().startsWith("/").optional(),
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
  /**
   * The egress proxy as sandbox pods see it (KOBE-38; set by the server's pod spec, with the port).
   * With a bootstrap session, Pi's tools get it through the BASH_ENV script (KOBE-39).
   */
  KOBE_EGRESS_PROXY_URL: z
    .url({ protocol: /^http$/, error: "KOBE_EGRESS_PROXY_URL must be an http:// URL" })
    .refine((url) => {
      const parsed = new URL(url);
      return parsed.username === "" && parsed.password === "" && parsed.pathname === "/";
    }, "KOBE_EGRESS_PROXY_URL must be a plain origin without credentials")
    .optional(),
  /** The root-owned BASH_ENV script that exports the proxy variables from the token file. */
  KOBE_EGRESS_ENV_SCRIPT: z.string().startsWith("/").default("/opt/kobe/egress-env.sh"),
  /** Hosts tools reach without the proxy (the pod's NO_PROXY); passed to Pi with the proxy. */
  NO_PROXY: z
    .string()
    .max(2048)
    .regex(/^[A-Za-z0-9.,:*_-]*$/, "NO_PROXY must be a list of host names")
    .default("localhost,127.0.0.1"),
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
  /**
   * KOBE-71: the image's `kobe-runas` helper. Set (by Kobe's pod spec), every Pi process runs as
   * a Pi identity of its own (the agent's supplementary groups 2000-2063), and the agent refuses
   * to start when it cannot do that. Unset (development, tests): Pi runs as the agent's uid.
   */
  KOBE_PI_RUNAS: z.string().startsWith("/").optional(),
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
  /** Where effective skills are materialized (KOBE-82); undefined = not supported here. */
  readonly skillsDir?: string;
  /** Where the image's built-in skills live (KOBE-88); undefined = not supported here. */
  readonly builtinSkillsDir?: string;
  /** The model gateway origin (`http://host[:port]`, no trailing slash), when the pod has one. */
  readonly modelGatewayUrl?: string;
  readonly modelsExtension: string;
  /** The egress proxy origin with its port (`http://host:port`), when the pod has one. */
  readonly egressProxyUrl?: string;
  readonly egressEnvScript: string;
  readonly noProxy: string;
  readonly policyExtension: string;
  /** KOBE-71: the Pi identity helper; undefined = Pi runs as the agent's uid. */
  readonly piRunAs?: string;
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
    ...(c.KOBE_SKILLS_DIR === undefined ? {} : { skillsDir: c.KOBE_SKILLS_DIR }),
    ...(c.KOBE_BUILTIN_SKILLS_DIR === undefined
      ? {}
      : { builtinSkillsDir: c.KOBE_BUILTIN_SKILLS_DIR }),
    ...(c.KOBE_MODEL_GATEWAY_URL === undefined
      ? {}
      : { modelGatewayUrl: new URL(c.KOBE_MODEL_GATEWAY_URL).origin }),
    modelsExtension: c.KOBE_MODELS_EXTENSION,
    ...(c.KOBE_EGRESS_PROXY_URL === undefined
      ? {}
      : { egressProxyUrl: egressOrigin(c.KOBE_EGRESS_PROXY_URL) }),
    egressEnvScript: c.KOBE_EGRESS_ENV_SCRIPT,
    noProxy: c.NO_PROXY,
    policyExtension: c.KOBE_POLICY_EXTENSION,
    ...(c.KOBE_PI_RUNAS === undefined ? {} : { piRunAs: c.KOBE_PI_RUNAS }),
    maxPiProcesses: c.KOBE_MAX_PI_PROCESSES,
    piIdleMs: c.KOBE_PI_IDLE_MS,
    outboxMaxBytes: c.KOBE_OUTBOX_MAX_BYTES,
    restoreMaxBytes: c.KOBE_RESTORE_MAX_BYTES,
    workspaceSyncIntervalMs: c.KOBE_WORKSPACE_SYNC_INTERVAL_MS,
  };
}

/** `http://host:port` with the port always written (curl assumes 1080 for a proxy without one). */
function egressOrigin(raw: string): string {
  const url = new URL(raw);
  return `http://${url.hostname}:${url.port === "" ? "80" : url.port}`;
}
