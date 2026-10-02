import type { PiThreadConfig } from "@kobe/protocol";

/**
 * How a thread's `pi --mode rpc` process is started. The environment is built from an allow-list,
 * never inherited: the agent's own environment (server URL, sandbox id, token file path, anything a
 * pod spec adds) does not reach Pi or the tools Pi runs. No provider or MCP credential exists in the
 * sandbox at all (D13, D27, D30); the model gateway and MCP proxy wiring belong to KOBE-41 / KOBE-62
 * and arrive as further allow-listed, credential-free variables or flags.
 */
export const POLICY_CHANNEL_FD = 3;

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
  readonly parentEnv: Readonly<Record<string, string | undefined>>;
  readonly config?: PiThreadConfig | undefined;
}

export function buildPiLaunch(input: PiLaunchInput): PiLaunch {
  const args = ["--mode", "rpc", "--session", input.sessionFile];
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
  env.PI_SKIP_VERSION_CHECK = "1";
  env.PI_TELEMETRY = "0";
  env.PI_OFFLINE = "1";
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
