import path from "node:path";
import { KOBE_TOOLS_FD, type PiThreadConfig, type RunMcpContext } from "@kobe/protocol";
import { EXEC_FD, EXEC_FD_ENV } from "../kobe-exec/protocol.js";

/**
 * How a thread's `pi --mode rpc` process is started.
 *
 * Environment: built from an allow-list, never inherited. The agent's own environment (server URL,
 * sandbox id, token file path, anything a pod spec adds) does not reach Pi or the tools Pi runs. No
 * provider or MCP credential exists in the sandbox at all (D13, D27, D30); model gateway and MCP
 * proxy wiring belong to KOBE-41 / KOBE-62 and arrive as further allow-listed, credential-free
 * variables or flags.
 *
 * Lockdown (verified against Pi 1.0.0 `--help` and a real-Pi test): model-run code can write
 * `$HOME` and `/workspace`, so Pi must not load anything from there. Pi's config directory
 * (`PI_CODING_AGENT_DIR`, where Pi reads user extensions, `settings.json` incl.
 * `defaultProjectTrust`, `mcp.json`, `AGENTS.md`, and writes `auth.json`) is a private directory
 * created fresh for each Pi process right before it starts and removed when it exits
 * (threads/thread.ts; Pi 1.0.0 writes `auth.json` and a lock there on every credential read, so it
 * cannot be read-only). `--no-extensions` stops extension discovery and built-ins (explicit `-e`
 * paths still load: that is how kobe-policy, KOBE-36, and kobe-models, KOBE-41, are added, from
 * root-owned paths); `--no-approve` ignores project-local
 * `.pi/` files; `--no-context-files` stops `AGENTS.md`/`CLAUDE.md` discovery (Kobe's instructions
 * come from agent files, D19; a model-written AGENTS.md would otherwise be a persistent prompt
 * injection across threads); `--no-skills` / `--no-prompt-templates` / `--no-themes` stop discovery.
 * Skills (KOBE-82) are registered the one way Pi 1.0.0 documents for explicit paths: one repeatable
 * `--skill <dir>` per effective skill (explicit paths still load under `--no-skills`, like `-e`
 * under `--no-extensions`); the directories are the agent's read-only skills store, never anything
 * under `$HOME` or `/workspace`.
 */
export const POLICY_CHANNEL_FD = 3;
/** The kobe-tools channel (KOBE-128, artifacts.ts): fd 4, only when the extension is loaded. */
export const TOOLS_CHANNEL_FD = KOBE_TOOLS_FD;
/** The kobe-exec channel (KOBE-167, kobe-exec/protocol.ts): fd 5, only when the extension is loaded. */
export const EXEC_CHANNEL_FD = EXEC_FD;

export const PI_LOCKDOWN_ARGS = [
  "--no-extensions",
  "--no-approve",
  "--no-context-files",
  "--no-skills",
  "--no-prompt-templates",
  "--no-themes",
] as const;

