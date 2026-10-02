import { describe, expect, it } from "vitest";
import { PI_LOCKDOWN_ARGS, POLICY_CHANNEL_FD, buildPiLaunch } from "./pi-launch.js";

const parentEnv = {
  PATH: "/usr/bin",
  LANG: "C.UTF-8",
  KOBE_SANDBOX_TOKEN_FILE: "/var/run/kobe/sandbox-wire/token",
  KOBE_SERVER_URL: "wss://kobe",
  ANTHROPIC_API_KEY: "sk-should-never-be-here",
  AWS_SECRET_ACCESS_KEY: "nope",
  NODE_OPTIONS: "--inspect=0.0.0.0:9229",
};
const base = { sessionFile: "/s/t.jsonl", home: "/home/kobe", agentDir: "/opt/kobe/pi-agent" };

describe("buildPiLaunch", () => {
  it("runs Pi in RPC mode on the thread's session file, locked down", () => {
    const launch = buildPiLaunch({ ...base, parentEnv });
    expect(launch.args).toEqual([
      "--mode",
      "rpc",
      "--session",
      "/s/t.jsonl",
      "--no-extensions",
      "--no-approve",
      "--no-context-files",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
    ]);
    expect(PI_LOCKDOWN_ARGS).toContain("--no-extensions");
  });

  it("loads only explicitly given extensions (the KOBE-36 hook)", () => {
    const launch = buildPiLaunch({
      ...base,
      parentEnv,
      extensions: ["/opt/kobe/pi-extensions/kobe-policy.js"],
    });
    expect(launch.args.slice(-2)).toEqual([
      "--extension",
      "/opt/kobe/pi-extensions/kobe-policy.js",
    ]);
  });

  it("builds Pi's environment from an allow-list: no agent config, tokens, keys or inspector", () => {
    const { env } = buildPiLaunch({ ...base, parentEnv });
    expect(env).toEqual({
      PATH: "/usr/bin",
      LANG: "C.UTF-8",
      HOME: "/home/kobe",
      PI_CODING_AGENT_DIR: "/opt/kobe/pi-agent",
      PI_SKIP_VERSION_CHECK: "1",
      PI_TELEMETRY: "0",
      PI_OFFLINE: "1",
      NODE_OPTIONS: "--disable-sigusr1",
      KOBE_POLICY_FD: String(POLICY_CHANNEL_FD),
    });
  });

  it("maps thinking level and changes the launch key when config changes", () => {
    const a = buildPiLaunch({ ...base, parentEnv: {} });
    const b = buildPiLaunch({ ...base, parentEnv: {}, config: { thinking_level: "high" } });
    const c = buildPiLaunch({ ...base, parentEnv: {}, config: { model: { alias: "smart" } } });
    expect(b.args).toContain("--thinking");
    expect(new Set([a.key, b.key, c.key]).size).toBe(3);
    expect(a.env.PATH).toBe("/usr/local/bin:/usr/bin:/bin");
  });
});
