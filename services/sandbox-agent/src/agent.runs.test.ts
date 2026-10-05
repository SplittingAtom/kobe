import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseTranslatedPiEvent, type SandboxToServerFrame } from "@kobe/protocol";
import { afterEach, describe, expect, it } from "vitest";
import {
  RUN,
  RUN_2,
  THREAD,
  THREAD_2,
  FAKE_POLICY_EXTENSION,
  runStart,
  startHarness,
  until,
  type Harness,
} from "./testing/harness.js";

let h: Harness;
afterEach(async () => {
  expect(h.server.violations).toEqual([]);
  await h.close();
});

type PiEvent = Extract<SandboxToServerFrame, { type: "pi.event" }>;
const settled =
  (runId: string = RUN) =>
  (f: SandboxToServerFrame) =>
    f.type === "pi.event" && f.run_id === runId && f.event.type === "agent_settled";
const events = (runId: string = RUN) =>
  h.server.frames("pi.event").filter((f) => f.run_id === runId);

describe("run.start → Pi prompt → pi.event stream", () => {
  it("streams Pi events with gapless per-run seqs and answers the command once", async () => {
    h = await startHarness();
    const result = await h.server.command(runStart("say:Hello"));
    expect(result).toMatchObject({ ok: true, data: { disposition: "started" } });
    await h.server.waitFor(settled());
    const stream = events();
    expect(stream.map((f) => f.seq)).toEqual(stream.map((_, i) => i + 1));
    expect(stream.map((f) => f.event.type)).toEqual([
      "agent_start",
      "message_update",
      "message_update",
      "turn_end",
      "agent_end",
      "agent_settled",
    ]);
    for (const f of stream) expect(parseTranslatedPiEvent(f.event).kind).not.toBe("invalid");
    const deltas = stream.flatMap((f) =>
      f.event.type === "message_update"
        ? [(f.event.assistantMessageEvent as { delta: string }).delta]
        : [],
    );
    expect(deltas.join("")).toBe("Hello");
    expect(stream.every((f: PiEvent) => f.thread_id === THREAD)).toBe(true);
  });

  it("passes the agent's system prompt to Pi as an appended, agent-owned file (KOBE-123)", async () => {
    const prompt = 'You are the marker agent. KOBE-PROMPT-MARKER:abc \u00e9 `$(rm -rf /)` "quoted"';
    h = await startHarness();
    await h.server.command(runStart("say:hi", { config: { system_prompt: prompt } }));
    const [launch] = await h.commandsLog();
    const argv = launch?.argv as string[];
    const at = argv.indexOf("--append-system-prompt");
    expect(at).toBeGreaterThan(-1);
    expect(argv).not.toContain("--system-prompt"); // append: Pi's tool and skill prompt stays
    const file = argv[at + 1] as string;
    expect(argv.join("\n")).not.toContain("KOBE-PROMPT-MARKER");
    expect(path.basename(file)).toBe("system-prompt.md");
    expect(launch?.appendSystemPromptText).toBe(prompt);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    await h.close();
    await expect(stat(file)).rejects.toThrow(); // removed with the process's runtime directory
  });

  it("starts Pi without the flag when the run has no system prompt (KOBE-123)", async () => {
    h = await startHarness();
    await h.server.command(runStart("say:hi", { config: { system_prompt: "" } }));
    const [launch] = await h.commandsLog();
    expect(launch?.argv).not.toContain("--append-system-prompt");
  });

  it("runs Pi in RPC mode with an allow-listed environment (no agent secrets)", async () => {
    h = await startHarness();
    await h.server.command(runStart("say:hi"));
    const [launch] = await h.commandsLog();
    expect(launch?.argv).toEqual([
      "--mode",
      "rpc",
      "--session",
      path.join(h.sessions, `${THREAD}.jsonl`),
      "--no-extensions",
      "--no-approve",
      "--no-context-files",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--extension",
      FAKE_POLICY_EXTENSION,
    ]);
    expect(launch?.env).toContain("PI_CODING_AGENT_DIR");
    expect(launch?.env).not.toContain("SECRET_IN_AGENT_ENV");
    const kobeVars = (launch?.env as string[]).filter((k) => k.startsWith("KOBE_"));
    expect(kobeVars).toEqual(["KOBE_POLICY_FD"]);
    const prompts = (await h.commandsLog()).filter((c) => c.type === "prompt");
    expect(prompts).toEqual([{ type: "prompt", message: "say:hi", id: expect.any(String) }]);
  });

  it("ignores a duplicate command_id on the same connection", async () => {
    h = await startHarness();
    const frame = { v: 1, command_id: "dup-1", ...runStart("say:hi") } as never;
    h.server.send(frame);
    h.server.send(frame);
    await h.server.waitFor(settled());
    await new Promise((r) => setTimeout(r, 100));
    expect(h.server.frames("command.result").filter((f) => f.command_id === "dup-1")).toHaveLength(
      1,
    );
  });

  it("reports Pi's rejection and does not keep the run", async () => {
    h = await startHarness();
    const result = await h.server.command(runStart("reject"));
    expect(result).toMatchObject({
      ok: false,
      error: { code: "pi_rejected", message: "No API key found" },
    });
    // The thread is free for the next run.
    expect(await h.server.command({ ...runStart("say:ok"), run_id: RUN_2 })).toMatchObject({
      ok: true,
    });
  });

  it("ends a run whose prompt Pi handled without starting one", async () => {
    h = await startHarness();
    expect(await h.server.command(runStart("handled"))).toMatchObject({
      ok: true,
      data: { disposition: "handled" },
    });
    expect(await h.server.command({ ...runStart("say:x"), run_id: RUN_2 })).toMatchObject({
      ok: true,
    });
  });

  it("refuses a second run on a busy thread but runs threads concurrently", async () => {
    h = await startHarness();
    await h.server.command(runStart("hang"));
    expect(await h.server.command({ ...runStart("hang"), run_id: RUN_2 })).toMatchObject({
      ok: false,
      error: { code: "pi_rejected" },
    });
    expect(
      await h.server.command({ ...runStart("say:other"), run_id: RUN_2, thread_id: THREAD_2 }),
    ).toMatchObject({ ok: true });
    await h.server.waitFor(settled(RUN_2));
  });

  it("lists attachments in the prompt and refuses paths outside the workspace", async () => {
    h = await startHarness();
    const outside = await h.server.command(
      runStart("say:x", { attachments: [{ path: "/etc/passwd", mime_type: "text/plain" }] }),
    );
    expect(outside).toMatchObject({ ok: false, error: { code: "pi_rejected" } });
    const file = path.join(h.workspace, "uploads", "sales.csv");
    await h.server.command(
      runStart("say:x", { attachments: [{ path: file, mime_type: "text/csv" }] }),
    );
    const prompt = (await h.commandsLog()).find((c) => c.type === "prompt");
    expect(prompt?.message).toBe(`say:x\n\nAttached files:\n- ${file} (text/csv)`);
  });
});

