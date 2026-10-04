import { describe, expect, it } from "vitest";
import { extractCredential } from "./credentials.js";

const none = new URLSearchParams();

describe("extractCredential", () => {
  it("finds the token in each SDK's place", () => {
    expect(extractCredential({ authorization: "Bearer t1" }, none)).toEqual({
      ok: true,
      token: "t1",
    });
    expect(extractCredential({ "x-api-key": "t2" }, none)).toEqual({ ok: true, token: "t2" });
    expect(extractCredential({ "x-goog-api-key": "t3" }, none)).toEqual({ ok: true, token: "t3" });
    expect(extractCredential({ "api-key": "t4" }, none)).toEqual({ ok: true, token: "t4" });
    expect(extractCredential({}, new URLSearchParams("key=t5"))).toEqual({ ok: true, token: "t5" });
    // The same token twice (some SDKs send both) is fine.
    expect(extractCredential({ authorization: "Bearer t", "x-api-key": "t" }, none)).toEqual({
      ok: true,
      token: "t",
    });
  });

  it("refuses none, other schemes, duplicates and conflicting credentials", () => {
    expect(extractCredential({}, none)).toEqual({ ok: false, reason: "missing" });
    expect(extractCredential({ authorization: "Basic abc" }, none)).toEqual({
      ok: false,
      reason: "malformed",
    });
    expect(extractCredential({ authorization: "Bearer a", "x-api-key": "b" }, none)).toEqual({
      ok: false,
      reason: "malformed",
    });
    expect(extractCredential({}, new URLSearchParams("key=a&key=b"))).toEqual({
      ok: false,
      reason: "malformed",
    });
    expect(extractCredential({ "x-api-key": "x".repeat(5000) }, none)).toEqual({
      ok: false,
      reason: "malformed",
    });
  });
});
