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
const POLICY = "/opt/kobe/pi-extensions/kobe-policy/index.js";
const MODELS = "/opt/kobe/pi-extensions/kobe-models/index.js";
const base = {
  sessionFile: "/s/t.jsonl",
  home: "/home/kobe",
  policyExtension: POLICY,
};

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
      "--extension",
      POLICY,
    ]);
    expect(PI_LOCKDOWN_ARGS).toContain("--no-extensions");
  });

  it("always loads kobe-policy, as the last extension (KOBE-36)", () => {
    const launch = buildPiLaunch({
      ...base,
      parentEnv,
      extensions: [
        "builtin:mcp",
        POLICY,
        "/opt/kobe/pi-extensions/other.js",
        "/opt/kobe/pi-extensions/./kobe-policy/index.js",
      ],
      config: { thinking_level: "high" },
    });
    const extensions = launch.args.flatMap((a, i) =>
      a === "--extension" ? [launch.args[i + 1]] : [],
    );
    expect(extensions).toEqual(["builtin:mcp", "/opt/kobe/pi-extensions/other.js", POLICY]);
  });

  it("loads kobe-models right before kobe-policy when models are wired (KOBE-41), once", () => {
    const launch = buildPiLaunch({
      ...base,
      parentEnv,
      modelsExtension: MODELS,
      extensions: ["builtin:mcp", "/opt/kobe/pi-extensions/./kobe-models/index.js"],
    });
    const extensions = launch.args.flatMap((a, i) =>
      a === "--extension" ? [launch.args[i + 1]] : [],
    );
    expect(extensions).toEqual(["builtin:mcp", MODELS, POLICY]);
    // The model is not a launch argument: it changes per run without restarting Pi.
    expect(launch.args.join(" ")).not.toContain("--model");
  });

  it("registers exactly the given skill directories, one --skill each (KOBE-82)", () => {
    const launch = buildPiLaunch({
      ...base,
      parentEnv,
      skillDirs: ["/run/kobe-skills/sk-aa", "/run/kobe-skills/sk-bb"],
    });
    const skills = launch.args.flatMap((a, i) => (a === "--skill" ? [launch.args[i + 1]] : []));
    expect(skills).toEqual(["/run/kobe-skills/sk-aa", "/run/kobe-skills/sk-bb"]);
    // Explicit paths only: discovery stays off.
    expect(launch.args).toContain("--no-skills");
    expect(buildPiLaunch({ ...base, parentEnv }).args).not.toContain("--skill");
  });

  it("restarts Pi when a skill's bundle changes, not only its name (KOBE-82)", () => {
    const key = (sha256: string) =>
      buildPiLaunch({
        ...base,
        parentEnv,
        config: { skills: ["demo"], skill_bundles: [{ name: "demo", sha256, size: 10 }] },
      }).key;
    expect(key("a".repeat(64))).not.toBe(key("b".repeat(64)));
    expect(key("a".repeat(64))).toBe(key("a".repeat(64)));
  });

  it("builds Pi's environment from an allow-list: no agent config, tokens, keys or inspector", () => {
    const { env } = buildPiLaunch({ ...base, parentEnv });
    expect(env).toEqual({
      PATH: "/usr/bin",
      LANG: "C.UTF-8",
      HOME: "/home/kobe",
      PI_SKIP_VERSION_CHECK: "1",
      PI_TELEMETRY: "0",
      PI_OFFLINE: "1",
      NODE_OPTIONS: "--disable-sigusr1",
      KOBE_POLICY_FD: String(POLICY_CHANNEL_FD),
    });
  });

  it("maps thinking level and changes the launch key when config changes, but not for the model", () => {
    const a = buildPiLaunch({ ...base, parentEnv: {} });
    const b = buildPiLaunch({ ...base, parentEnv: {}, config: { thinking_level: "high" } });
    const c = buildPiLaunch({
      ...base,
      parentEnv: {},
      config: {
        model: { alias: "smart", gateway_model: "anthropic/c", api: "anthropic-messages" },
      },
    });
    const d = buildPiLaunch({ ...base, parentEnv: {}, config: { skills: ["csv"] } });
    expect(b.args).toContain("--thinking");
    expect(new Set([a.key, b.key, d.key]).size).toBe(3);
    expect(c.key).toBe(a.key);
    expect(a.env.PATH).toBe("/usr/local/bin:/usr/bin:/bin");
  });
});
