import { describe, expect, it } from "vitest";
import { blockedPayload } from "./blocked-relay.js";

describe("egress.blocked payload (KOBE-602)", () => {
  it("keeps an older proxy's row without a reason as it was", () => {
    expect(blockedPayload({ domain: "example.org", request_access: false })).toEqual({
      domain: "example.org",
      request_access: false,
    });
  });

  it("forwards the reason and offers Request access for every fixable one on a host name", () => {
    for (const reason of ["not_enabled", "not_in_ceiling", "forbidden_address"]) {
      expect(blockedPayload({ domain: "pypi.org", request_access: false, reason })).toEqual({
        domain: "pypi.org",
        request_access: true,
        reason,
      });
    }
  });

  it("drops unknown reasons and never offers access for an IP literal", () => {
    expect(
      blockedPayload({ domain: "pypi.org", request_access: false, reason: "sni_mismatch" }),
    ).toEqual({ domain: "pypi.org", request_access: false });
    expect(
      blockedPayload({ domain: "10.0.0.1", request_access: false, reason: "forbidden_address" }),
    ).toEqual({ domain: "10.0.0.1", request_access: false, reason: "forbidden_address" });
  });
});