describe("workspace sync hooks (KOBE-27)", () => {
  it("restores the workspace before the prompt reaches Pi, and pushes after the run and on stop", async () => {
    const calls: string[] = [];
    h = await startHarness({
      workspace: (dir) => ({
        async beforeRun(frame) {
          calls.push(`beforeRun:${frame.run_id}`);
          await mkdir(path.join(dir, "uploads"), { recursive: true });
          await writeFile(path.join(dir, "uploads", "sales.csv"), "a,b\n");
        },
        runEnded: () => void calls.push("runEnded"),
        flush: (ms) => Promise.resolve(void calls.push(`flush:${ms}`)),
      }),
    });
    const file = path.join(h.workspace, "uploads", "sales.csv");
    const result = await h.server.command(
      runStart("say:x", { attachments: [{ path: file, mime_type: "text/csv" }] }),
    );
    expect(result).toMatchObject({ ok: true });
    // Pi saw the prompt only after the hook had put the upload in place.
    const prompt = (await h.commandsLog()).find((c) => c.type === "prompt");
    expect(prompt).toBeDefined();
    expect(readFileSync(file, "utf8")).toBe("a,b\n");
    await h.server.waitFor(settled());
    await until(() => calls.includes("runEnded"));
    expect(calls[0]).toBe(`beforeRun:${RUN}`);
    await h.agent.stop(500);
    expect(calls.at(-1)).toBe("flush:15000");
  });

  it("fails the run when the workspace cannot be prepared, before Pi sees the prompt", async () => {
    h = await startHarness({
      workspace: () => ({
        beforeRun: () =>
          Promise.reject(new Error("attachment uploads/x.csv is not in the workspace")),
        runEnded: () => undefined,
        flush: () => Promise.resolve(),
      }),
    });
    const result = await h.server.command(runStart("say:x"));
    expect(result).toMatchObject({ ok: false });
    const log = existsSync(path.join(h.sessions, `${THREAD}.jsonl.commands.jsonl`))
      ? await h.commandsLog()
      : [];
    expect(log.find((c) => c.type === "prompt")).toBeUndefined();
  });
});

