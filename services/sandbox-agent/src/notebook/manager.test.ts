import { randomUUID } from "node:crypto";
import type { NotebookExecuteFrame, NotebookOutput } from "@kobe/protocol";
import { describe, expect, it } from "vitest";
import { OUTPUT_LIMITS } from "./outputs.js";
import { KernelManager, type KernelManagerOptions } from "./manager.js";
import { fakeLauncher, type FakeBridgeOptions } from "./testing/fake-bridge.js";

const T1 = randomUUID();
const T2 = randomUUID();
const RUN = randomUUID();

function setup(options: Partial<KernelManagerOptions> = {}, bridge: FakeBridgeOptions = {}) {
  const { launch, control } = fakeLauncher(bridge);
  const logs: string[] = [];
  const manager = new KernelManager({
    launch,
    maxKernels: 2,
    idleMs: 60_000,
    graceMs: 50,
    readyTimeoutMs: 200,
    log: (m) => logs.push(m),
    ...options,
  });
  return { manager, control, logs };
}

function frame(threadId: string, code: string, timeoutMs = 10_000): NotebookExecuteFrame {
  return {
    v: 1,
    type: "notebook.execute",
    command_id: randomUUID(),
    thread_id: threadId,
    run_id: RUN,
    exec_id: randomUUID(),
    code,
    timeout_ms: timeoutMs,
  };
}

async function run(manager: KernelManager, f: NotebookExecuteFrame) {
  const outputs: { index: number; output: NotebookOutput }[] = [];
  const outcome = await manager.execute(f, (index, output) => outputs.push({ index, output }));
  return { outcome, outputs };
}

