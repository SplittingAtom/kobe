import { runRootSpanId, runTraceId, type ServerCallClaims } from "@kobe/protocol";
import { deriveTraceSpanKey } from "@kobe/protocol/node";
import {
  InMemorySpanExporter,
  initTelemetry,
  trace,
  type Context,
  type Telemetry,
} from "@kobe/telemetry";
import { afterEach, describe, expect, it } from "vitest";
import { placeRequestSpan, type GatewayTracing } from "./trace-placement.js";

const TEAM = "0b6f1c2e-6d1a-4c56-9a43-1f0e2d3c4b5a";
const RUN = "3e4f5a6b-7c8d-4e9f-8a1b-2c3d4e5f6071";
const THREAD = "2d3e4f5a-6b7c-4d8e-9f0a-1b2c3d4e5f60";
const USER = "1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
const spanKey = deriveTraceSpanKey(new TextEncoder().encode("k".repeat(32)));

let telemetry: Telemetry | undefined;
afterEach(async () => {
  await telemetry?.shutdown();
  telemetry = undefined;
});
const on = () => {
  telemetry = initTelemetry(
    {
      enabled: true,
      endpoint: "http://x:4318",
      headers: {},
      captureContent: false,
      serviceName: "t",
    },
    { exporter: new InMemorySpanExporter() },
  );
};
const parentOf = (ctx: Context) => trace.getSpanContext(ctx);

describe("placeRequestSpan (KOBE-274)", () => {
  const claims = { thread_id: THREAD, user_id: USER, run_id: RUN } as ServerCallClaims;

  it("puts a server call under its run's root with the claims' session", async () => {
    on();
    const placed = await placeRequestSpan(
      undefined,
      { traceparent: "junk" },
      {
        teamId: TEAM,
        runId: RUN,
        serverCall: claims,
      },
    );
    expect(parentOf(placed.parent)).toMatchObject({
      traceId: runTraceId(RUN),
      spanId: runRootSpanId(RUN),
    });
    expect(placed.attributes).toEqual({
      "kobe.thread_id": THREAD,
      "session.id": THREAD,
      "user.id": USER,
    });
  });

  it("starts fresh with tracing off or no run, and survives a failing session lookup", async () => {
    const failing: GatewayTracing = {
      spanKey,
      runSession: () => Promise.reject(new Error("db down")),
    };
    const off = await placeRequestSpan(
      failing,
      {},
      { teamId: TEAM, runId: RUN, serverCall: undefined },
    );
    expect(parentOf(off.parent)).toBeUndefined();
    on();
    const noRun = await placeRequestSpan(
      failing,
      {},
      {
        teamId: TEAM,
        runId: undefined,
        serverCall: undefined,
      },
    );
    expect(parentOf(noRun.parent)).toBeUndefined();
    const failed = await placeRequestSpan(
      failing,
      {},
      { teamId: TEAM, runId: RUN, serverCall: undefined },
    );
    expect(parentOf(failed.parent)?.traceId).toBe(runTraceId(RUN));
    expect(failed.attributes).toEqual({});
  });
});