/** The fake logs stdin lines and each turn_end it emits, in order: abort must follow a turn_end. */
async function expectAbortAfterTurnEnd(): Promise<void> {
  const log = await h.commandsLog();
  const firstTurnEnd = log.findIndex((c) => c.emitted === "turn_end");
  const firstAbort = log.findIndex((c) => c.type === "abort");
  expect(firstTurnEnd).toBeGreaterThan(-1);
  expect(firstAbort).toBeGreaterThan(firstTurnEnd);
}

describe("run.steer and run.stop", () => {
  it("forwards steer to the active run only", async () => {
    h = await startHarness();
    await h.server.command(runStart("hang"));
    const steer = { type: "run.steer", run_id: RUN, thread_id: THREAD, message: "bar chart" };
    expect(await h.server.command(steer)).toMatchObject({
      ok: true,
      data: { disposition: "queued" },
    });
    expect(await h.server.command({ ...steer, run_id: RUN_2 })).toMatchObject({
      ok: false,
      error: { code: "unknown_run" },
    });
    expect((await h.commandsLog()).filter((c) => c.type === "steer")).toEqual([
      { type: "steer", message: "bar chart", id: expect.any(String) },
    ]);
  });

  it("Stop clears Pi's queue, aborts, and answers once the run ended", async () => {
    h = await startHarness();
    await h.server.command(runStart("hang"));
    const stop = await h.server.command({
      type: "run.stop",
      run_id: RUN,
      thread_id: THREAD,
      mode: "abort",
      reason: "user_cancelled",
    });
    expect(stop).toMatchObject({ ok: true });
    const types = (await h.commandsLog()).map((c) => c.type).filter(Boolean);
    expect(types.slice(-2)).toEqual(["clear_queue", "abort"]);
    expect(events().at(-1)?.event.type).toBe("agent_settled");
  });

  it("after_step waits for the in-flight step (turn_end) before aborting", async () => {
    h = await startHarness();
    await h.server.command(runStart("steps"));
    const stop = await h.server.command({
      type: "run.stop",
      run_id: RUN,
      thread_id: THREAD,
      mode: "after_step",
      reason: "budget_exhausted",
    });
    expect(stop).toMatchObject({ ok: true });
    const stream = events().map((f) => f.event.type);
    expect(stream).toContain("turn_end");
    expect(stream.at(-1)).toBe("agent_settled");
    await expectAbortAfterTurnEnd();
  });

  it("after_step arriving between Pi's prompt answer and agent_start still waits for a step", async () => {
    h = await startHarness();
    // Pi answers the prompt at once but starts the run 200 ms later: the stop lands in between.
    await h.server.command(runStart("late-steps"));
    const stop = await h.server.command({
      type: "run.stop",
      run_id: RUN,
      thread_id: THREAD,
      mode: "after_step",
      reason: "budget_exhausted",
    });
    expect(stop).toMatchObject({ ok: true });
    expect(events().map((f) => f.event.type)).toContain("turn_end");
    await expectAbortAfterTurnEnd();
  });
});

