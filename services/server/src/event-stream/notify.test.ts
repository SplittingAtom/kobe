import { describe, expect, it } from "vitest";
import { decodeHint, encodeHint } from "./notify.js";

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
