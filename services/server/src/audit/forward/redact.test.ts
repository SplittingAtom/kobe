import { describe, expect, it } from "vitest";
import { forwardingSecrets, redactForwardingError } from "./redact.js";

// KOBE-182: forwarding errors reach the admin health view; they must not carry credentials.

describe("redactForwardingError", () => {
  it("keeps only scheme://host[:port] of a URL: userinfo, path, query and fragment go", () => {
    const message =
      "Request cannot be constructed from a URL that includes credentials: " +
      "https://user:s3cret@collector.example.test:4318/ingest/t0k3n-in-path?token=abc#frag";
    const out = redactForwardingError(message);
    for (const secret of ["user:", "s3cret", "t0k3n-in-path", "abc", "frag"]) {
      expect(out).not.toContain(secret);
    }
    expect(out).toContain("https://[redacted]@collector.example.test:4318/[redacted]");
  });

  it("redacts userinfo up to the last @ before the host (an @ in the password)", () => {
    const out = redactForwardingError("refused tls://siem:p@ss@w0rd@siem.example.test:6514/x");
    expect(out).toBe("refused tls://[redacted]@siem.example.test:6514/[redacted]");
  });

  it("leaves a bare scheme://host[:port] as it is", () => {
    expect(redactForwardingError("connect to tls://siem.example.test:6514 failed")).toBe(
      "connect to tls://siem.example.test:6514 failed",
    );
    expect(redactForwardingError("(see https://collector.example.test/)")).toBe(
      "(see https://collector.example.test/)",
    );
  });

  it("removes bearer and basic credentials", () => {
    const out = redactForwardingError("rejected Authorization: Bearer eyJh.x-y_z and Basic dTpw==");
    expect(out).toBe("rejected Authorization: Bearer [redacted] and Basic [redacted]");
    expect(redactForwardingError("authorization: basic c2llbTpodW50ZXIy")).toBe(
      "authorization: basic [redacted]",
    );
  });

  it("leaves prose that only looks like an auth scheme", () => {
    for (const prose of [
      "certificate has no Basic constraints extension",
      "Bearer token missing",
      "basic auth required",
    ]) {
      expect(redactForwardingError(prose)).toBe(prose);
    }
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
