import { describe, expect, it } from "vitest";
import { SoftwareAuthenticator } from "../testing/webauthn.js";
import { isUserVerified } from "./webauthn-flags.js";

describe("isUserVerified", () => {
  const a = new SoftwareAuthenticator("kobe.test", "http://kobe.test");
  const reg = a.register({
    challenge: "c",
    rp: { name: "Kobe", id: "kobe.test" },
    user: { id: "u", name: "u" },
  });

  it("reads UV from a registration attestation object", () => {
    expect(isUserVerified(reg)).toBe(true);
  });

  it("reads UV from an assertion", () => {
    expect(isUserVerified(a.authenticate({ challenge: "c" }))).toBe(true);
    expect(isUserVerified(a.authenticate({ challenge: "c" }, { userVerified: false }))).toBe(false);
  });

  it("treats malformed input as unverified", () => {
    expect(isUserVerified(undefined)).toBe(false);
    expect(isUserVerified({ response: { authenticatorData: "!!" } })).toBe(false);
  });
});