describe("pi.command", () => {
  it("forwards allow-listed commands with the agent's own id and returns Pi's data", async () => {
    h = await startHarness();
    const result = await h.server.command({
      type: "pi.command",
      thread_id: THREAD,
      command: { id: "server-chosen", type: "get_state" },
    });
    expect(result).toMatchObject({ ok: true, data: { isStreaming: false } });
    const sent = (await h.commandsLog()).find((c) => c.type === "get_state");
    expect(sent?.id).not.toBe("server-chosen");
  });

  it("refuses fork (not in the contract: it would move Pi off the thread's session file)", async () => {
    h = await startHarness();
    h.server.sendRaw(
      JSON.stringify({
        v: 1,
        type: "pi.command",
        command_id: "fork-1",
        thread_id: THREAD,
        command: { id: "x", type: "fork", entryId: "a1" },
      }),
    );
    await h.server.waitFor((f) => f.type === "error" && f.code === "malformed_frame");
    expect(h.server.frames("command.result").some((r) => r.command_id === "fork-1")).toBe(false);
  });

  it("answers frame_too_large when Pi's data does not fit in one frame", async () => {
    h = await startHarness();
    expect(
      await h.server.command({
        type: "pi.command",
        thread_id: THREAD,
        command: { id: "x", type: "get_tree" },
      }),
    ).toMatchObject({ ok: false, error: { code: "frame_too_large" } });
  });

  it("surfaces Pi errors as pi_rejected", async () => {
    h = await startHarness();
    expect(
      await h.server.command({
        type: "pi.command",
        thread_id: THREAD,
        command: { id: "x", type: "get_entries", since: "nope" },
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "pi_rejected", message: "Entry not found: nope" },
    });
  });
});

describe("Pi output hygiene", () => {
  it("replaces an event too large for one frame by a placeholder, keeping seqs gapless", async () => {
    h = await startHarness();
    await h.server.command(runStart("big"));
    await h.server.waitFor(settled());
    const stream = events();
    expect(stream.map((f) => f.seq)).toEqual(stream.map((_, i) => i + 1));
    expect(stream[1]?.event).toEqual({
      type: "kobe.event_dropped",
      original_type: "tool_execution_update",
      reason: "frame_too_large",
    });
  });

  it("maps U+0000 to U+FFFD and drops __proto__ keys before sending", async () => {
    h = await startHarness();
    await h.server.command(runStart("dirty"));
    await h.server.waitFor(settled());
    const dirty = events().find((f) => f.event.type === "custom_dirty")?.event;
    expect(dirty).toEqual({ type: "custom_dirty", text: "a�b", nested: { ok: 1 } });
  });
});

