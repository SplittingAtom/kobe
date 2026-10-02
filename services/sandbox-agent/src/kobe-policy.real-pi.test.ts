import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Duplex } from "node:stream";
import type { SandboxToServerFrame } from "@kobe/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { RUN, runStart, startHarness, until, type Harness } from "./testing/harness.js";
import {
  FAUX_MODEL_EXTENSION,
  MUTATE_INPUT_EXTENSION,
  PI_AVAILABLE,
  PI_BIN,
  REAL_POLICY_EXTENSION,
  fauxScript,
} from "./testing/real-pi.js";

/**
 * KOBE-36 against the REAL pinned Pi 1.0.0 in RPC mode with the real kobe-policy extension.
 * A scripted model (pi-ai's faux provider, testing/pi-extensions/faux-model.mjs) makes Pi issue
 * tool calls without credentials.
 *
 * 1. Through kobe-sandbox-agent and a fake Kobe server, which answers `policy.check` frames.
 * 2. Pi spawned directly, the test playing the agent's end of the fd-3 channel (timeouts, closed or
 *    missing channel, wrong extension order).
 */
type PiEventFrame = Extract<SandboxToServerFrame, { type: "pi.event" }>;
type CheckFrame = Extract<SandboxToServerFrame, { type: "policy.check" }>;

