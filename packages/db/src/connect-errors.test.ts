import { describe, expect, it } from "vitest";
import { isRetryableConnectError } from "./connect-errors.js";

const err = (props: Record<string, string>) => Object.assign(new Error("x"), props);

describe("isRetryableConnectError", () => {
  it.each(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "ECONNRESET", "EHOSTUNREACH"])(
    "retries while the server is unreachable (%s)",
    (code) => {
      expect(isRetryableConnectError(err({ code }))).toBe(true);
    },
  );

  it.each(["57P01", "57P02", "57P03", "53300"])("retries during startup/failover (%s)", (code) => {
    expect(isRetryableConnectError(err({ code }))).toBe(true);
  });

  it.each(["28P01", "28000", "3D000", "42501"])(
    "fails fast on %s (auth, missing db, privilege)",
    (code) => {
      expect(isRetryableConnectError(err({ code }))).toBe(false);
    },
  );

  it("retries when a connect attempt times out (no error code: a dropped SYN, e.g. a network policy not applied yet)", () => {
    expect(isRetryableConnectError(new Error("timeout expired"))).toBe(true); // pg.Client
    expect(isRetryableConnectError(new Error("timeout exceeded when trying to connect"))).toBe(
      true,
    ); // pg.Pool
  });

  it("fails fast on unknown errors", () => {
    expect(isRetryableConnectError(new Error("boom"))).toBe(false);
    expect(isRetryableConnectError("nope")).toBe(false);
  });
});
