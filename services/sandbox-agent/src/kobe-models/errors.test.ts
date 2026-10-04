import { describe, expect, it } from "vitest";
import {
  MAX_RETRY_AFTER_MS,
  classifyFailure,
  isTransient,
  isUnauthorized,
  kobeErrorMessage,
  runErrorCode,
} from "./errors.js";
import { KOBE_MODEL_ERROR_PREFIX } from "./protocol.js";

const openai = (status: number, code: string) =>
  `${status}: ${JSON.stringify({ message: "m", type: code, code })}`;
const anthropic = (status: number, type: string) =>
  `${status} ${JSON.stringify({ type: "error", error: { type, message: "m" } })}`;
const gemini = (status: number, text: string) =>
  JSON.stringify({ error: { code: status, message: "m", status: text } });

describe("gateway failure classification", () => {
  it("reads the gateway's code and status from each SDK's error shape", () => {
    expect(classifyFailure(openai(403, "model_not_enabled"), undefined)).toEqual({
      status: 403,
      code: "model_not_enabled",
      retryAfterMs: undefined,
    });
    expect(classifyFailure(anthropic(401, "session_revoked"), undefined)).toMatchObject({
      status: 401,
      code: "session_revoked",
    });
    expect(classifyFailure(gemini(503, "UNAVAILABLE"), undefined)).toMatchObject({ status: 503 });
  });

  it("prefers the response Pi's adapter saw and caps Retry-After", () => {
    const f = classifyFailure("boom", { status: 503, headers: { "retry-after": "5" } });
    expect(f).toEqual({ status: 503, code: undefined, retryAfterMs: 5000 });
    expect(
      classifyFailure("x", { status: 429, headers: { "retry-after": "3600" } }).retryAfterMs,
    ).toBe(MAX_RETRY_AFTER_MS);
    expect(
      classifyFailure("x", { status: 429, headers: { "retry-after": "soon" } }).retryAfterMs,
    ).toBeUndefined();
  });

  it("maps failures onto run error codes", () => {
    const code = (message: string, status?: number) =>
      runErrorCode(
        classifyFailure(message, status === undefined ? undefined : { status, headers: {} }),
      );
    expect(code(openai(403, "model_not_enabled"))).toBe("model_not_enabled");
    expect(code(anthropic(403, "provider_blocked"))).toBe("model_not_enabled");
    expect(code("403 forbidden")).toBe("model_not_enabled");
    expect(code(openai(401, "invalid_session_token"))).toBe("model_session_revoked");
    expect(code(openai(401, "session_revoked"))).toBe("model_session_revoked");
    expect(code(openai(429, "too_many_concurrent_calls"))).toBe("model_throttled");
    expect(code(openai(503, "model_access_pending"))).toBe("model_unavailable");
    expect(code("fetch failed", 502)).toBe("model_unavailable");
    expect(code("TypeError: fetch failed")).toBe("model_unavailable");
    expect(code("Error: connect ECONNREFUSED 10.0.0.1:80")).toBe("model_unavailable");
    expect(code("x", 529)).toBe("model_unavailable");
    expect(code(openai(400, "invalid_request"))).toBe("model_error");
    expect(code("Unknown: UnknownError")).toBe("model_error");
    expect(code(openai(403, "run_not_leased"))).toBe("model_error");
    // KOBE-42: a used-up budget (the shim's 402, Bifrost's own refusal) is never retried.
    expect(code(openai(402, "budget_exhausted"))).toBe("model_budget_exhausted");
    expect(code(anthropic(402, "budget_exhausted"))).toBe("model_budget_exhausted");
    expect(code(gemini(402, "UNKNOWN"))).toBe("model_budget_exhausted");
    expect(code(openai(402, "policy_budget_exceeded"))).toBe("model_budget_exhausted");
    expect(isTransient(classifyFailure(openai(402, "budget_exhausted"), undefined))).toBe(false);
    expect(
      kobeErrorMessage(
        "model_budget_exhausted",
        classifyFailure(openai(402, "budget_exhausted"), undefined),
        1,
      ),
    ).toBe(`${KOBE_MODEL_ERROR_PREFIX}model_budget_exhausted: gave up after 1 attempt`);
  });

  it("knows what is worth retrying and what needs a fresh token", () => {
    expect(isTransient(classifyFailure(openai(503, "model_gateway_resyncing"), undefined))).toBe(
      true,
    );
    expect(isTransient(classifyFailure("x", { status: 504, headers: {} }))).toBe(true);
    expect(isTransient(classifyFailure("socket hang up", undefined))).toBe(true);
    expect(isTransient(classifyFailure("Unknown: UnknownError", undefined))).toBe(false);
    expect(isTransient(classifyFailure(openai(200, "too_many_bytes_in_flight"), undefined))).toBe(
      true,
    );
    expect(isTransient(classifyFailure(openai(403, "model_not_enabled"), undefined))).toBe(false);
    expect(isUnauthorized(classifyFailure(openai(401, "invalid_session_token"), undefined))).toBe(
      true,
    );
    expect(isUnauthorized(classifyFailure(openai(403, "x"), undefined))).toBe(false);
  });

  it("writes an error message the server parses and Pi's auto-retry leaves alone", () => {
    const failure = classifyFailure(openai(503, "model_access_pending"), undefined);
    const message = kobeErrorMessage("model_unavailable", failure, 6);
    expect(message).toBe(`${KOBE_MODEL_ERROR_PREFIX}model_unavailable: gave up after 6 attempts`);
    // The gateway's code never enters the message: Pi would retry on "rate_limited"/"overloaded".
    for (const code of ["rate_limited", "overloaded_error"]) {
      expect(
        kobeErrorMessage("model_throttled", classifyFailure(openai(429, code), undefined), 8),
      ).not.toMatch(/rate.?limit|overloaded/i);
    }
    // isRetryableAssistantError (pi-ai) matches these; none may appear in a final message.
    expect(message).not.toMatch(
      /429|50[0-4]|rate.?limit|too many requests|service.?unavailable|timeout|network/i,
    );
    expect(kobeErrorMessage("model_throttled", failure, 1)).not.toMatch(/rate.?limit/i);
  });
});