let h: Harness | undefined;
const agentDirs: string[] = [];
afterEach(async () => {
  expect(h?.server.violations ?? []).toEqual([]);
  await h?.close();
  h = undefined;
  for (const dir of agentDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function start(extensions: readonly string[] = []): Promise<Harness> {
  // Writable Pi config dir: Pi 1.0.0 opens its credential store there before calling any model
  // (EACCES in the image's read-only dir — a KOBE-41 concern, not kobe-policy's).
  const agentDir = await mkdtemp(path.join(tmpdir(), "kobe-pi-agent-"));
  agentDirs.push(agentDir);
  h = await startHarness({
    piBin: PI_BIN,
    env: { KOBE_POLICY_EXTENSION: REAL_POLICY_EXTENSION, KOBE_PI_AGENT_DIR: agentDir },
    extensions: [FAUX_MODEL_EXTENSION, ...extensions],
  });
  return h;
}

function checks(harness: Harness): CheckFrame[] {
  return harness.server.frames("policy.check") as CheckFrame[];
}

async function nextCheck(harness: Harness, index: number): Promise<CheckFrame> {
  await until(() => checks(harness).length > index, 30_000);
  return checks(harness)[index] as CheckFrame;
}

function answer(harness: Harness, check: CheckFrame, decision: "allow" | "deny", message = "") {
  harness.server.send({
    v: 1,
    type: "policy.result",
    request_id: check.request_id,
    run_id: check.run_id,
    tool_call_id: check.tool_call_id,
    decision,
    reasons: [
      decision === "allow"
        ? { code: "user_allow_rule", stage: "user_allow", message: "allowed" }
        : { code: "team_deny_rule", stage: "team_deny", message },
    ],
    ...(decision === "deny" ? { message } : {}),
  } as never);
}

function piEvents(harness: Harness): Record<string, unknown>[] {
  return (harness.server.frames("pi.event") as PiEventFrame[]).map(
    (f) => f.event as Record<string, unknown>,
  );
}

async function toolEnd(harness: Harness, toolCallId: string) {
  await until(
    () =>
      piEvents(harness).some((e) => e.type === "tool_execution_end" && e.toolCallId === toolCallId),
    30_000,
  );
  const end = piEvents(harness).find(
    (e) => e.type === "tool_execution_end" && e.toolCallId === toolCallId,
  ) as { isError: boolean; result: { content: { text: string }[] } };
  return { isError: end.isError, text: end.result.content.map((c) => c.text).join("") };
}

async function settled(harness: Harness) {
  await until(() => piEvents(harness).some((e) => e.type === "agent_settled"), 30_000);
}

async function run(harness: Harness, steps: Record<string, unknown>[]) {
  const result = await harness.server.command(runStart(fauxScript(steps)), 30_000);
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
}

const bash = (id: string, command: string) => ({ tool: "bash", id, args: { command } });

describe.skipIf(!PI_AVAILABLE)("kobe-policy in real Pi, through kobe-sandbox-agent", () => {
  it("runs a tool only after the server allows it, with name and input only", async () => {
    const t = await start();
    await run(t, [bash("c1", "echo allowed > allowed.txt")]);
    const check = await nextCheck(t, 0);
    expect(check).toEqual({
      v: 1,
      type: "policy.check",
      request_id: expect.any(String),
      run_id: RUN,
      thread_id: check.thread_id,
      tool_call_id: "c1",
      tool: "bash",
      input: { command: "echo allowed > allowed.txt" },
    });
    // Nothing runs while the decision is outstanding.
    await new Promise((r) => setTimeout(r, 300));
    expect(existsSync(path.join(t.workspace, "allowed.txt"))).toBe(false);
    answer(t, check, "allow");
    expect(await toolEnd(t, "c1")).toMatchObject({ isError: false });
    expect(await readFile(path.join(t.workspace, "allowed.txt"), "utf8")).toBe("allowed\n");
    await settled(t);
  }, 60_000);

  it("blocks a denied call with a policy.denied tool error carrying the server's message", async () => {
    const t = await start();
    await run(t, [{ tool: "write", id: "w1", args: { path: "denied.txt", content: "x" } }]);
    answer(t, await nextCheck(t, 0), "deny", "Denied by team rule: no writes here");
    expect(await toolEnd(t, "w1")).toEqual({
      isError: true,
      text: "policy.denied: Denied by team rule: no writes here",
    });
    expect(existsSync(path.join(t.workspace, "denied.txt"))).toBe(false);
    await settled(t);
  }, 60_000);

  it("waits through policy.pending until the final decision", async () => {
    const t = await start();
    await run(t, [bash("p1", "echo approved > approved.txt")]);
    const check = await nextCheck(t, 0);
    t.server.send({
      v: 1,
      type: "policy.pending",
      request_id: check.request_id,
      run_id: RUN,
      tool_call_id: "p1",
      approval_id: "0f1e2d3c-4b5a-4968-8776-655443322110",
      expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
    } as never);
    await new Promise((r) => setTimeout(r, 500));
    expect(piEvents(t).some((e) => e.type === "tool_execution_end")).toBe(false);
    answer(t, check, "allow");
    expect(await toolEnd(t, "p1")).toMatchObject({ isError: false });
    expect(existsSync(path.join(t.workspace, "approved.txt"))).toBe(true);
    await settled(t);
  }, 60_000);

  it("blocks pending calls when the server connection drops (fail closed)", async () => {
    const t = await start();
    await run(t, [bash("d1", "echo lost > lost.txt")]);
    await nextCheck(t, 0);
    t.server.terminate();
    expect(await toolEnd(t, "d1")).toMatchObject({
      isError: true,
      text: expect.stringMatching(/^policy\.denied: .*connection to Kobe server lost/),
    });
    expect(existsSync(path.join(t.workspace, "lost.txt"))).toBe(false);
  }, 60_000);

  it("blocks a call waiting for approval when the run is stopped", async () => {
    const t = await start();
    await run(t, [bash("s1", "echo stopped > stopped.txt")]);
    const check = await nextCheck(t, 0);
    t.server.send({
      v: 1,
      type: "policy.pending",
      request_id: check.request_id,
      run_id: RUN,
      tool_call_id: "s1",
      approval_id: "0f1e2d3c-4b5a-4968-8776-655443322110",
      expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
    } as never);
    const stopped = await t.server.command(
      {
        type: "run.stop",
        run_id: RUN,
        thread_id: check.thread_id,
        mode: "abort",
        reason: "user_cancelled",
      },
      30_000,
    );
    expect(stopped).toMatchObject({ ok: true });
    const end = await toolEnd(t, "s1");
    expect(end.isError).toBe(true);
    expect(existsSync(path.join(t.workspace, "stopped.txt"))).toBe(false);
    // A late allow for the stopped call changes nothing.
    answer(t, check, "allow");
    await new Promise((r) => setTimeout(r, 300));
    expect(existsSync(path.join(t.workspace, "stopped.txt"))).toBe(false);
  }, 60_000);

  it("checks the input an earlier extension mutated, and runs exactly that", async () => {
    const t = await start([MUTATE_INPUT_EXTENSION]);
    await run(t, [bash("m1", "echo original")]);
    const check = await nextCheck(t, 0);
    expect(check.input).toEqual({ command: "echo mutated > mutated.txt" });
    answer(t, check, "allow");
    expect(await toolEnd(t, "m1")).toMatchObject({ isError: false });
    expect(existsSync(path.join(t.workspace, "mutated.txt"))).toBe(true);
    await settled(t);
  }, 60_000);

  it("checks each codemode nested call on its own", async () => {
    const t = await start(["builtin:codemode"]);
    const code = [
      'const a = await tools.bash({ command: "echo one > one.txt" });',
      'const b = await Promise.allSettled([tools.bash({ command: "echo two > two.txt" }),',
      '  tools.read({ path: "one.txt" })]);',
      "text(JSON.stringify(b.map((r) => r.status)));",
    ].join("\n");
    await run(t, [{ tool: "codemode", id: "cm1", args: { code } }]);
    const parent = await nextCheck(t, 0);
    expect(parent).toMatchObject({ tool: "codemode", tool_call_id: "cm1", input: { code } });
    expect(parent).not.toHaveProperty("parent_tool_call_id");
    answer(t, parent, "allow");
    const first = await nextCheck(t, 1);
    expect(first).toMatchObject({
      tool: "bash",
      tool_call_id: "cm1/1",
      parent_tool_call_id: "cm1",
      input: { command: "echo one > one.txt" },
    });
    answer(t, first, "allow");
    await nextCheck(t, 3);
    const nested = checks(t).slice(2);
    expect(nested.map((c) => [c.tool_call_id, c.tool, c.parent_tool_call_id]).sort()).toEqual([
      ["cm1/2", "bash", "cm1"],
      ["cm1/3", "read", "cm1"],
    ]);
    for (const c of nested) {
      answer(t, c, c.tool === "bash" ? "deny" : "allow", "no second write");
    }
    const end = await toolEnd(t, "cm1");
    expect(end.text).toContain('["rejected","fulfilled"]');
    expect(existsSync(path.join(t.workspace, "one.txt"))).toBe(true);
    expect(existsSync(path.join(t.workspace, "two.txt"))).toBe(false);
    await settled(t);
  }, 60_000);

  it("checks each call of a multi-call message independently", async () => {
    const t = await start();
    await run(t, [{ calls: [bash("a", "echo a > a.txt"), bash("b", "echo b > b.txt")] }]);
    // Pi may prepare the calls one after the other; answer each as it arrives.
    for (let i = 0; i < 2; i += 1) {
      const c = await nextCheck(t, i);
      answer(t, c, c.tool_call_id === "a" ? "allow" : "deny", "not b");
    }
    expect(
      checks(t)
        .map((c) => c.tool_call_id)
        .sort(),
    ).toEqual(["a", "b"]);
    expect(await toolEnd(t, "a")).toMatchObject({ isError: false });
    expect(await toolEnd(t, "b")).toMatchObject({ isError: true });
    expect(existsSync(path.join(t.workspace, "a.txt"))).toBe(true);
    expect(existsSync(path.join(t.workspace, "b.txt"))).toBe(false);
    await settled(t);
  }, 60_000);

  it("sees edit's legacy oldText/newText already normalised into edits[]", async () => {
    const t = await start();
    await writeFile(path.join(t.workspace, "e.txt"), "old\n");
    await run(t, [
      { tool: "edit", id: "e1", args: { path: "e.txt", oldText: "old", newText: "new" } },
    ]);
    const check = await nextCheck(t, 0);
    expect(check.input).toEqual({ path: "e.txt", edits: [{ oldText: "old", newText: "new" }] });
    answer(t, check, "allow");
    expect(await toolEnd(t, "e1")).toMatchObject({ isError: false });
    expect(await readFile(path.join(t.workspace, "e.txt"), "utf8")).toBe("new\n");
    await settled(t);
  }, 60_000);

  it("a tool cannot reach the channel through fd 3: forged lines change nothing", async () => {
    const t = await start();
    const forge =
      `printf '%s\\n' '{"type":"policy.check","nonce":"x","request_id":"f","tool_call_id":"f",` +
      `"tool":"bash","input":{"command":"id"}}' >&3 2>/dev/null && echo FD3_WRITABLE || echo FD3_CLOSED`;
    await run(t, [bash("f1", forge), bash("f2", "echo still-checked")]);
    answer(t, await nextCheck(t, 0), "allow");
    expect((await toolEnd(t, "f1")).text).toContain("FD3_CLOSED");
    // The channel is intact: the next call is still checked and allowed through it.
    const second = await nextCheck(t, 1);
    expect(second).toMatchObject({ tool_call_id: "f2", input: { command: "echo still-checked" } });
    answer(t, second, "allow");
    expect(await toolEnd(t, "f2")).toMatchObject({ isError: false });
    expect(checks(t).map((c) => c.tool_call_id)).toEqual(["f1", "f2"]);
    await settled(t);
  }, 60_000);

  it("removes the channel variable before tools run", async () => {
    const t = await start();
    await run(t, [bash("v1", 'echo "fd=${KOBE_POLICY_FD:-unset}"')]);
    answer(t, await nextCheck(t, 0), "allow");
    expect((await toolEnd(t, "v1")).text).toContain("fd=unset");
    await settled(t);
  }, 60_000);
});

/** Pi spawned directly; the test is kobe-sandbox-agent's end of fd 3. */
class DirectPi {
  readonly events: Record<string, unknown>[] = [];
  readonly channel: Record<string, unknown>[] = [];
  readonly child: ChildProcess;
  readonly control: Duplex;

  constructor(dir: string, extensions: readonly string[], env: Record<string, string> = {}) {
    const args = ["--mode", "rpc", "--no-session", "--no-extensions", "--no-approve"];
    for (const e of extensions) args.push("--extension", e);
    this.child = spawn(PI_BIN, args, {
      cwd: path.join(dir, "workspace"),
      env: {
        PATH: process.env.PATH ?? "",
        HOME: path.join(dir, "home"),
        PI_CODING_AGENT_DIR: path.join(dir, "pi-agent"),
        PI_OFFLINE: "1",
        PI_TELEMETRY: "0",
        PI_SKIP_VERSION_CHECK: "1",
        KOBE_POLICY_FD: "3",
        ...env,
      },
      stdio: ["pipe", "pipe", "ignore", "pipe"],
    });
    this.control = this.child.stdio[3] as Duplex;
    collectLines(this.child.stdout as Duplex, this.events);
    collectLines(this.control, this.channel);
  }

  hello(): void {
    this.control.write(`${JSON.stringify({ type: "channel.hello", nonce: "test-nonce" })}\n`);
  }

  prompt(steps: Record<string, unknown>[]): void {
    this.child.stdin?.write(
      `${JSON.stringify({ type: "prompt", id: "p", message: fauxScript(steps) })}\n`,
    );
  }

  async toolEnd(id: string) {
    await until(
      () => this.events.some((e) => e.type === "tool_execution_end" && e.toolCallId === id),
      30_000,
    );
    const end = this.events.find((e) => e.type === "tool_execution_end" && e.toolCallId === id) as {
      isError: boolean;
      result: { content: { text: string }[] };
    };
    return { isError: end.isError, text: end.result.content.map((c) => c.text).join("") };
  }

  async stop(): Promise<void> {
    if (this.child.exitCode !== null) return;
    const exited = new Promise((resolve) => this.child.once("exit", resolve));
    this.child.kill("SIGKILL");
    await exited;
  }
}

function collectLines(stream: Duplex, into: Record<string, unknown>[]) {
  let buffer = "";
  stream.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    for (let lf = buffer.indexOf("\n"); lf !== -1; lf = buffer.indexOf("\n")) {
      const line = buffer.slice(0, lf);
      buffer = buffer.slice(lf + 1);
      try {
        into.push(JSON.parse(line) as Record<string, unknown>);
      } catch {
        // not JSON: ignore
      }
    }
  });
  stream.on("error", () => undefined);
}

describe.skipIf(!PI_AVAILABLE)("kobe-policy in real Pi, against a fake channel peer", () => {
  let dir: string | undefined;
  let pi: DirectPi | undefined;
  afterEach(async () => {
    await pi?.stop();
    pi = undefined;
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  async function launch(extensions: readonly string[], env: Record<string, string> = {}) {
    dir = await mkdtemp(path.join(tmpdir(), "kobe-policy-pi-"));
    await mkdir(path.join(dir, "workspace"));
    await mkdir(path.join(dir, "home"));
    await mkdir(path.join(dir, "pi-agent")); // writable: see start()
    pi = new DirectPi(dir, extensions, env);
    return pi;
  }

  const ready = async (p: DirectPi) => {
    p.hello();
    await until(() => p.channel.length > 0, 30_000);
    return p.channel[0];
  };

  it("blocks when no answer arrives in time", async () => {
    const p = await launch([FAUX_MODEL_EXTENSION, REAL_POLICY_EXTENSION], {
      KOBE_POLICY_REPLY_TIMEOUT_MS: "500",
    });
    expect(await ready(p)).toEqual({
      type: "channel.ready",
      nonce: "test-nonce",
      extension: "kobe-policy",
      version: 1,
    });
    p.prompt([bash("t1", "echo late > late.txt")]);
    await until(() => p.channel.some((m) => m.type === "policy.check"), 30_000);
    expect(p.channel.find((m) => m.type === "policy.check")).toMatchObject({
      nonce: "test-nonce",
      tool_call_id: "t1",
    });
    expect(await p.toolEnd("t1")).toEqual({
      isError: true,
      text: "policy.denied: policy check timed out",
    });
    expect(existsSync(path.join(dir ?? "", "workspace/late.txt"))).toBe(false);
  }, 60_000);

  it("blocks pending and later calls once the channel closes", async () => {
    const p = await launch([FAUX_MODEL_EXTENSION, REAL_POLICY_EXTENSION]);
    await ready(p);
    p.prompt([bash("c1", "echo one > one.txt"), bash("c2", "echo two > two.txt")]);
    await until(() => p.channel.some((m) => m.type === "policy.check"), 30_000);
    p.control.destroy();
    expect(await p.toolEnd("c1")).toMatchObject({
      isError: true,
      text: expect.stringMatching(/^policy\.denied: policy channel closed/),
    });
    expect(await p.toolEnd("c2")).toMatchObject({ isError: true });
    expect(existsSync(path.join(dir ?? "", "workspace/one.txt"))).toBe(false);
    expect(existsSync(path.join(dir ?? "", "workspace/two.txt"))).toBe(false);
  }, 60_000);

  it("blocks every call when Pi has no policy channel at all", async () => {
    const p = await launch([FAUX_MODEL_EXTENSION, REAL_POLICY_EXTENSION], { KOBE_POLICY_FD: "" });
    p.prompt([bash("n1", "echo x > x.txt")]);
    expect(await p.toolEnd("n1")).toMatchObject({
      isError: true,
      text: expect.stringMatching(/no policy channel/),
    });
    expect(existsSync(path.join(dir ?? "", "workspace/x.txt"))).toBe(false);
  }, 60_000);

  it("refuses to serve, and blocks, when it is not the last extension", async () => {
    const p = await launch([REAL_POLICY_EXTENSION, MUTATE_INPUT_EXTENSION, FAUX_MODEL_EXTENSION]);
    expect(await ready(p)).toEqual({
      type: "channel.refused",
      nonce: "test-nonce",
      reason: "kobe-policy is not the last extension Pi loads",
    });
    p.prompt([bash("l1", "echo x > x.txt")]);
    expect(await p.toolEnd("l1")).toMatchObject({
      isError: true,
      text: expect.stringMatching(/not the last extension/),
    });
  }, 60_000);
});
