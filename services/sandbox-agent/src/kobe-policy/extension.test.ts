import { readdir, readFile } from "node:fs/promises";
import { duplexPair, type Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { connectPolicy, registerKobePolicy, type ExtensionApiLike } from "./extension.js";
import type { ToolCallBlock, ToolCallContextLike, ToolCallEventLike } from "./handler.js";

const OWN = "/opt/kobe/pi-extensions/kobe-policy/index.js";
const ARGV = ["--mode", "rpc", "--no-extensions", "--extension", OWN];

type Handler = (e: ToolCallEventLike, c: ToolCallContextLike) => Promise<ToolCallBlock | undefined>;

function fakePi() {
  const handlers: Handler[] = [];
  const pi: ExtensionApiLike = {
    on: (_event, handler) => {
      handlers.push(handler);
      return () => undefined;
    },
  };
  return { pi, handlers };
}

function agentSide(end: Duplex) {
  const lines: Record<string, unknown>[] = [];
  let buffer = "";
  end.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    for (let lf = buffer.indexOf("\n"); lf !== -1; lf = buffer.indexOf("\n")) {
      lines.push(JSON.parse(buffer.slice(0, lf)) as Record<string, unknown>);
      buffer = buffer.slice(lf + 1);
    }
  });
  return { lines, send: (v: unknown) => end.write(`${JSON.stringify(v)}\n`) };
}

const until = async (predicate: () => boolean) => {
  for (let i = 0; i < 100 && !predicate(); i += 1) await new Promise((r) => setImmediate(r));
};

function setup(overrides: { argv?: string[]; env?: Record<string, string | undefined> } = {}) {
  const [extensionEnd, agentEnd] = duplexPair();
  const agent = agentSide(agentEnd);
  const env: Record<string, string | undefined> = { KOBE_POLICY_FD: "3", ...overrides.env };
  const opened: number[] = [];
  const warnings: string[] = [];
  const checker = connectPolicy({
    env,
    argv: overrides.argv ?? ARGV,
    cwd: "/workspace",
    ownPath: OWN,
    openChannel: (fd) => {
      opened.push(fd);
      return extensionEnd;
    },
    warn: (m) => warnings.push(m),
    clientOptions: { helloTimeoutMs: 200 },
  });
  return { agent, env, opened, warnings, checker };
}

const call = { toolName: "bash", toolCallId: "c1", input: { command: "ls" } };