describe("Pi process lifecycle", () => {
  it("reports an exited Pi with its stderr tail and respawns on the next run", async () => {
    h = await startHarness();
    await h.server.command(runStart("crash"));
    const exited = await h.server.waitFor((f) => f.type === "pi.exited");
    expect(exited).toMatchObject({ thread_id: THREAD, exit_code: 3 });
    expect((exited as { stderr_tail: string }).stderr_tail).toContain("fatal: something broke");
    expect(await h.server.command({ ...runStart("say:again"), run_id: RUN_2 })).toMatchObject({
      ok: true,
    });
    await h.server.waitFor(settled(RUN_2));
  });

  it("never exceeds the process cap when threads start concurrently", async () => {
    h = await startHarness({ env: { KOBE_MAX_PI_PROCESSES: "1" } });
    const [a, b] = await Promise.all([
      h.server.command(runStart("hang")),
      h.server.command({ ...runStart("hang"), run_id: RUN_2, thread_id: THREAD_2 }),
    ]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
  });

  it("does not report a Pi exit for a thread with no active run (not leased)", async () => {
    h = await startHarness();
    const result = await h.server.command({
      type: "pi.command",
      thread_id: THREAD,
      command: { id: "x", type: "get_session_stats" },
    });
    expect(result).toMatchObject({ ok: false, error: { code: "pi_unavailable" } });
    await new Promise((r) => setTimeout(r, 100));
    expect(h.server.frames("pi.exited")).toEqual([]);
  });

  it("reports pi_unavailable when Pi cannot be started", async () => {
    h = await startHarness({ piBin: "/nonexistent/pi" });
    expect(await h.server.command(runStart("say:x"))).toMatchObject({
      ok: false,
      error: { code: "pi_unavailable" },
    });
  });

  it("evicts the least recently used idle Pi at the process cap, never a busy one", async () => {
    h = await startHarness({ env: { KOBE_MAX_PI_PROCESSES: "1" } });
    await h.server.command(runStart("say:one"));
    await h.server.waitFor(settled());
    // Thread 1 is idle: thread 2 takes its slot.
    await h.server.command({ ...runStart("hang"), run_id: RUN_2, thread_id: THREAD_2 });
    // Thread 2 is busy: thread 1 cannot get a slot back.
    expect(
      await h.server.command({
        ...runStart("say:x"),
        run_id: "3e4f5a6b-7c8d-4e9f-8a1b-2c3d4e5f6079",
      }),
    ).toMatchObject({ ok: false, error: { code: "pi_unavailable" } });
  });
});

describe("kobe-policy channel (fd 3)", () => {
  it("relays a check to the server with run/thread ids and the decision back to Pi", async () => {
    h = await startHarness();
    await h.server.command(runStart("tool:bash"));
    const check = await h.server.waitFor((f) => f.type === "policy.check");
    expect(check).toMatchObject({
      run_id: RUN,
      thread_id: THREAD,
      tool: "bash",
      tool_call_id: "call_1",
      input: { command: "ls" },
    });
    h.server.send({
      v: 1,
      type: "policy.result",
      request_id: (check as { request_id: string }).request_id,
      run_id: RUN,
      tool_call_id: "call_1",
      decision: "allow",
      reasons: [{ code: "risk_read", stage: "risk_class", message: "read" }],
    } as never);
    const decision = await h.server.waitFor(
      (f) => f.type === "pi.event" && f.event.type === "kobe_test_policy_decision",
    );
    expect((decision as PiEvent).event).toMatchObject({ decision: "allow" });
  });

  it("delivers a decision whose reason code and stage it does not know (newer server)", async () => {
    h = await startHarness();
    await h.server.command(runStart("tool:bash"));
    const check = await h.server.waitFor((f) => f.type === "policy.check");
    h.server.sendRaw(
      JSON.stringify({
        v: 1,
        type: "policy.result",
        request_id: (check as { request_id: string }).request_id,
        run_id: RUN,
        tool_call_id: "call_1",
        decision: "allow",
        reasons: [
          { code: "a_code_from_the_future", stage: "a_future_stage", message: "new", extra: 1 },
        ],
      }),
    );
    const decision = await h.server.waitFor(
      (f) => f.type === "pi.event" && f.event.type === "kobe_test_policy_decision",
    );
    expect((decision as PiEvent).event).toMatchObject({ decision: "allow" });
    expect(h.server.frames("error")).toEqual([]);
  });

  it("starts no run when kobe-policy refuses to start (fail closed)", async () => {
    h = await startHarness({
      env: { KOBE_POLICY_EXTENSION: "/opt/kobe/pi-extensions/refuse/index.js" },
    });
    const result = await h.server.command(runStart("say:hi"));
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "pi_unavailable",
        message: "kobe-policy did not start: kobe-policy refused to start: fake refusal",
      },
    });
    const prompts = (await h.commandsLog()).filter((c) => c.type === "prompt");
    expect(prompts).toEqual([]);
  });

  it("starts no run when kobe-policy never reports ready (fail closed)", async () => {
    h = await startHarness({
      env: { KOBE_POLICY_EXTENSION: "/opt/kobe/pi-extensions/silent/index.js" },
      policyReadyTimeoutMs: 200,
    });
    const result = await h.server.command(runStart("say:hi"));
    expect(result).toMatchObject({
      ok: false,
      error: { code: "pi_unavailable", message: expect.stringMatching(/did not report ready/) },
    });
    expect((await h.commandsLog()).filter((c) => c.type === "prompt")).toEqual([]);
  });

  it("restarts a Pi whose policy channel closed instead of reusing it", async () => {
    h = await startHarness();
    await h.server.command(runStart("drop-policy"));
    await h.server.waitFor((f) => f.type === "pi.event" && f.event.type === "agent_settled");
    const harness = h;
    const launches = async () => (await harness.commandsLog()).filter((c) => "argv" in c).length;
    expect(await launches()).toBe(1);
    const second = await h.server.command(runStart("say:hi", { run_id: RUN_2 }));
    expect(second).toMatchObject({ ok: true });
    expect(await launches()).toBe(2);
  });

  it("gates pi.command on kobe-policy being ready", async () => {
    h = await startHarness({
      env: { KOBE_POLICY_EXTENSION: "/opt/kobe/pi-extensions/refuse/index.js" },
    });
    const result = await h.server.command({
      type: "pi.command",
      thread_id: THREAD,
      command: { id: "srv", type: "get_state" },
    });
    expect(result).toMatchObject({
      ok: false,
      error: { code: "pi_unavailable", message: expect.stringMatching(/kobe-policy/) },
    });
    expect((await h.commandsLog()).filter((c) => c.type === "get_state")).toEqual([]);
  });

  it("denies pending checks when the connection drops (fail closed)", async () => {
    h = await startHarness();
    await h.server.command(runStart("tool:mcp__jira__create_issue"));
    await h.server.waitFor((f) => f.type === "policy.check");
    h.server.terminate();
    const decision = await h.server.waitFor(
      (f) => f.type === "pi.event" && f.event.type === "kobe_test_policy_decision",
    );
    expect((decision as PiEvent).event).toMatchObject({ decision: "deny" });
  });
});

