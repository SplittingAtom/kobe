import { describe, expect, it } from "vitest";
import { POLICY_CHANNEL_FD, buildPiLaunch } from "./pi-launch.js";

const parentEnv = {
  PATH: "/usr/bin",
  LANG: "C.UTF-8",
  KOBE_SANDBOX_TOKEN_FILE: "/var/run/kobe/sandbox-wire/token",
  KOBE_SERVER_URL: "wss://kobe",
  ANTHROPIC_API_KEY: "sk-should-never-be-here",
  AWS_SECRET_ACCESS_KEY: "nope",
};

describe("buildPiLaunch", () => {
  it("runs Pi in RPC mode on the thread's session file", () => {
    const launch = buildPiLaunch({ sessionFile: "/s/t.jsonl", home: "/home/kobe", parentEnv });
    expect(launch.args).toEqual(["--mode", "rpc", "--session", "/s/t.jsonl"]);
  });

  it("builds Pi's environment from an allow-list: no agent config, tokens or keys", () => {
    const { env } = buildPiLaunch({ sessionFile: "/s/t.jsonl", home: "/home/kobe", parentEnv });
    expect(env).toEqual({
      PATH: "/usr/bin",
      LANG: "C.UTF-8",
      HOME: "/home/kobe",
      PI_SKIP_VERSION_CHECK: "1",
      PI_TELEMETRY: "0",
      PI_OFFLINE: "1",
      KOBE_POLICY_FD: String(POLICY_CHANNEL_FD),
    });
  });

  it("maps thinking level and changes the launch key when config changes", () => {
    const a = buildPiLaunch({ sessionFile: "/s", home: "/h", parentEnv: {} });
    const b = buildPiLaunch({
      sessionFile: "/s",
      home: "/h",
      parentEnv: {},
      config: { thinking_level: "high" },
    });
    const c = buildPiLaunch({
      sessionFile: "/s",
      home: "/h",
      parentEnv: {},
      config: { model: { alias: "smart" } },
    });
    expect(b.args).toContain("--thinking");
    expect(new Set([a.key, b.key, c.key]).size).toBe(3);
    expect(a.env.PATH).toBe("/usr/local/bin:/usr/bin:/bin");
  });
});
