import { describe, expect, it } from "vitest";
import { SecretBox, SecretBoxError } from "./secret-box.js";

const KEY = "k".repeat(40);

describe("SecretBox", () => {
  it("round-trips a value bound to its context", () => {
    const box = new SecretBox(KEY, "test");
    const sealed = box.seal("sk-live-abc", "provider:openai");
    expect(sealed).toMatch(/^v2\.[0-9a-f]{12}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(sealed).not.toContain("sk-live-abc");
    expect(box.open(sealed, "provider:openai")).toBe("sk-live-abc");
  });

  it("uses a fresh nonce per seal", () => {
    const box = new SecretBox(KEY, "test");
    expect(box.seal("same", "c")).not.toBe(box.seal("same", "c"));
  });

  it("refuses another context (a sealed value moved to another row)", () => {
    const box = new SecretBox(KEY, "test");
    const sealed = box.seal("sk", "provider:openai");
    expect(() => box.open(sealed, "provider:anthropic")).toThrow(SecretBoxError);
  });

  it("refuses another key and another purpose", () => {
    const sealed = new SecretBox(KEY, "test").seal("sk", "c");
    expect(() => new SecretBox("x".repeat(40), "test").open(sealed, "c")).toThrow(SecretBoxError);
    expect(() => new SecretBox(KEY, "other").open(sealed, "c")).toThrow(SecretBoxError);
  });

  it("refuses tampering and malformed input without echoing it", () => {
    const box = new SecretBox(KEY, "test");
    const sealed = box.seal("sk", "c");
    const parts = sealed.split(".");
    const flipped = `${parts[0]}.${parts[1]}.${parts[2]}.${parts[3]?.replace(/^./, (ch) => (ch === "A" ? "B" : "A"))}.${parts[4]}`;
    expect(() => box.open(flipped, "c")).toThrow(SecretBoxError);
    for (const bad of ["", "v1.a.b.c", "v2.a.b", "plain-secret-value"]) {
      expect(() => box.open(bad, "c")).toThrow(/sealed value/);
      try {
        box.open(bad, "c");
      } catch (err) {
        if (bad) expect((err as Error).message).not.toContain(bad);
      }
    }
  });

  it("rotates: values sealed with a previous secret still open, and are flagged for re-sealing", () => {
    const old = new SecretBox(KEY, "test");
    const sealed = old.seal("sk", "c");
    const rotated = new SecretBox(["n".repeat(40), KEY], "test");
    expect(rotated.open(sealed, "c")).toBe("sk");
    expect(rotated.isCurrent(sealed)).toBe(false);
    const resealed = rotated.seal("sk", "c");
    expect(rotated.isCurrent(resealed)).toBe(true);
    expect(() => old.open(resealed, "c")).toThrow(/does not hold/);
  });

  it("requires a key of at least 32 characters", () => {
    expect(() => new SecretBox("short", "test")).toThrow(/32/);
  });
});
