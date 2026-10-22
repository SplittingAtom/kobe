import { SANDBOX_MAX_FRAME_BYTES, SANDBOX_SEND_PACE } from "@kobe/protocol";
import { describe, expect, it } from "vitest";
import { WIRE_DEFAULTS } from "./constants.js";

describe("wire rate limits vs the agent's send pace (KOBE-429)", () => {
  it("the agent paces below the server's per-connection limit, with headroom", () => {
    expect(SANDBOX_SEND_PACE.framesPerSec).toBeLessThan(WIRE_DEFAULTS.frameRatePerSec);
    expect(SANDBOX_SEND_PACE.frameBurst).toBeLessThan(WIRE_DEFAULTS.frameBurst);
    expect(SANDBOX_SEND_PACE.bytesPerSec).toBeLessThan(WIRE_DEFAULTS.byteRatePerSec);
    expect(SANDBOX_SEND_PACE.byteBurst).toBeLessThan(WIRE_DEFAULTS.byteBurst);
  });

  it("one largest frame fits the agent's byte burst (a paced send never stalls)", () => {
    expect(SANDBOX_SEND_PACE.byteBurst).toBeGreaterThanOrEqual(SANDBOX_MAX_FRAME_BYTES);
  });
});
