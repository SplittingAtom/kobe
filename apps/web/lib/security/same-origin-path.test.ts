import { describe, expect, it } from "vitest";
import { isSameOriginPath } from "./same-origin-path";

describe("isSameOriginPath", () => {
  it.each(["/", "/v1/threads", "/v1/site/branding/assets/logo?v=ab", "/v1/x?q=a%20b#f"])(
    "accepts %s",
    (p) => expect(isSameOriginPath(p)).toBe(true),
  );

  it.each([
    "",
    "v1/threads",
    "//evil.example/x",
    "/\\evil.example",
    "/v1\\x",
    "https://evil.example/",
    "/v1/a b",
    "/v1/a\tb",
    "/v1/a\nb",
    " /v1",
  ])("refuses %j", (p) => expect(isSameOriginPath(p)).toBe(false));
});