const INHERITED_ENV = ["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "TMPDIR"] as const;

export interface PiLaunch {
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  /** Identity of the launch: a running process with a different key is restarted when idle. */
  readonly key: string;
  /** Pi gets the kobe-tools channel as its fd 4 (the process is spawned with a fifth pipe). */
  readonly toolsChannel: boolean;
  /** Pi gets the kobe-exec channel as its fd 5 (the process is spawned with a sixth pipe). */
  readonly execChannel: boolean;
  /**
   * The agent's system prompt (KOBE-123), when the run has a non-empty one. Never an argument: the
   * thread writes it to a file in Pi's runtime directory at spawn and adds
   * `--append-system-prompt <file>` (pi/system-prompt-file.ts), so it is neither in `ps` nor bound
   * by the argument size limit.
   */
  readonly systemPrompt?: string;
  /**
   * The run's effective MCP connectors (KOBE-111), only when there are some: the thread writes
   * Pi's `mcp.json` from it (mcp/pi-mcp-config.ts) and Pi loads `builtin:mcp`.
   */
  readonly mcp?: RunMcpContext;
  /**
   * Pi gets a per-run memory file (KOBE-157, memory/context-file.ts): the thread creates it at spawn
   * and rewrites it before every prompt, so memory changes never change the launch key.
   */
  readonly memoryFile: boolean;
}

export interface PiLaunchInput {
  readonly sessionFile: string;
  readonly home: string;
  /**
   * kobe-models (KOBE-41): a root-owned, read-only file, loaded right before kobe-policy when the
   * sandbox has model gateway access. The model itself is not a launch argument: it travels in the
   * per-process model file, so a model change between runs never restarts Pi.
   */
  readonly modelsExtension?: string | undefined;
  /**
   * kobe-tools (KOBE-128): a root-owned, read-only file that registers Kobe's own tools, loaded
   * right before kobe-policy (which therefore checks its calls) and given the channel on fd 4.
   * Absent: no fd 4, no tools (the agent then does not announce the `artifacts` capability).
   */
  readonly toolsExtension?: string | undefined;
  /**
   * kobe-exec (KOBE-167): a root-owned, read-only file that replaces Pi's seven built-in tools with
   * ones that run in the thread's executor (its partner uid), loaded right before kobe-policy and
   * given the channel on fd 5. Absent: Pi runs its tools itself, as before.
   */
  readonly execExtension?: string | undefined;
  /**
   * The agent announced the `files` capability (KOBE-149): the extension then registers
   * `share_file`. Meaningful only with {@link toolsExtension}.
   */
  readonly toolsFiles?: boolean | undefined;
  /**
   * The agent announced the `projects` capability (KOBE-162): the extension then registers
   * `propose_project_file`. Meaningful only with {@link toolsExtension}.
   */
  readonly toolsProjects?: boolean | undefined;
  /**
   * The agent announced the `memory` capability (KOBE-157): the extension then registers `remember`
   * and `recall`. Meaningful only with {@link toolsExtension}.
   */
  readonly toolsMemory?: boolean | undefined;
  /**
   * The kobe-policy extension (KOBE-36): a root-owned, read-only file. Always loaded, always the
   * **last** `-e`: Pi runs `tool_call` handlers in extension load order (verified Pi 1.0.0), so the
   * last one sees the final, possibly mutated input, and nobody can change it after the check.
   */
  readonly policyExtension: string;
  /**
   * Other extensions to load with `-e`, before kobe-policy (e.g. `builtin:mcp`, KOBE-62). Must be
   * root-owned paths outside anything the sandbox user can write, or `builtin:<name>`.
   */
  readonly extensions?: readonly string[];
  /**
   * Skill directories to register, one `--skill` each (KOBE-82): the run's effective skills as
   * materialized by the skills store. Exactly these, in this order.
   */
  readonly skillDirs?: readonly string[];
  /** `run.start.mcp` (KOBE-111): when it lists servers Pi gets `builtin:mcp` and a per-session `mcp.json`. */
  readonly mcp?: RunMcpContext | undefined;
  readonly parentEnv: Readonly<Record<string, string | undefined>>;
  readonly config?: PiThreadConfig | undefined;
}

export function buildPiLaunch(input: PiLaunchInput): PiLaunch {
  const args = ["--mode", "rpc", "--session", input.sessionFile, ...PI_LOCKDOWN_ARGS];
  const policy = path.resolve(input.policyExtension);
  const models =
    input.modelsExtension === undefined ? undefined : path.resolve(input.modelsExtension);
  const tools = input.toolsExtension === undefined ? undefined : path.resolve(input.toolsExtension);
  const exec = input.execExtension === undefined ? undefined : path.resolve(input.execExtension);
  const mcp = input.mcp !== undefined && input.mcp.servers.length > 0 ? input.mcp : undefined;
  if (mcp !== undefined) args.push("--extension", "builtin:mcp");
  for (const extension of input.extensions ?? []) {
    // kobe-policy only once, last: a second copy would find the channel taken and block everything.
    const resolved = extension.startsWith("builtin:") ? undefined : path.resolve(extension);
    if (extension === "builtin:mcp" && mcp !== undefined) continue;
    if (
      resolved !== undefined &&
      (resolved === policy || resolved === models || resolved === tools || resolved === exec)
    )
      continue;
    args.push("--extension", extension);
  }
  if (input.modelsExtension !== undefined) args.push("--extension", input.modelsExtension);
  if (input.toolsExtension !== undefined) args.push("--extension", input.toolsExtension);
  if (input.execExtension !== undefined) args.push("--extension", input.execExtension);
  args.push("--extension", input.policyExtension);
  for (const dir of input.skillDirs ?? []) args.push("--skill", path.resolve(dir));
  const config = input.config;
  if (config?.thinking_level !== undefined) args.push("--thinking", config.thinking_level);
  // Seams (not wired here): model alias → KOBE-41, mcp_servers → KOBE-62. The system prompt is
  // wired at spawn (see `PiLaunch.systemPrompt`). All change `key`, so a thread restarts Pi when
  // its config changes.

  const env: Record<string, string> = {};
  for (const name of INHERITED_ENV) {
    const value = input.parentEnv[name];
    if (value !== undefined) env[name] = value;
  }
  env.PATH ??= "/usr/local/bin:/usr/bin:/bin";
  env.HOME = input.home;
  // PI_CODING_AGENT_DIR and KOBE_MODEL_FILE name per-process paths: the thread adds them at spawn.
  env.PI_SKIP_VERSION_CHECK = "1";
  env.PI_TELEMETRY = "0";
  env.PI_OFFLINE = "1";
  // Pi is a Node process the tools it runs can signal: SIGUSR1 must not open an inspector in it.
  env.NODE_OPTIONS = "--disable-sigusr1";
  // Pi must not run code another uid could have left for it (KOBE-196): no jiti transpile cache
  // (`$TMPDIR/jiti`, trusted by file name and a hash of public source) and no V8 compile cache.
  env.JITI_FS_CACHE = "false";
  env.NODE_DISABLE_COMPILE_CACHE = "1";
  env.KOBE_POLICY_FD = String(POLICY_CHANNEL_FD);
  if (input.toolsExtension !== undefined) env.KOBE_TOOLS_FD = String(TOOLS_CHANNEL_FD);
  if (input.execExtension !== undefined) env[EXEC_FD_ENV] = String(EXEC_CHANNEL_FD);
  if (input.toolsExtension !== undefined && input.toolsFiles === true) env.KOBE_TOOLS_FILES = "1";
  if (input.toolsExtension !== undefined && input.toolsProjects === true)
    env.KOBE_TOOLS_PROJECTS = "1";
  if (input.toolsExtension !== undefined && input.toolsMemory === true) env.KOBE_TOOLS_MEMORY = "1";

  // The model is deliberately not part of the key (see `modelsExtension`).
  const key = JSON.stringify({
    args,
    agent: config?.agent ?? null,
    system_prompt: config?.system_prompt ?? null,
    skills: config?.skills ?? null,
    skill_bundles: config?.skill_bundles ?? null,
    builtin_skills: config?.builtin_skills ?? null,
    mcp_servers: config?.mcp_servers ?? null,
    mcp: mcp ?? null,
  });
  const systemPrompt = config?.system_prompt;
  return {
    args,
    env,
    key,
    memoryFile: input.toolsExtension !== undefined && input.toolsMemory === true,
    toolsChannel: input.toolsExtension !== undefined,
    execChannel: input.execExtension !== undefined,
    ...(mcp === undefined ? {} : { mcp }),
    ...(systemPrompt === undefined || systemPrompt === "" ? {} : { systemPrompt }),
  };
}
