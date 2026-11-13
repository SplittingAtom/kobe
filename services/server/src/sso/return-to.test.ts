import { describe, expect, it } from "vitest";
import { safeReturnTo } from "./return-to.js";

describe("safeReturnTo (spec sso-oidc-scim §5.3, open redirect)", () => {
  it.each([
    ["/", "/"],
    ["/chat", "/chat"],
    ["/threads/abc?x=1#y", "/threads/abc?x=1#y"],
    ["/admin/site/users?q=a%20b", "/admin/site/users?q=a%20b"],
  ])("keeps the same-origin path %s", (raw, expected) => {
    expect(safeReturnTo(raw)).toBe(expected);
  });

  it.each([
    undefined,
    null,
    "",
    "//evil.example.com",
    "//evil.example.com/path",
    "/\\evil.example.com",
    "\\\\evil.example.com",
    "/\\/evil.example.com",
    "https://evil.example.com",
    "http://kobe.test/chat",
    "javascript:alert(1)",
    "chat",
    " /chat",
    "/%2F%2Fevil.example.com",
    "/%5Cevil.example.com",
    "/\t/evil.example.com",
    "/\n/evil.example.com",
    "/chat\u0000",
    `/${"a".repeat(3000)}`,
    42,
  ])("turns %j into /", (raw) => {
    expect(safeReturnTo(raw)).toBe("/");
  });
});