describe("what a tool started by Pi can reach", () => {
  it("does not inherit the policy channel (fd 3) and cannot re-open it via /proc", async () => {
    h = await startHarness();
    await h.server.command(runStart("grandchild"));
    const probe = await h.server.waitFor(
      (f) => f.type === "pi.event" && f.event.type === "kobe_test_grandchild",
    );
    expect((probe as PiEvent).event).toMatchObject({
      // Its fd 3, if any, is not Pi's policy socket (Node itself opens low fds) ...
      sameChannel: false,
      // ... and the socket cannot be re-opened through /proc (Linux).
      procOpen: false,
      // The env var is inherited (harmless: it names an fd the tool does not have).
      env: ["KOBE_POLICY_FD"],
    });
    await h.server.waitFor(settled());
    // The channel is intact: a real check still goes through.
    await h.server.command({ ...runStart("tool:bash"), run_id: RUN_2 });
    await h.server.waitFor((f) => f.type === "policy.check");
  });

  it("does not inherit the kobe-tools channel (fd 4) either (KOBE-128)", async () => {
    h = await startHarness({ toolsExtension: "/opt/kobe/pi-extensions/kobe-tools/index.js" });
    await h.server.command(runStart("grandchild"));
    const probe = await h.server.waitFor(
      (f) => f.type === "pi.event" && f.event.type === "kobe_test_grandchild",
    );
    expect((probe as PiEvent).event).toMatchObject({
      sameToolsChannel: false,
      fd4Write: false,
      procOpen4: false,
      env: ["KOBE_POLICY_FD", "KOBE_TOOLS_FD"],
    });
    await h.server.waitFor(settled());
  });

  it("control: a tool handed fd 3 sees the channel, and its forged request closes it", async () => {
    h = await startHarness();
    await h.server.command(runStart("grandchild-inherit"));
    const control = await h.server.waitFor(
      (f) => f.type === "pi.event" && f.event.type === "kobe_test_grandchild",
    );
    expect((control as PiEvent).event).toMatchObject({ sameChannel: true, fd3Write: true });
    await h.server.waitFor(settled());
    // The forged line had no nonce: the channel closed. That Pi is not reused: the next run gets a
    // fresh Pi with a fresh channel (and nonce).
    const harness = h;
    const launches = async () => (await harness.commandsLog()).filter((c) => "argv" in c).length;
    expect(await launches()).toBe(1);
    await h.server.command({ ...runStart("tool:bash"), run_id: RUN_2 });
    expect(await launches()).toBe(2);
    await h.server.waitFor((f) => f.type === "policy.check");
  });

  it.skipIf(!existsSync("/proc/self/stat"))(
    "kills tools Pi started in their own process group when the thread's Pi stops",
    async () => {
      h = await startHarness();
      await h.server.command(runStart("orphan"));
      const orphan = await h.server.waitFor(
        (f) => f.type === "pi.event" && f.event.type === "kobe_test_orphan",
      );
      const pid = (orphan as PiEvent).event.pid as number;
      expect(() => process.kill(pid, 0)).not.toThrow();
      await h.server.command({
        type: "run.stop",
        run_id: RUN,
        thread_id: THREAD,
        mode: "abort",
        reason: "user_cancelled",
      });
      await h.agent.stop(500);
      // process.kill(pid, 0) also succeeds on a zombie: check the /proc state, polling.
      await until(() => {
        try {
          return readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]?.startsWith("Z") === true;
        } catch {
          return true; // gone
        }
      });
    },
  );
});

