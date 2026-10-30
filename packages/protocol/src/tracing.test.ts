import { describe, expect, it } from "vitest";
import {
  formatTraceparent,
  parseTraceparent,
  runRootSpanId,
  runTraceId,
  traceparentSchema,
} from "./index.js";
import { deriveTraceSpanKey, mapSandboxSpanId } from "./node/index.js";
import { EXAMPLE_IDS } from "./testing/index.js";

const RUN = EXAMPLE_IDS.run;

/** KOBE-274: ids every component derives for a run's trace. */
describe("run trace ids", () => {
  it("uses the run id's hex digits as the trace id and its low 64 bits as the root span id", () => {
    expect(runTraceId(RUN)).toBe("3e4f5a6b7c8d4e9f8a1b2c3d4e5f6071");
    expect(runRootSpanId(RUN)).toBe("8a1b2c3d4e5f6071");
  });

  it("is a different trace for every run", () => {
    expect(runTraceId(EXAMPLE_IDS.thread)).not.toBe(runTraceId(RUN));
  });

  it("refuses anything but a lowercase, non-nil uuid", () => {
    for (const bad of [
      RUN.toUpperCase(),
      "not-a-uuid",
      "",
      "00000000-0000-0000-0000-000000000000",
    ]) {
      expect(() => runTraceId(bad), bad).toThrow();
    }
  });

  it("never yields an all-zero root span id", () => {
    expect(runRootSpanId("12345678-1234-4234-0000-000000000000")).toBe("0000000000000001");
  });
});

describe("traceparent", () => {
  const tp = formatTraceparent(runTraceId(RUN), runRootSpanId(RUN));

  it("formats and parses version 00, sampled by default", () => {
    expect(tp).toBe(`00-${runTraceId(RUN)}-${runRootSpanId(RUN)}-01`);
    expect(parseTraceparent(tp)).toEqual({
      traceId: runTraceId(RUN),
      parentSpanId: runRootSpanId(RUN),
      sampled: true,
    });
    expect(parseTraceparent(tp.replace(/-01$/, "-00"))?.sampled).toBe(false);
  });

  it("rejects other versions, upper case, all-zero ids and extra parts", () => {
    for (const bad of [
      tp.replace(/^00/, "01"),
      tp.toUpperCase(),
      `00-${"0".repeat(32)}-${runRootSpanId(RUN)}-01`,
      `00-${runTraceId(RUN)}-${"0".repeat(16)}-01`,
      `${tp}-extra`,
      ` ${tp}`,
    ]) {
      expect(traceparentSchema.safeParse(bad).success, bad).toBe(false);
      expect(parseTraceparent(bad), bad).toBeUndefined();
    }
    expect(() => formatTraceparent("0".repeat(32), runRootSpanId(RUN))).toThrow();
  });
});

describe("sandbox span id remapping (k_trace)", () => {
  const master = new TextEncoder().encode("m".repeat(32));
  const key = deriveTraceSpanKey(master);

  it("is deterministic per run and key, and differs across runs and keys", () => {
    const id = mapSandboxSpanId(key, RUN, "1111111111111111");
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    expect(mapSandboxSpanId(key, RUN, "1111111111111111")).toBe(id);
    expect(mapSandboxSpanId(key, EXAMPLE_IDS.thread, "1111111111111111")).not.toBe(id);
    const other = deriveTraceSpanKey(new TextEncoder().encode("n".repeat(32)));
    expect(mapSandboxSpanId(other, RUN, "1111111111111111")).not.toBe(id);
    expect(id).not.toBe("1111111111111111");
  });

  it("is derived, never the secret itself, and refuses short secrets", () => {
    expect(Buffer.from(key).equals(Buffer.from(master))).toBe(false);
    expect(() => deriveTraceSpanKey(new Uint8Array(8))).toThrow();
    expect(() => mapSandboxSpanId(new Uint8Array(8), RUN, "1111111111111111")).toThrow();
  });
});
