import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { configureTagFingerprintKey, tagsFingerprint } from "./tag-fingerprint.js";

/** KOBE-647 review P2-L3: tags in the held-item audit are an HMAC under a server key, not a hash. */
describe("tagsFingerprint", () => {
  it("is keyed: not a plain SHA-256, and different under another secret", () => {
    configureTagFingerprintKey("a".repeat(32));
    const a = tagsFingerprint(["merger"]);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(createHash("sha256").update('["merger"]').digest("hex"));
    configureTagFingerprintKey("b".repeat(32));
    expect(tagsFingerprint(["merger"])).not.toBe(a);
  });

  it("ignores order and case, so equal lists match across rows", () => {
    configureTagFingerprintKey("a".repeat(32));
    expect(tagsFingerprint(["b", "A"])).toBe(tagsFingerprint(["a", "b"]));
    expect(tagsFingerprint(["a"])).not.toBe(tagsFingerprint(["a", "b"]));
  });
});