describe("extension UI relay", () => {
  it("forwards dialogs with the run id and relays the answer to Pi", async () => {
    h = await startHarness();
    await h.server.command(runStart("dialog"));
    const request = await h.server.waitFor((f) => f.type === "pi.ui_request");
    expect(request).toMatchObject({
      run_id: RUN,
      thread_id: THREAD,
      request: { id: "ui-1", method: "confirm" },
    });
    h.server.send({
      v: 1,
      type: "pi.ui_response",
      thread_id: THREAD,
      response: { type: "extension_ui_response", id: "ui-1", confirmed: true },
    });
    const answer = await h.server.waitFor(
      (f) => f.type === "pi.event" && f.event.type === "kobe_test_dialog_answer",
    );
    expect((answer as PiEvent).event).toMatchObject({ answer: { confirmed: true } });
  });

  it("cancels open dialogs whose run the server no longer lists after a reconnect", async () => {
    h = await startHarness({ server: { ackRuns: () => [] } });
    await h.server.command(runStart("dialog"));
    await h.server.waitFor((f) => f.type === "pi.ui_request");
    h.server.terminate();
    await h.server.waitForOn(2, (f) => f.type === "hello");
    const cancelledLines = async () =>
      (await h.commandsLog()).filter((c) => c.type === "extension_ui_response" && c.id === "ui-1");
    await until(async () => (await cancelledLines()).length > 0);
    const cancelled = await cancelledLines();
    expect(cancelled).toEqual([{ type: "extension_ui_response", id: "ui-1", cancelled: true }]);
    expect(
      h.server.received.filter((r) => r.connection === 2 && r.frame.type === "pi.ui_request"),
    ).toEqual([]);
  });

  it("re-sends open dialogs after a reconnect", async () => {
    h = await startHarness();
    await h.server.command(runStart("dialog"));
    await h.server.waitFor((f) => f.type === "pi.ui_request");
    h.server.terminate();
    await h.server.waitForOn(2, (f) => f.type === "hello");
    await h.server.waitForOn(2, (f) => f.type === "pi.ui_request");
  });
});

