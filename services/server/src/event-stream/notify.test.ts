import { describe, expect, it } from "vitest";
import { decodeAccessHint, decodeHint, encodeAccessHint, encodeHint } from "./notify.js";

const RUN = "0b6f0d4e-5a3c-4d8e-9a43-5f7b0f2d1c11";

describe("run events hint codec", () => {
  it("round-trips ids only", () => {
    const payload = encodeHint({ runId: RUN, seq: 42 });
    expect(payload).toBe(`${RUN}:42`);
    expect(decodeHint(payload)).toEqual({ runId: RUN, seq: 42 });
  });

  it.each([
    undefined,
    "",
    RUN,
    `${RUN}:`,
    `${RUN}:0`,
    `${RUN}:-1`,
    `${RUN}:1.5`,
    `${RUN}:01`,
    `not-a-uuid:1`,
    `${RUN}:99999999999999999`,
    `${RUN}:1:2`,
    "x".repeat(100),
  ])("ignores malformed payload %j", (payload) => {
    expect(decodeHint(payload)).toBeUndefined();
  });
});

describe("thread access hint (KOBE-221)", () => {
  it("round-trips the run id only, and is never read as an events hint", () => {
    const payload = encodeAccessHint(RUN);
    expect(payload).toBe(`access:${RUN}`);
    expect(decodeAccessHint(payload)).toBe(RUN);
    expect(decodeAccessHint(payload.toUpperCase().replace("ACCESS", "access"))).toBe(RUN);
    expect(decodeHint(payload)).toBeUndefined();
  });

  it.each([undefined, "", "access:", "access:nope", `${RUN}:1`, `access:${RUN}x`, "x".repeat(100)])(
    "ignores malformed payload %j",
    (payload) => {
      expect(decodeAccessHint(payload)).toBeUndefined();
    },
  );
});
