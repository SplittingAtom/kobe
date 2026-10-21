import type { KobeEvent, KobeEventPayload, KobeEventType } from "@kobe/protocol";
import { describe, expect, it } from "vitest";
import {
  NotebookExecStore,
  agentCodeRuns,
  egressNotices,
  kernelBusy,
  latestRun,
} from "./executions";

const RUN = "00000000-0000-4000-8000-000000000101";
const RUN2 = "00000000-0000-4000-8000-000000000102";
const E1 = "00000000-0000-4000-8000-000000000301";
const E2 = "00000000-0000-4000-8000-000000000302";
const TH = "th1";

let seq = 0;
function ev<T extends KobeEventType>(type: T, payload: KobeEventPayload<T>, run = RUN): KobeEvent {
  seq += 1;
  return { run_id: run, seq, ts: "2026-10-21T10:00:00Z", type, payload } as KobeEvent;
}
const out = (exec: string, index: number, text: string) =>
  ev("notebook.output", {
    exec_id: exec,
    index,
    output: { output_type: "stream", name: "stdout", text },
  });

describe("NotebookExecStore", () => {
  it("assembles an execution from its events, idempotently and in index order", () => {
    const store = new NotebookExecStore();
    let changes = 0;
    store.subscribe(() => changes++);
    const events = [
      ev("notebook.started", { exec_id: E1, origin: "user", path: "a.ipynb", cell_id: "c1" }),
      out(E1, 1, "second"),
      out(E1, 0, "first"),
    ];
    store.apply(TH, events);
    store.apply(TH, events); // a replay changes nothing
    expect(changes).toBe(1);
    const [exec] = store.snapshot();
    expect(exec).toMatchObject({ threadId: TH, runId: RUN, execId: E1, cellId: "c1" });
    expect(exec?.outputs.map((o) => o?.output_type === "stream" && o.text)).toEqual([
      "first",
      "second",
    ]);
    expect(kernelBusy(store.snapshot(), TH)).toBe(true);
    expect(latestRun(store.snapshot(), TH, "a.ipynb", "c1")?.execId).toBe(E1);
    expect(latestRun(store.snapshot(), TH, "a.ipynb", "c2")).toBeUndefined();
    expect(latestRun(store.snapshot(), "other", "a.ipynb", "c1")).toBeUndefined();

    const saved = { path: "a.ipynb", sha256: "f".repeat(64) };
    store.apply(TH, [
      ev("notebook.finished", {
        exec_id: E1,
        status: "ok",
        execution_count: 4,
        outputs: 2,
        truncated: false,
        saved,
      }),
    ]);
    expect(store.snapshot()[0]?.finished).toMatchObject({ status: "ok", saved });
    expect(kernelBusy(store.snapshot(), TH)).toBe(false);
  });

  it("ends executions a run ended without finishing", () => {
    const store = new NotebookExecStore();
    store.apply(TH, [
      ev("notebook.started", { exec_id: E1, origin: "user", path: "x.py" }),
      ev("run.interrupted", { reason: "cancelled", last_entry_id: null, retryable: false }),
    ]);
    expect(store.snapshot()[0]?.finished).toMatchObject({ status: "interrupted", saved: null });
    store.apply(TH, [
      ev("notebook.started", { exec_id: E2, origin: "agent", tool_call_id: "t1" }, RUN2),
      ev("run.failed", { error: { code: "x", message: "y" } }, RUN2),
    ]);
    expect(store.snapshot()[1]?.finished?.status).toBe("failed");
    expect(latestRun(store.snapshot(), TH, "x.py")?.execId).toBe(E1);
    expect(agentCodeRuns(store.snapshot(), TH).map((e) => e.execId)).toEqual([E2]);
  });

  it("ends a run's executions when its stream closed without their end", () => {
    const store = new NotebookExecStore();
    store.apply(TH, [ev("notebook.started", { exec_id: E1, origin: "user", path: "x.py" })]);
    let changes = 0;
    store.subscribe(() => changes++);
    store.endRun("other-run");
    expect(changes).toBe(0);
    store.endRun(RUN);
    store.endRun(RUN);
    expect(changes).toBe(1);
    expect(store.snapshot()[0]?.finished?.status).toBe("failed");
  });

  it("keeps blocked domains of the member's own notebook runs", () => {
    const store = new NotebookExecStore();
    store.apply(TH, [
      ev("notebook.started", { exec_id: E1, origin: "user", path: "x.py" }),
      ev("egress.blocked", { domain: "example.com", request_access: true }),
      ev("egress.blocked", { domain: "example.com", request_access: true }),
    ]);
    store.apply(TH, [
      ev("notebook.started", { exec_id: E2, origin: "agent" }, RUN2),
      ev("egress.blocked", { domain: "agent.example", request_access: true }, RUN2),
    ]);
    expect(egressNotices(store.snapshot(), store.egress(), TH, "x.py")).toEqual([
      { runId: RUN, payload: { domain: "example.com", request_access: true } },
    ]);
  });

  it("forgets the oldest executions past its cap", () => {
    const store = new NotebookExecStore(2);
    for (const id of [E1, E2, "00000000-0000-4000-8000-000000000303"]) {
      store.apply(TH, [ev("notebook.started", { exec_id: id, origin: "agent" })]);
    }
    expect(store.snapshot().map((e) => e.execId)).toEqual([
      E2,
      "00000000-0000-4000-8000-000000000303",
    ]);
  });
});
