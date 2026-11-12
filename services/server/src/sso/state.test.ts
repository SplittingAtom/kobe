import { describe, expect, it } from "vitest";
import { SsoStateBox, type SsoFlowState } from "./state.js";

const flow = (over: Partial<SsoFlowState> = {}): SsoFlowState => ({
  v: 1,
  slug: "corp",
  providerId: "11111111-2222-4333-8444-555555555555",
  state: "s".repeat(43),
  nonce: "n".repeat(43),
  verifier: "v".repeat(43),
  returnTo: "/",
  exp: Date.now() + 60_000,
  ...over,
});

describe("SsoStateBox (sealed flow cookie)", () => {
  const box = new SsoStateBox("x".repeat(48));

  it("opens what it sealed", () => {
    const f = flow();
    expect(box.open(box.seal(f))).toEqual(f);
  });

  it("seals with a fresh IV each time (no two cookies alike)", () => {
    const f = flow();
    expect(box.seal(f)).not.toBe(box.seal(f));
  });

  it("refuses a tampered cookie", () => {
    const sealed = box.seal(flow());
    const bytes = Buffer.from(sealed, "base64url");
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 1;
    expect(box.open(bytes.toString("base64url"))).toBeUndefined();
  });

  it("refuses a cookie sealed under another secret", () => {
    const other = new SsoStateBox("y".repeat(48));
    expect(box.open(other.seal(flow()))).toBeUndefined();
  });

  it("refuses an expired cookie", () => {
    expect(box.open(box.seal(flow({ exp: Date.now() - 1 })))).toBeUndefined();
  });

  it.each([undefined, null, "", "abc", "!".repeat(100), "a".repeat(5000)])(
    "refuses garbage %j",
    (raw) => {
      expect(box.open(raw)).toBeUndefined();
    },
  );
});
