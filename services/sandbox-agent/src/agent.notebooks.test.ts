import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { KernelManager } from "./notebook/manager.js";
import { fakeLauncher } from "./notebook/testing/fake-bridge.js";
import { RUN, THREAD, startHarness, until, type Harness } from "./testing/harness.js";

let h: Harness;
afterEach(async () => {
  expect(h.server.violations).toEqual([]);
  await h.close();
});

function kernels() {
  const { launch, control } = fakeLauncher();
  const manager = new KernelManager({
    launch,
    maxKernels: 2,
    idleMs: 60_000,
    log: () => undefined,
  });
  return { manager, control };
}

const execute = (code: string, commandId = randomUUID()) => ({
  v: 1,
  type: "notebook.execute",
  command_id: commandId,
  thread_id: THREAD,
  run_id: RUN,
  exec_id: randomUUID(),
  code,
  timeout_ms: 10_000,
});

describe("thread kernels on the wire (KOBE-464)", () => {
  it("announces notebooks only with kernels", async () => {
    h = await startHarness();
    expect(h.server.frames("hello")[0]?.capabilities ?? []).not.toContain("notebooks");
    await h.close();
    h = await startHarness({ kernels: kernels().manager });
    expect(h.server.frames("hello")[0]?.capabilities).toContain("notebooks");
  });

  it("streams an execution's outputs naming its command, then answers it", async () => {
    h = await startHarness({ kernels: kernels().manager });
    h.server.send(execute("result:42", "cmd-1"));
    const result = await h.server.waitFor(
      (f) => f.type === "command.result" && f.command_id === "cmd-1",
    );
    expect(result).toMatchObject({
      ok: true,
      data: { status: "ok", execution_count: 1, outputs: 1, truncated: false },
    });
    expect(h.server.frames("notebook.output")).toEqual([
      {
        v: 1,
        type: "notebook.output",
        command_id: "cmd-1",
        thread_id: THREAD,
        index: 0,
        output: {
          output_type: "execute_result",
          execution_count: 1,
          data: { "text/plain": "42" },
          metadata: {},
        },
      },
    ]);
  });

  it("interrupts and restarts on command", async () => {
    const k = kernels();
    h = await startHarness({ kernels: k.manager });
    h.server.send(execute("sleep", "cmd-run"));
    await until(() => k.control.launched.length === 1);
    await new Promise((r) => setTimeout(r, 20));
    h.server.send({ v: 1, type: "notebook.interrupt", command_id: "cmd-int", thread_id: THREAD });
    await h.server.waitFor((f) => f.type === "command.result" && f.command_id === "cmd-int");
    const run = await h.server.waitFor(
      (f) => f.type === "command.result" && f.command_id === "cmd-run",
    );
    expect(run).toMatchObject({ ok: true, data: { status: "interrupted" } });
    h.server.send({ v: 1, type: "notebook.restart", command_id: "cmd-rs", thread_id: THREAD });
    const restarted = await h.server.waitFor(
      (f) => f.type === "command.result" && f.command_id === "cmd-rs",
    );
    expect(restarted).toMatchObject({ ok: true, data: { status: "restarted" } });
    expect(k.control.killed).toEqual([THREAD]);
  });

  it("refuses kernel commands without kernels", async () => {
    h = await startHarness();
    h.server.send(execute("print:x", "cmd-x"));
    const result = await h.server.waitFor(
      (f) => f.type === "command.result" && f.command_id === "cmd-x",
    );
    expect(result).toMatchObject({ ok: false, error: { code: "unknown_type" } });
  });

  it("stops every kernel when the agent stops", async () => {
    const k = kernels();
    h = await startHarness({ kernels: k.manager });
    h.server.send(execute("print:x", "cmd-1"));
    await h.server.waitFor((f) => f.type === "command.result" && f.command_id === "cmd-1");
    await h.agent.stop(1000);
    expect(k.control.killed).toEqual([THREAD]);
  });
});
