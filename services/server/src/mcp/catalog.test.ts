import { describe, expect, it } from "vitest";
import { credentialUsed } from "./catalog.js";

describe("credentialUsed (KOBE-449: which key a call is audited with)", () => {
  it("is none for a connector without auth, whatever its source", () => {
    expect(credentialUsed({ authKind: "none", credentialSource: "member" })).toBe("none");
  });

  it("is the member's own key or token in member mode", () => {
    expect(credentialUsed({ authKind: "api_key", credentialSource: "member" })).toBe("member");
    expect(credentialUsed({ authKind: "oauth", credentialSource: "member" })).toBe("member");
  });

  it("is the site key in site mode: a member's grant never applies there", () => {
    expect(credentialUsed({ authKind: "api_key", credentialSource: "site" })).toBe("site");
  });
});