describe("session.restore and branching (D13, D15)", () => {
  const header = {
    type: "session",
    version: 3,
    id: THREAD,
    timestamp: "2026-10-01T22:00:00Z",
    cwd: "/workspace",
  };
  const entry = (id: string, parentId: string | null, role = "user") => ({
    type: "message",
    id,
    parentId,
    timestamp: "2026-10-01T22:00:00Z",
    message: { role, content: id },
  });
  const restore = (part: number, final: boolean, entries: unknown[], extra = {}) => ({
    type: "session.restore",
    thread_id: THREAD,
    part,
    final,
    entries,
    ...extra,
  });

  it("gates the Pi started after a restore on kobe-policy being ready", async () => {
    h = await startHarness({
      env: { KOBE_POLICY_EXTENSION: "/opt/kobe/pi-extensions/refuse/index.js" },
    });
    // The restore itself only writes the session file (no Pi) ...
    expect(await h.server.command(restore(0, true, [entry("a1", null)], { header }))).toMatchObject(
      { ok: true },
    );
    // ... and the Pi that reads it is refused when its kobe-policy does not start.
    const result = await h.server.command({
      type: "pi.command",
      thread_id: THREAD,
      command: { id: "srv", type: "get_entries" },
    });
    expect(result).toMatchObject({
      ok: false,
      error: { code: "pi_unavailable", message: expect.stringMatching(/kobe-policy/) },
    });
    expect((await h.commandsLog()).filter((c) => c.type === "get_entries")).toEqual([]);
  });

  it("rebuilds the session file from parts and Pi reads it", async () => {
    h = await startHarness();
    expect(
      await h.server.command(restore(0, false, [entry("a1", null)], { header })),
    ).toMatchObject({ ok: true, data: { part: 0, entries: 1 } });
    expect(
      await h.server.command(restore(1, true, [entry("b1", "a1", "assistant")])),
    ).toMatchObject({ ok: true, data: { restored: true, entries: 2 } });
    const text = await readFile(path.join(h.sessions, `${THREAD}.jsonl`), "utf8");
    expect(text.trim().split("\n")).toHaveLength(3);
    // The stored cwd is rewritten to this sandbox's workspace (Pi refuses a missing cwd).
    expect(JSON.parse(text.split("\n")[0] ?? "")).toMatchObject({ id: THREAD, cwd: h.workspace });
    const entries = await h.server.command({
      type: "pi.command",
      thread_id: THREAD,
      command: { id: "x", type: "get_entries" },
    });
    expect(entries).toMatchObject({ ok: true, data: { leafId: "b1" } });
  });

  it("refuses out-of-order parts and restores while a run is active", async () => {
    h = await startHarness();
    expect(await h.server.command(restore(1, true, []))).toMatchObject({ ok: false });
    await h.server.command(runStart("hang"));
    expect(await h.server.command(restore(0, true, [], { header }))).toMatchObject({
      ok: false,
      error: { code: "pi_rejected" },
    });
  });

  it("voids a partial restore when the connection drops", async () => {
    h = await startHarness();
    await h.server.command(restore(0, false, [entry("a1", null)], { header }));
    h.server.terminate();
    await h.server.waitForOn(2, (f) => f.type === "hello");
    // The partial temp file disappears once the restore has been voided.
    await until(async () => (await readdir(h.sessions)).every((f) => !f.endsWith(".tmp")));
    // Not "restore in progress": the thread is usable, and part 1 has no part 0 any more.
    expect(await h.server.command(restore(1, true, []))).toMatchObject({ ok: false });
    expect(await h.server.command(runStart("say:x"))).toMatchObject({ ok: true });
  });

  it("branches in place for edit-and-regenerate (parent_entry_id)", async () => {
    h = await startHarness();
    await h.server.command(
      restore(0, true, [entry("a1", null), entry("b1", "a1", "assistant"), entry("c1", "b1")], {
        header,
      }),
    );
    const result = await h.server.command(runStart("say:edited", { parent_entry_id: "b1" }));
    expect(result).toMatchObject({ ok: true });
    await h.server.waitFor(settled());
    const lines = (await readFile(path.join(h.sessions, `${THREAD}.jsonl`), "utf8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines.find((l) => l.type === "custom")).toMatchObject({
      type: "custom",
      parentId: "b1",
      customType: "kobe.branch",
      data: { run_id: RUN },
    });
    expect(
      await h.server.command({ ...runStart("say:x", { parent_entry_id: "zz" }), run_id: RUN_2 }),
    ).toMatchObject({ ok: false, error: { code: "pi_rejected" } });
  });
});
