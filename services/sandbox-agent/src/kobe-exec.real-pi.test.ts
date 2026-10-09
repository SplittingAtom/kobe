import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SandboxToServerFrame } from "@kobe/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { startHarness, until, runStart, type Harness } from "./testing/harness.js";
import {
  EXECUTOR_BUILT,
  EXECUTOR_ENTRY,
  FAUX_MODEL_EXTENSION,
  PI_AVAILABLE,
  PI_BIN,
  REAL_EXEC_EXTENSION,
  REAL_POLICY_EXTENSION,
  fauxScript,
} from "./testing/real-pi.js";

/**
 * KOBE-167 against the REAL pinned Pi 1.0.0 with the real kobe-policy and kobe-exec, through
 * kobe-sandbox-agent (relay on fd 5, executor process) and a fake Kobe server. A scripted model
 * makes Pi call its built-in tools without credentials. Here executor and Pi share the machine's
 * uid; that the executor runs as another uid is proven with the real helper in
 * exec.real.test.ts and what that uid cannot reach in identities.partner.real.test.ts.
 */
type PiEventFrame = Extract<SandboxToServerFrame, { type: "pi.event" }>;
type CheckFrame = Extract<SandboxToServerFrame, { type: "policy.check" }>;

let h: Harness | undefined;
let allowing: NodeJS.Timeout | undefined;
afterEach(async () => {
  clearInterval(allowing);
  expect(h?.server.violations ?? []).toEqual([]);
  await h?.close();
  h = undefined;
});

async function start(entry = EXECUTOR_ENTRY, withExec = true): Promise<Harness> {
  h = await startHarness({
    piBin: PI_BIN,
    env: { KOBE_POLICY_EXTENSION: REAL_POLICY_EXTENSION },
    extensions: [FAUX_MODEL_EXTENSION],
    ...(withExec
      ? {
          exec: {
            extension: REAL_EXEC_EXTENSION,
            wiring: { executorEntry: entry, nodeBin: process.execPath },
          },
        }
      : {}),
  });
  return h;
}

const checks = (t: Harness) => t.server.frames("policy.check") as CheckFrame[];

function answer(t: Harness, check: CheckFrame, decision: "allow" | "deny") {
  t.server.send({
    v: 1,
    type: "policy.result",
    request_id: check.request_id,
    run_id: check.run_id,
    tool_call_id: check.tool_call_id,
    decision,
    reasons: [
      decision === "allow"
        ? { code: "user_allow_rule", stage: "user_allow", message: "allowed" }
        : { code: "team_deny_rule", stage: "team_deny", message: "no" },
    ],
    ...(decision === "deny" ? { message: "no" } : {}),
  } as never);
}

/** Allow every policy check as it arrives (the tests here are about the tools, not the policy). */
function allowAll(t: Harness): void {
  const answered = new Set<string>();
  allowing = setInterval(() => {
    for (const check of checks(t)) {
      if (answered.has(check.request_id)) continue;
      answered.add(check.request_id);
      answer(t, check, "allow");
    }
  }, 20);
}

const events = (t: Harness) =>
  (t.server.frames("pi.event") as PiEventFrame[]).map((f) => f.event as Record<string, unknown>);

async function toolEnd(t: Harness, toolCallId: string) {
  await until(
    () => events(t).some((e) => e.type === "tool_execution_end" && e.toolCallId === toolCallId),
    30_000,
  );
  const end = events(t).find(
    (e) => e.type === "tool_execution_end" && e.toolCallId === toolCallId,
  ) as { isError: boolean; result: { content: { text: string }[] } };
  return { isError: end.isError, text: end.result.content.map((c) => c.text).join("") };
}

/** The n-th run (counting from 1) has ended. */
async function settled(t: Harness, n: number) {
  await until(() => events(t).filter((e) => e.type === "agent_settled").length >= n, 30_000);
}

async function run(t: Harness, steps: Record<string, unknown>[]) {
  const result = await t.server.command(runStart(fauxScript(steps)), 30_000);
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
}

const bash = (id: string, command: string) => ({ tool: "bash", id, args: { command } });

