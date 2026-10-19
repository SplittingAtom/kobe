import {
  formatTraceparent,
  parseSandboxSpan,
  runTraceId,
  type SandboxToServerFrame,
} from "@kobe/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { RUN, THREAD, runStart, startHarness, until, type Harness } from "./testing/harness.js";

/**
 * KOBE-444: on SIGTERM (the pod is deleted, evicted or drained) a run still active after the drain
 * deadline is lost, not finished. The agent stops Pi without aborting the run (so Pi never settles
 * it and the server never ends it completed or failed), waits until the server has stored every
 * frame of the run already sent, then reports it with `pi.exited`, so the server interrupts it
 * (Retry and Continue). A server-requested `shutdown` (hibernation) still aborts and settles.
 */
let h: Harness;
afterEach(async () => {
  expect(h.server.violations).toEqual([]);
  await h.close();
});

const settledFrames = () =>
  h.server.frames("pi.event").filter((f) => f.event.type === "agent_settled");
const lastSeq = () => Math.max(0, ...h.server.frames("pi.event").map((f) => f.seq));

describe("SIGTERM: active runs are reported lost (KOBE-444)", () => {
  it("reports a run still active after the deadline with pi.exited and never aborts it", async () => {
    h = await startHarness();
    await h.server.command(runStart("hang"));
    await h.server.waitFor((f) => f.type === "pi.event" && f.event.type === "agent_start");
    await h.agent.terminate(100);
    expect(h.exits).toEqual([0]);
    expect(h.server.frames("pi.exited")).toEqual([
      {
        v: 1,
        type: "pi.exited",
        thread_id: THREAD,
        exit_code: null,
        signal: "SIGTERM",
        stderr_tail: "",
      },
    ]);
    expect(settledFrames()).toEqual([]);
    const types = (await h.commandsLog()).map((c) => c.type);
    expect(types).not.toContain("abort");
  });

  it("reports the run only after the server stored every frame already sent", async () => {
    h = await startHarness({ server: { autoAck: false } });
    await h.server.command(runStart("hang"));
    await h.server.waitFor((f) => f.type === "pi.event" && f.event.type === "agent_start");
    const stopping = h.agent.terminate(50);
    await new Promise((r) => setTimeout(r, 400));
    // Pi is stopped, but the run's frames are not acked yet: not reported, not exited.
    expect(h.server.frames("pi.exited")).toEqual([]);
    expect(h.exits).toEqual([]);
    h.server.send({ v: 1, type: "ack", run_id: RUN, seq: lastSeq() });
    await stopping;
    expect(h.server.frames("pi.exited").map((f) => f.thread_id)).toEqual([THREAD]);
    expect(h.exits).toEqual([0]);
  });

  it("re-sends un-acked frames after a reconnect before reporting the run", async () => {
    h = await startHarness({ server: { autoAck: false } });
    await h.server.command(runStart("hang"));
    await h.server.waitFor((f) => f.type === "pi.event" && f.event.type === "agent_start");
    const sent = lastSeq();
    const stopping = h.agent.terminate(50);
    await new Promise((r) => setTimeout(r, 200));
    expect(h.server.frames("pi.exited")).toEqual([]);
    h.server.terminate();
    // The new connection's hello still lists the run; the fake server acks what it resends.
    await until(() => h.server.received.filter((r) => r.frame.type === "hello").length >= 2, 5000);
    h.server.send({ v: 1, type: "ack", run_id: RUN, seq: sent });
    await stopping;
    expect(h.server.frames("pi.exited").map((f) => f.thread_id)).toEqual([THREAD]);
  });

  it("reports the run after a bounded wait when the server never acks", async () => {
    h = await startHarness({ server: { autoAck: false }, lostAckTimeoutMs: 300 });
    await h.server.command(runStart("hang"));
    await h.server.waitFor((f) => f.type === "pi.event" && f.event.type === "agent_start");
    await h.agent.terminate(50);
    expect(h.server.frames("pi.exited").map((f) => f.thread_id)).toEqual([THREAD]);
    expect(h.exits).toEqual([0]);
  });

  it("lets a run that ends within the deadline settle, and reports nothing", async () => {
    h = await startHarness();
    await h.server.command(runStart("say:Hello"));
    await h.agent.terminate(2000);
    expect(settledFrames()).toHaveLength(1);
    expect(h.server.frames("pi.exited")).toEqual([]);
  });

  it("a server shutdown (hibernation) still aborts the run, which settles", async () => {
    h = await startHarness();
    await h.server.command(runStart("hang"));
    h.server.send({ v: 1, type: "shutdown", reason: "hibernate", deadline_ms: 100 });
    await until(() => h.exits.length > 0);
    expect(h.server.frames("pi.exited")).toEqual([]);
    expect(settledFrames()).toHaveLength(1);
  });

  it("ends the lost run's span as pi_exited, not completed", async () => {
    h = await startHarness();
    const trace = {
      traceparent: formatTraceparent(runTraceId(RUN), "c0c0c0c0c0c0c0c0"),
      capture_content: false,
    };
    await h.server.command(runStart("hang", { trace }));
    await h.server.waitFor((f) => f.type === "pi.event" && f.event.type === "agent_start");
    await h.agent.terminate(50);
    const spans = h.server
      .frames("trace.spans")
      .flatMap((f: Extract<SandboxToServerFrame, { type: "trace.spans" }>) => f.spans)
      .map((sp) => parseSandboxSpan(sp));
    const run = spans.find((sp) => sp?.name === "sandbox.run");
    expect(run?.attributes).toMatchObject({ "kobe.run.outcome": "failed" });
  });
});
