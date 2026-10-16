import { describe, expect, it } from "vitest";
import { forwardingSecrets, redactForwardingError } from "./redact.js";

// KOBE-182: forwarding errors reach the admin health view; they must not carry credentials.

describe("redactForwardingError", () => {
  it("removes userinfo, query strings and fragments from URLs", () => {
    const message =
      "Request cannot be constructed from a URL that includes credentials: " +
      "https://user:s3cret@collector.example.test/v1/logs?token=abc#frag";
    const out = redactForwardingError(message);
    expect(out).not.toContain("user:");
    expect(out).not.toContain("s3cret");
    expect(out).not.toContain("abc");
    expect(out).toContain("https://[redacted]@collector.example.test/v1/logs?[redacted]");
  });

  it("removes bearer and basic tokens", () => {
    const out = redactForwardingError("rejected Authorization: Bearer eyJh.x-y_z and Basic dTpw==");
    expect(out).toBe("rejected Authorization: Bearer [redacted] and Basic [redacted]");
  });

  it("removes every configured secret wherever it appears", () => {
    const out = redactForwardingError("collector said: bad key k-0123456789", ["k-0123456789"]);
    expect(out).toBe("collector said: bad key [redacted]");
  });

  it("leaves ordinary errors alone", () => {
    const plain = "connect ECONNREFUSED 10.0.0.1:6514 (syslog connection timed out)";
    expect(redactForwardingError(plain)).toBe(plain);
    expect(redactForwardingError("OTLP collector answered HTTP 503")).toBe(
      "OTLP collector answered HTTP 503",
    );
  });
});

describe("forwardingSecrets", () => {
  it("collects OTLP header values and URL credentials, raw and decoded", () => {
    const secrets = forwardingSecrets({
      otlp: {
        url: "https://us%40er:p%40ss@collector.example.test/v1/logs",
        headers: { authorization: "Bearer tok-123456", "x-team": "a" },
      },
    });
    expect(secrets).toEqual(
      expect.arrayContaining([
        "Bearer tok-123456",
        "tok-123456",
        "us%40er",
        "us@er",
        "p%40ss",
        "p@ss",
      ]),
    );
  });

  it("ignores values too short to be secrets (they would redact ordinary words)", () => {
    expect(
      forwardingSecrets({ otlp: { url: "https://c.test/v1/logs", headers: { x: "a" } } }),
    ).toEqual([]);
    expect(forwardingSecrets({})).toEqual([]);
  });
});