describe.skipIf(!PI_AVAILABLE || !EXECUTOR_BUILT)("kobe-exec in real Pi, through the agent", () => {
  it("runs Pi's bash tool in the executor process, not in Pi", async () => {
    const t = await start();
    allowAll(t);
    await run(t, [bash("b1", "ps -o command= -p $PPID")]);
    const end = await toolEnd(t, "b1");
    expect(end.isError).toBe(false);
    // bash's parent is the executor program, not Pi.
    expect(end.text).toContain("exec/executor/main.js");
    expect(end.text).not.toMatch(/pi-coding-agent|bin\/pi\b/);
  }, 90_000);

  it("gives the tools none of Pi's environment", async () => {
    const t = await start();
    allowAll(t);
    await run(t, [bash("b1", "env")]);
    const end = await toolEnd(t, "b1");
    for (const name of [
      "KOBE_POLICY_FD",
      "KOBE_EXEC_FD",
      "KOBE_TOOLS_FD",
      "KOBE_MODEL_FILE",
      "PI_CODING_AGENT_DIR",
      "PI_OFFLINE",
      "SECRET_IN_AGENT_ENV",
    ]) {
      expect(end.text, name).not.toContain(`${name}=`);
    }
    // What the model is told it can inspect (Pi's guideline) still arrives.
    expect(end.text).toContain("PI_PROVIDER=kobe-faux");
    expect(end.text).toContain("PI_MODEL=scripted");
  }, 90_000);

  it("keeps every tool call behind kobe-policy: a denied call never reaches the executor", async () => {
    const t = await start();
    await run(t, [bash("b1", "echo ran > ran.txt")]);
    await until(() => checks(t).length > 0, 30_000);
    answer(t, checks(t)[0] as CheckFrame, "deny");
    expect(await toolEnd(t, "b1")).toMatchObject({ isError: true });
    await new Promise((r) => setTimeout(r, 300));
    expect(existsSync(path.join(t.workspace, "ran.txt"))).toBe(false);
  }, 90_000);

  it("writes, reads, edits, lists and searches files through the executor", async () => {
    const t = await start();
    allowAll(t);
    await mkdir(path.join(t.workspace, "d"), { recursive: true });
    await writeFile(path.join(t.workspace, "d/seed.txt"), "seed\n");
    await run(t, [
      { tool: "write", id: "w1", args: { path: "notes.txt", content: "alpha\nbeta\n" } },
      { tool: "read", id: "r1", args: { path: "notes.txt" } },
      {
        tool: "edit",
        id: "e1",
        args: { path: "notes.txt", edits: [{ oldText: "beta", newText: "BETA" }] },
      },
      { tool: "ls", id: "l1", args: { path: "." } },
    ]);
    expect(await toolEnd(t, "w1")).toEqual({ isError: false, text: "Successfully wrote to notes.txt" });
    expect(await toolEnd(t, "r1")).toEqual({ isError: false, text: "alpha\nbeta\n" });
    expect(await toolEnd(t, "e1")).toMatchObject({ isError: false });
    expect(await readFile(path.join(t.workspace, "notes.txt"), "utf8")).toBe("alpha\nBETA\n");
    const ls = await toolEnd(t, "l1");
    expect(ls.text.split("\n")).toEqual(expect.arrayContaining(["d/", "notes.txt"]));
  }, 120_000);

  it("fails the call, never runs it in Pi, when the executor dies; the next call gets a new one", async () => {
    const t = await start();
    allowAll(t);
    // The tool kills its own executor (its parent), as a hostile tool might.
    await run(t, [bash("k1", "echo started > started.txt; kill -9 $PPID; sleep 5; echo after > after.txt")]);
    const end = await toolEnd(t, "k1");
    expect(end.isError).toBe(true);
    expect(end.text).toMatch(/tool executor is unavailable/);
    await settled(t, 1);
    expect(existsSync(path.join(t.workspace, "after.txt"))).toBe(false);
    await run(t, [bash("k2", "ps -o command= -p $PPID")]);
    const again = await toolEnd(t, "k2");
    expect(again).toMatchObject({ isError: false });
    expect(again.text).toContain("exec/executor/main.js");
  }, 120_000);

  it("fails closed when there is no executor to start: no tool runs in Pi instead", async () => {
    const t = await start("/nonexistent/kobe-no-such-executor.js");
    allowAll(t);
    await run(t, [bash("b1", "echo ran > ran.txt")]);
    const end = await toolEnd(t, "b1");
    expect(end.isError).toBe(true);
    expect(end.text).toMatch(/tool executor is unavailable/);
    await settled(t, 1);
    await run(t, [{ tool: "write", id: "w1", args: { path: "w.txt", content: "x" } }]);
    expect((await toolEnd(t, "w1")).isError).toBe(true);
    expect(existsSync(path.join(t.workspace, "ran.txt"))).toBe(false);
    expect(existsSync(path.join(t.workspace, "w.txt"))).toBe(false);
  }, 120_000);

  it("leaves Pi running its own tools when the agent has no tool executor (flag off)", async () => {
    const t = await start(EXECUTOR_ENTRY, false);
    allowAll(t);
    await run(t, [bash("b1", "ps -o command= -p $PPID")]);
    const end = await toolEnd(t, "b1");
    expect(end.isError).toBe(false);
    expect(end.text.trim()).toBe("pi");
    expect(end.text).not.toContain("executor/main.js");
  }, 90_000);
});
