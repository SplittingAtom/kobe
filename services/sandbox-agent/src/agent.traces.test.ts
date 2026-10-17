import {
  CAPABILITY_TRACE_SPANS,
  formatTraceparent,
  parseSandboxSpan,
  runTraceId,
  type SandboxToServerFrame,
} from "@kobe/protocol";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseModelFile } from "./kobe-models/protocol.js";
import type { ModelWiring } from "./models/types.js";
import { RUN, THREAD, runStart, startHarness, until, type Harness } from "./testing/harness.js";

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

  it("has Pi's first model call carry the run span: the model file holds it when the prompt arrives", async () => {
    const models: ModelWiring = {
      gatewayUrl: "http://model-gateway.kobe.internal:80",
      extension: "/opt/kobe/pi-extensions/kobe-models/index.js",
      tokens: { current: async () => "model-token-".padEnd(40, "1"), onChange: () => () => true },
    };
    h = await startHarness({ models });
    const trace = {
      traceparent: formatTraceparent(runTraceId(RUN), COMMAND_SPAN),
      capture_content: false,
    };
    const model = { alias: "fast", gateway_model: "openai/gpt-fake", api: "openai-completions" };
    expect(
      await h.server.command(runStart("say:Hello", { trace, config: { model } })),
    ).toMatchObject({ ok: true });
    const atPrompt = path.join(h.sessions, `${THREAD}.jsonl.model-at-prompt.jsonl`);
    await until(async () => (await readFile(atPrompt, "utf8").catch(() => "")) !== "");
    const [line] = (await readFile(atPrompt, "utf8")).split("\n");
    const file = parseModelFile(line ?? "");
    expect(file.run_id).toBe(RUN);
    const frame = await h.server.waitFor(
      (f): f is Extract<SandboxToServerFrame, { type: "trace.spans" }> => f.type === "trace.spans",
    );
    const run = frame.spans.map((s) => parseSandboxSpan(s)).find((s) => s?.name === "sandbox.run");
    expect(run).toBeDefined();
    expect(file.traceparent).toBe(formatTraceparent(runTraceId(RUN), run?.span_id ?? ""));
  });
});
