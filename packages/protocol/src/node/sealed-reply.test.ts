import { describe, expect, it } from "vitest";
import { sealedReplySchema } from "../sandbox-wire/context-frames.js";
import { sealReply, sealedReplyKeyPair } from "./sealed-reply.js";

const THREAD = "6f1c3f0e-5a8e-4a49-9d0e-1f2a3b4c5d6e";
const OTHER = "7f1c3f0e-5a8e-4a49-9d0e-1f2a3b4c5d6e";

describe("sealed replies (KOBE-470, CV8)", () => {
  it("opens with the one-use private key, and the sealed form holds no plaintext", () => {
    const pair = sealedReplyKeyPair();
    const sealed = sealReply(pair.key, '{"text":"MARKER-secret plans"}', THREAD);
    expect(sealedReplySchema.parse(sealed)).toBeTruthy();
    expect(JSON.stringify(sealed)).not.toContain("MARKER");
    expect(pair.open(sealed, THREAD)).toBe('{"text":"MARKER-secret plans"}');
    // One use: the key is spent.
    expect(pair.open(sealed, THREAD)).toBeUndefined();
  });

  it("refuses another key, another thread and any tampering", () => {
    const pair = sealedReplyKeyPair();
    const sealed = sealReply(pair.key, "hello", THREAD);
    expect(sealedReplyKeyPair().open(sealed, THREAD)).toBeUndefined();
    expect(sealedReplyKeyPair().open(sealReply(pair.key, "x", THREAD), OTHER)).toBeUndefined();
    const p2 = sealedReplyKeyPair();
    expect(p2.open(sealReply(p2.key, "hello", THREAD), OTHER)).toBeUndefined();
    const p3 = sealedReplyKeyPair();
    const s3 = sealReply(p3.key, "hello", THREAD);
    const flipped = s3.ciphertext.startsWith("A")
      ? `B${s3.ciphertext.slice(1)}`
      : `A${s3.ciphertext.slice(1)}`;
    expect(p3.open({ ...s3, ciphertext: flipped }, THREAD)).toBeUndefined();
    expect(sealedReplyKeyPair().open({ v: 1 }, THREAD)).toBeUndefined();
  });

  it("uses a fresh sender key and nonce for every reply", () => {
    const pair = sealedReplyKeyPair();
    const a = sealReply(pair.key, "same", THREAD);
    const b = sealReply(pair.key, "same", THREAD);
    expect(a.epk).not.toBe(b.epk);
    expect(a.nonce).not.toBe(b.nonce);
  });
});