describe("kobe-policy extension load", () => {
  it("opens fd 3, removes the fd variable, handshakes and reports ready", async () => {
    const t = setup();
    t.agent.send({ type: "channel.hello", nonce: "N" });
    const { pi, handlers } = fakePi();
    await registerKobePolicy(pi, t.checker);
    expect(t.opened).toEqual([3]);
    expect(t.env).not.toHaveProperty("KOBE_POLICY_FD");
    expect(handlers).toHaveLength(1);
    await until(() => t.agent.lines.length > 0);
    expect(t.agent.lines[0]).toEqual({
      type: "channel.ready",
      nonce: "N",
      extension: "kobe-policy",
      version: 1,
    });
  });

  it("does not report ready when registering the handler fails", async () => {
    const t = setup();
    t.agent.send({ type: "channel.hello", nonce: "N" });
    const pi: ExtensionApiLike = {
      on: () => {
        throw new Error("registration failed");
      },
    };
    await expect(registerKobePolicy(pi, t.checker)).rejects.toThrow("registration failed");
    await new Promise((r) => setTimeout(r, 50));
    expect(t.agent.lines).toEqual([]);
  });

  it("round-trips a tool call through the channel", async () => {
    const t = setup();
    t.agent.send({ type: "channel.hello", nonce: "N" });
    const { pi, handlers } = fakePi();
    await registerKobePolicy(pi, t.checker);
    const result = (handlers[0] as Handler)({ ...call, input: { ...call.input } }, {});
    await until(() => t.agent.lines.length > 1);
    const check = t.agent.lines[1] as Record<string, unknown>;
    expect(check).toMatchObject({ type: "policy.check", nonce: "N", tool: "bash" });
    t.agent.send({
      type: "policy.result",
      request_id: check.request_id,
      tool_call_id: "c1",
      decision: "deny",
      reasons: [],
      message: "Denied by install rule",
    });
    expect(await result).toEqual({ block: true, reason: "policy.denied: Denied by install rule" });
  });

  it("refuses (and blocks everything) when it is not the last extension", async () => {
    const t = setup({ argv: [...ARGV, "-e", "/opt/other.js"] });
    t.agent.send({ type: "channel.hello", nonce: "N" });
    const { pi, handlers } = fakePi();
    await registerKobePolicy(pi, t.checker);
    await until(() => t.agent.lines.length > 0);
    expect(t.agent.lines[0]).toMatchObject({ type: "channel.refused", nonce: "N" });
    expect(await (handlers[0] as Handler)(call, {})).toMatchObject({
      block: true,
      reason: expect.stringMatching(/not the last extension/),
    });
    expect(t.warnings.join()).toMatch(/not the last extension/);
  });

  it.each([
    ["missing", undefined],
    ["not a number", "three"],
    ["stdio", "1"],
  ])("blocks everything when the fd variable is %s", async (_name, value) => {
    const t = setup({ env: { KOBE_POLICY_FD: value } });
    const { pi, handlers } = fakePi();
    await registerKobePolicy(pi, t.checker);
    expect(t.opened).toEqual([]);
    expect(handlers).toHaveLength(1);
    expect(await (handlers[0] as Handler)(call, {})).toMatchObject({
      block: true,
      reason: expect.stringMatching(/no policy channel/),
    });
  });

  it("blocks everything when the channel cannot be opened", async () => {
    const { pi, handlers } = fakePi();
    const checker = connectPolicy({
      env: { KOBE_POLICY_FD: "3" },
      argv: ARGV,
      cwd: "/",
      ownPath: OWN,
      openChannel: () => {
        throw new Error("fd 3 is not a socket");
      },
    });
    await registerKobePolicy(pi, checker);
    expect(await (handlers[0] as Handler)(call, {})).toMatchObject({
      block: true,
      reason: expect.stringMatching(/not a socket/),
    });
  });

  it("blocks everything when the agent never says hello", async () => {
    const t = setup();
    const { pi, handlers } = fakePi();
    await registerKobePolicy(pi, t.checker);
    expect(await (handlers[0] as Handler)(call, {})).toMatchObject({
      block: true,
      reason: expect.stringMatching(/channel.hello/),
    });
  });
});

describe("kobe-policy reply timeout override", () => {
  it("shortens the first-reply wait and is removed from the environment", async () => {
    const t = setup({ env: { KOBE_POLICY_REPLY_TIMEOUT_MS: "50" } });
    t.agent.send({ type: "channel.hello", nonce: "N" });
    const { pi, handlers } = fakePi();
    await registerKobePolicy(pi, t.checker);
    expect(t.env).not.toHaveProperty("KOBE_POLICY_REPLY_TIMEOUT_MS");
    const started = Date.now();
    expect(await (handlers[0] as Handler)(call, {})).toMatchObject({
      reason: expect.stringMatching(/timed out/),
    });
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it.each(["0", "999999999", "-5", "soon"])("ignores %s (never lengthens the wait)", async (v) => {
    const t = setup({ env: { KOBE_POLICY_REPLY_TIMEOUT_MS: v } });
    t.agent.send({ type: "channel.hello", nonce: "N" });
    const { pi, handlers } = fakePi();
    await registerKobePolicy(pi, t.checker);
    expect(t.env).not.toHaveProperty("KOBE_POLICY_REPLY_TIMEOUT_MS");
    let settled = false;
    void (handlers[0] as Handler)(call, {}).then(() => (settled = true));
    await new Promise((r) => setTimeout(r, 100));
    expect(settled).toBe(false);
  });
});

describe("kobe-policy packaging", () => {
  it("imports only node builtins and files in its own directory (it ships on its own)", async () => {
    const dir = fileURLToPath(new URL(".", import.meta.url));
    const sources = (await readdir(dir)).filter(
      (f) => f.endsWith(".ts") && !f.endsWith(".test.ts"),
    );
    expect(sources).toContain("index.ts");
    for (const file of sources) {
      const text = await readFile(new URL(file, import.meta.url), "utf8");
      const specifiers = [...text.matchAll(/\bfrom\s+"([^"]+)"|\bimport\(\s*"([^"]+)"\s*\)/g)].map(
        (m) => m[1] ?? m[2],
      );
      for (const specifier of specifiers) {
        expect(
          specifier?.startsWith("node:") || /^\.\/[\w-]+\.js$/.test(specifier ?? ""),
          `${file} imports ${specifier}`,
        ).toBe(true);
      }
    }
  });
});
