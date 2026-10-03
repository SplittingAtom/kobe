/**
 * Idempotency keys for sends (KOBE-30 `Idempotency-Key`: 1–128 visible ASCII). `randomUUID` exists
 * only on secure origins (HTTPS or localhost); a plain-HTTP install still has `getRandomValues`,
 * which is enough for 128 random bits.
 */
export function newIdempotencyKey(
  source: Pick<Crypto, "getRandomValues"> & Partial<Pick<Crypto, "randomUUID">> = globalThis.crypto,
): string {
  if (typeof source.randomUUID === "function") return source.randomUUID();
  const bytes = source.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
