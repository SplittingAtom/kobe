import { describe, expect, it } from "vitest";
import { decodeSandboxFrame } from "./codec.js";

describe("session.renew (KOBE-483)", () => {
  const token = "eyJhbGciOiJFUzI1NiJ9.payload.signature-xyz";

  it("decodes a renewal carrying a bearer-shaped token", () => {
    const decoded = decodeSandboxFrame(JSON.stringify({ v: 1, type: "session.renew", token }));
    expect(decoded.ok).toBe(true);
  });

  it("refuses extra keys, short tokens and characters a bearer token cannot hold", () => {
    for (const frame of [
      { v: 1, type: "session.renew", token, extra: 1 },
      { v: 1, type: "session.renew", token: "short" },
      { v: 1, type: "session.renew", token: `${token} ${token}` },
    ]) {
      expect(decodeSandboxFrame(JSON.stringify(frame)).ok).toBe(false);
    }
  });
});
