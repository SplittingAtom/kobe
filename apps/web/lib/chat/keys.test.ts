import { webcrypto } from "node:crypto";
import { describe, expect, it } from "vitest";
import { newIdempotencyKey } from "./keys";

describe("newIdempotencyKey", () => {
  it("uses randomUUID where the origin is secure", () => {
    expect(newIdempotencyKey(webcrypto as unknown as Crypto)).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("falls back to getRandomValues on plain HTTP (no randomUUID)", () => {
    const insecure = { getRandomValues: webcrypto.getRandomValues.bind(webcrypto) } as Pick<
      Crypto,
      "getRandomValues"
    >;
    const a = newIdempotencyKey(insecure);
    const b = newIdempotencyKey(insecure);
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toBe(b);
  });
});
