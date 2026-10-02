import type { PiThreadConfig } from "@kobe/protocol";

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
 * `$HOME` and `/workspace`, so Pi must not load anything from there. Pi's config directory is
 * `PI_CODING_AGENT_DIR`, a root-owned, read-only, empty directory baked into the image (Pi reads
 * user extensions, `settings.json` incl. `defaultProjectTrust`, `mcp.json`, `AGENTS.md` from it);
 * `--no-extensions` stops extension discovery and built-ins (explicit `-e` paths still load: that is
 * how kobe-policy, KOBE-36, is added, from a root-owned path); `--no-approve` ignores project-local
 * `.pi/` files; `--no-context-files` stops `AGENTS.md`/`CLAUDE.md` discovery (Kobe's instructions
 * come from agent files, D19; a model-written AGENTS.md would otherwise be a persistent prompt
 * injection across threads); `--no-skills` / `--no-prompt-templates` / `--no-themes` stop discovery
 * (gallery skills are passed explicitly by KOBE-49).
 */
export const POLICY_CHANNEL_FD = 3;

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
}

export interface PiLaunchInput {
  readonly sessionFile: string;
  readonly home: string;
  /** Root-owned, read-only Pi config directory (`PI_CODING_AGENT_DIR`). */
  readonly agentDir: string;
  /**
   * Extensions to load with `-e` (KOBE-36 adds kobe-policy here). Must be root-owned paths
   * outside anything the sandbox user can write, or `builtin:<name>`.
   */
  readonly extensions?: readonly string[];
  readonly parentEnv: Readonly<Record<string, string | undefined>>;
  readonly config?: PiThreadConfig | undefined;
}

export function buildPiLaunch(input: PiLaunchInput): PiLaunch {
  const args = ["--mode", "rpc", "--session", input.sessionFile, ...PI_LOCKDOWN_ARGS];
  for (const extension of input.extensions ?? []) args.push("--extension", extension);
  const config = input.config;
  if (config?.thinking_level !== undefined) args.push("--thinking", config.thinking_level);
  // Seams (not wired here): model alias → KOBE-41, mcp_servers → KOBE-62, skills/agent/system
  // prompt → KOBE-47/49. They change `key`, so a thread restarts Pi when its config changes.

  const env: Record<string, string> = {};
  for (const name of INHERITED_ENV) {
    const value = input.parentEnv[name];
    if (value !== undefined) env[name] = value;
  }
  env.PATH ??= "/usr/local/bin:/usr/bin:/bin";
  env.HOME = input.home;
  env.PI_CODING_AGENT_DIR = input.agentDir;
  env.PI_SKIP_VERSION_CHECK = "1";
  env.PI_TELEMETRY = "0";
  env.PI_OFFLINE = "1";
  // Pi is a Node process the tools it runs can signal: SIGUSR1 must not open an inspector in it.
  env.NODE_OPTIONS = "--disable-sigusr1";
  env.KOBE_POLICY_FD = String(POLICY_CHANNEL_FD);

  const key = JSON.stringify({
    args,
    model: config?.model ?? null,
    agent: config?.agent ?? null,
    system_prompt: config?.system_prompt ?? null,
    skills: config?.skills ?? null,
    mcp_servers: config?.mcp_servers ?? null,
  });
  return { args, env, key };
}
