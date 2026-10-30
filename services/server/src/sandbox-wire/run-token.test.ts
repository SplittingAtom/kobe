import { describe, expect, it } from "vitest";
import { deriveTraceSpanKey } from "@kobe/protocol/node";
import { generateSessionKeyPair } from "@kobe/session-token";
import { runTokenKeyFromEnv, traceSpanKeyFromEnv } from "./run-token.js";

describe("run token and trace keys from env (KOBE-521)", () => {
  it("signs run tokens with the model-gateway Ed25519 private key, never the old master", () => {
    const pair = generateSessionKeyPair();
    expect(
      runTokenKeyFromEnv({ KOBE_SESSION_SIGNING_KEY_MODEL_GATEWAY: pair.privatePem })?.kid,
    ).toBe(pair.signing.kid);
    expect(runTokenKeyFromEnv({})).toBeUndefined();
    expect(runTokenKeyFromEnv({ KOBE_SESSION_SIGNING_KEY_MODEL_GATEWAY: pair.publicPem })).toBe(
      undefined,
    );
    expect(runTokenKeyFromEnv({ KOBE_SESSION_KEY_MODEL_GATEWAY: "m".repeat(48) })).toBeUndefined();
  });

  it("derives k_trace from KOBE_TRACE_SPAN_KEY only", () => {
    const secret = "t".repeat(48);
    expect(traceSpanKeyFromEnv({ KOBE_TRACE_SPAN_KEY: secret })).toEqual(
      deriveTraceSpanKey(new TextEncoder().encode(secret)),
    );
    const warnings: string[] = [];
    expect(
      traceSpanKeyFromEnv({ KOBE_TRACE_SPAN_KEY: "short" }, (m) => warnings.push(m)),
    ).toBeUndefined();
    expect(warnings).toEqual([
      "KOBE_TRACE_SPAN_KEY is shorter than 32 bytes: sandbox span relay is off",
    ]);
    // Unset is a choice (relay off), not a misconfiguration: no warning.
    expect(traceSpanKeyFromEnv({}, (m) => warnings.push(m))).toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(traceSpanKeyFromEnv({ KOBE_SESSION_KEY_MODEL_GATEWAY: secret })).toBeUndefined();
  });
});