describe("KernelManager (NB2, NB7, NB8)", () => {
  it("starts a kernel per thread on first use and keeps it across executions", async () => {
    const { manager, control } = setup();
    const first = await run(manager, frame(T1, "print:hello\n"));
    expect(first.outcome).toEqual({
      ok: true,
      data: { status: "ok", execution_count: 1, outputs: 1, truncated: false },
    });
    expect(first.outputs).toEqual([
      { index: 0, output: { output_type: "stream", name: "stdout", text: "hello\n" } },
    ]);
    const second = await run(manager, frame(T1, "result:2"));
    expect(second.outcome).toMatchObject({ ok: true, data: { status: "ok", execution_count: 2 } });
    expect(control.launched).toEqual([T1]);
    await run(manager, frame(T2, "print:x"));
    expect(control.launched).toEqual([T1, T2]);
    await manager.stopAll();
  });

  it("runs one execution at a time per thread, in order", async () => {
    const { manager } = setup();
    const order: string[] = [];
    await Promise.all(
      ["a", "b", "c"].map((name) =>
        manager
          .execute(frame(T1, `print:${name}`), (_, o) =>
            order.push(o.output_type === "stream" ? o.text : ""),
          )
          .then(() => undefined),
      ),
    );
    expect(order).toEqual(["a", "b", "c"]);
    await manager.stopAll();
  });

  it("interrupts a running cell and keeps the kernel", async () => {
    const { manager, control } = setup();
    const running = run(manager, frame(T1, "sleep"));
    await new Promise((r) => setTimeout(r, 20));
    expect(manager.interrupt(T1)).toEqual({ ok: true, data: { status: "interrupted" } });
    const { outcome, outputs } = await running;
    expect(outcome).toMatchObject({ ok: true, data: { status: "interrupted" } });
    expect(outputs[0]?.output).toMatchObject({ output_type: "error", ename: "KeyboardInterrupt" });
    expect(manager.interrupt(T1)).toEqual({ ok: true, data: { status: "idle" } });
    expect(manager.interrupt(T2)).toEqual({ ok: true, data: { status: "no_kernel" } });
    expect(control.killed).toEqual([]);
    await manager.stopAll();
  });

  it("times out a cell: interrupt first, then stop a kernel that does not answer", async () => {
    const { manager, control } = setup();
    const soft = await run(manager, frame(T1, "sleep", 1000));
    expect(soft.outcome).toMatchObject({ ok: true, data: { status: "timeout" } });
    expect(control.killed).toEqual([]);
    const hard = await run(manager, frame(T1, "hang", 1000));
    expect(hard.outcome).toMatchObject({
      ok: true,
      data: { status: "timeout", execution_count: null },
    });
    expect(control.killed).toEqual([T1]);
    expect(manager.size).toBe(0);
    // The next execution gets a fresh kernel.
    await run(manager, frame(T1, "print:again"));
    expect(control.launched).toEqual([T1, T1]);
    await manager.stopAll();
  });

  it("restart stops the kernel: a running cell ends restarted, queued ones too", async () => {
    const { manager, control } = setup();
    const running = run(manager, frame(T1, "hang"));
    const queued = run(manager, frame(T1, "print:later"));
    await new Promise((r) => setTimeout(r, 20));
    expect(await manager.restart(T1)).toEqual({ ok: true, data: { status: "restarted" } });
    expect((await running).outcome).toMatchObject({ ok: true, data: { status: "restarted" } });
    expect((await queued).outcome).toMatchObject({ ok: true, data: { status: "restarted" } });
    expect(control.killed).toEqual([T1]);
    expect(await manager.restart(T1)).toEqual({ ok: true, data: { status: "no_kernel" } });
  });

  it("a kernel that dies ends the cell with an error and a note", async () => {
    const { manager } = setup();
    const { outcome, outputs } = await run(manager, frame(T1, "die"));
    expect(outcome).toMatchObject({ ok: true, data: { status: "error" } });
    expect(outputs.at(-1)?.output).toMatchObject({ output_type: "stream", name: "stderr" });
    expect(manager.size).toBe(0);
  });

  it("refuses when every kernel is busy, and stops the least recently used idle one", async () => {
    const { manager, control } = setup({ maxKernels: 1 });
    await run(manager, frame(T1, "print:a"));
    await run(manager, frame(T2, "print:b"));
    expect(control.killed).toEqual([T1]);
    const busy = run(manager, frame(T2, "hang"));
    await new Promise((r) => setTimeout(r, 20));
    const refused = await run(manager, frame(T1, "print:c"));
    expect(refused.outcome).toMatchObject({ ok: false, code: "kernel_unavailable" });
    await manager.stopAll();
    await busy;
  });

  it("a kernel that does not start is kernel_unavailable", async () => {
    const neverReady = setup({}, { neverReady: true });
    expect((await run(neverReady.manager, frame(T1, "print:a"))).outcome).toMatchObject({
      ok: false,
      code: "kernel_unavailable",
    });
    expect(neverReady.control.killed).toEqual([T1]);
    const fatal = setup({}, { fatal: "No module named ipykernel" });
    expect((await run(fatal.manager, frame(T1, "print:a"))).outcome).toMatchObject({
      ok: false,
      code: "kernel_unavailable",
      message: "No module named ipykernel",
    });
  });

  it("stops an idle kernel after idleMs", async () => {
    const { manager, control } = setup({ idleMs: 30 });
    await run(manager, frame(T1, "print:a"));
    await new Promise((r) => setTimeout(r, 80));
    expect(control.killed).toEqual([T1]);
    expect(manager.size).toBe(0);
  });

  it("caps an execution's outputs (NB9)", async () => {
    const { manager } = setup({ limits: { ...OUTPUT_LIMITS, maxOutputs: 10 } });
    const { outcome, outputs } = await run(manager, frame(T1, "flood:50"));
    expect(outcome).toMatchObject({
      ok: true,
      data: { status: "ok", outputs: 10, truncated: true },
    });
    expect(outputs).toHaveLength(10);
    await manager.stopAll();
  });

  it("interrupts the cell of a run that ended", async () => {
    const { manager, control } = setup();
    const running = run(manager, frame(T1, "sleep"));
    await new Promise((r) => setTimeout(r, 20));
    manager.runEnded(randomUUID());
    expect(control.interrupts).toEqual([]);
    manager.runEnded(RUN);
    expect((await running).outcome).toMatchObject({ ok: true, data: { status: "interrupted" } });
    await manager.stopAll();
  });

  it("an interrupt also drops executions still waiting, which never run", async () => {
    const { manager } = setup();
    const running = run(manager, frame(T1, "sleep"));
    const queued = run(manager, frame(T1, "print:never"));
    await new Promise((r) => setTimeout(r, 20));
    expect(manager.interrupt(T1)).toEqual({ ok: true, data: { status: "interrupted" } });
    expect((await running).outcome).toMatchObject({ ok: true, data: { status: "interrupted" } });
    const skipped = await queued;
    expect(skipped.outcome).toMatchObject({
      ok: true,
      data: { status: "interrupted", execution_count: null },
    });
    expect(JSON.stringify(skipped.outputs)).not.toContain("never");
    await manager.stopAll();
  });

  it("drops the waiting executions of a run that ended, and only those", async () => {
    const { manager } = setup();
    const firstRun = randomUUID();
    const running = run(manager, { ...frame(T1, "sleep"), run_id: firstRun });
    const mine = run(manager, frame(T1, "print:mine"));
    const other = run(manager, { ...frame(T1, "print:other"), run_id: randomUUID() });
    await new Promise((r) => setTimeout(r, 20));
    manager.runEnded(RUN);
    manager.runEnded(firstRun);
    expect((await running).outcome).toMatchObject({ data: { status: "interrupted" } });
    expect((await mine).outcome).toMatchObject({ data: { status: "interrupted" } });
    const ran = await other;
    expect(ran.outcome).toMatchObject({ data: { status: "ok" } });
    expect(ran.outputs[0]?.output).toMatchObject({ text: "other" });
    await manager.stopAll();
  });

  it("never runs an execution whose deadline passed while it waited", async () => {
    const { manager } = setup();
    const hung = run(manager, frame(T1, "hang", 1000));
    const late = run(manager, frame(T1, "print:late", 1000));
    expect((await hung).outcome).toMatchObject({ data: { status: "timeout" } });
    const skipped = await late;
    expect(skipped.outcome).toMatchObject({ data: { status: "timeout", execution_count: null } });
    expect(JSON.stringify(skipped.outputs)).not.toContain('late"');
  });

  it("refuses new work once stopping", async () => {
    const { manager } = setup();
    await manager.stopAll();
    expect((await run(manager, frame(T1, "print:a"))).outcome).toMatchObject({
      ok: false,
      code: "kernel_unavailable",
    });
  });
});
