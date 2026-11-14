import { createHmac } from "node:crypto";
import { deriveKey } from "@kobe/db";

/**
 * Tag fingerprints for the held-item audit (KOBE-647, review P2-L3): an HMAC-SHA-256 of the
 * sorted, lowercased tag list (JSON) under a key derived from the auth secret with its own purpose,
 * so audit readers can see that tags changed, and compare lists across rows, but cannot confirm a
 * guessed tag offline. Never the tags themselves. Set once per process (`createServerDeps`).
 */
let key: Buffer | null = null;

export function configureTagFingerprintKey(secret: string): void {
  key = deriveKey(secret, "memory.audit.tag-fingerprint");
}

export function tagsFingerprint(tags: readonly string[]): string {
  if (!key) throw new Error("memory: the tag fingerprint key is not configured");
  const list = JSON.stringify(tags.map((t) => t.toLowerCase()).sort());
  return createHmac("sha256", key).update(list).digest("hex");
}
