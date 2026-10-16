import {
  CAPABILITY_TRACE_SPANS,
  formatTraceparent,
  parseSandboxSpan,
  runTraceId,
  type SandboxToServerFrame,
} from "@kobe/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { RUN, runStart, startHarness, type Harness } from "./testing/harness.js";

/** KOBE-274 ac-5 / ac-2 (sandbox side): span frames only for runs started with a trace context. */
let h: Harness;
afterEach(async () => {
  expect(h.server.violations).toEqual([]);
  await h.close();
});

const settled = (f: SandboxToServerFrame) =>
  f.type === "pi.event" && f.run_id === RUN && f.event.type === "agent_settled";
const COMMAND_SPAN = "c0c0c0c0c0c0c0c0";

describe("run spans over the wire (KOBE-274)", () => {
  it("announces trace_spans", async () => {
    h = await startHarness();
    const [hello] = h.server.frames("hello");
    expect(hello?.capabilities).toContain(CAPABILITY_TRACE_SPANS);
  });

  it("sends no span frames for a run started without a trace context (tracing off)", async () => {
    h = await startHarness();
    expect(await h.server.command(runStart("say:Hello"))).toMatchObject({ ok: true });
    await h.server.waitFor(settled);
    await new Promise((r) => setTimeout(r, 300));
    expect(h.server.frames("trace.spans")).toEqual([]);
  });

  it("sends the run's spans, parented to the command span, with no content when capture is off", async () => {
    h = await startHarness();
    const trace = {
      traceparent: formatTraceparent(runTraceId(RUN), COMMAND_SPAN),
      capture_content: false,
    };
    expect(await h.server.command(runStart("say:Hello", { trace }))).toMatchObject({ ok: true });
    await h.server.waitFor(settled);
    const frame = await h.server.waitFor(
      (f): f is Extract<SandboxToServerFrame, { type: "trace.spans" }> => f.type === "trace.spans",
    );
    expect(frame.run_id).toBe(RUN);
    const spans = frame.spans.map((s) => parseSandboxSpan(s));
    expect(spans.every((s) => s !== undefined)).toBe(true);
    const run = spans.find((s) => s?.name === "sandbox.run");
    expect(run?.parent_span_id).toBe(COMMAND_SPAN);
    expect(run?.attributes).toMatchObject({ "kobe.run.outcome": "completed" });
    expect(JSON.stringify(frame)).not.toMatch(/Hello/);
  });
});
