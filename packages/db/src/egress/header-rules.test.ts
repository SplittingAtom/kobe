import { describe, expect, it } from "vitest";
import {
  headerBox,
  headerNameProblem,
  injectedHeadersSchema,
  openHeaders,
  sealHeaders,
} from "./header-rules.js";

const SECRET = "s".repeat(40);
const TEAM = "11111111-1111-4111-8111-111111111111";
const OTHER_TEAM = "22222222-2222-4222-8222-222222222222";

describe("injected header rules", () => {
  it("accepts ordinary credential headers", () => {
    expect(
      injectedHeadersSchema.safeParse([
        { name: "Authorization", value: "Bearer abc.def" },
        { name: "X-Api-Key", value: "k 1" },
      ]).success,
    ).toBe(true);
  });

  it.each([
    "Host",
    "content-length",
    "Transfer-Encoding",
    "Connection",
    "Proxy-Authorization",
    "X-Forwarded-For",
    "X-Kobe-Run-Id",
    "Bad Name",
    "",
    "a:b",
  ])("refuses the header name %j", (name) => {
    expect(headerNameProblem(name)).toBeDefined();
    expect(injectedHeadersSchema.safeParse([{ name, value: "x" }]).success).toBe(false);
  });

  it.each(["a\r\nX-Evil: 1", "a\nb", " leading", "trailing ", "", "café", "nul\u0000"])(
    "refuses the header value %j",
    (value) => {
      expect(injectedHeadersSchema.safeParse([{ name: "X-Key", value }]).success).toBe(false);
    },
  );

  it("refuses repeated names (ignoring case), empty lists and more than 8", () => {
    expect(
      injectedHeadersSchema.safeParse([
        { name: "X-Key", value: "a" },
        { name: "x-key", value: "b" },
      ]).success,
    ).toBe(false);
    expect(injectedHeadersSchema.safeParse([]).success).toBe(false);
    const nine = Array.from({ length: 9 }, (_, i) => ({ name: `X-H${i}`, value: "v" }));
    expect(injectedHeadersSchema.safeParse(nine).success).toBe(false);
  });

  it("seals for one team and domain: another team or domain cannot open it", () => {
    const box = headerBox(SECRET);
    const headers = [{ name: "Authorization", value: "Bearer secret-token" }];
    const sealed = sealHeaders(box, TEAM, "pkgs.example.com", headers);
    expect(sealed).not.toContain("secret-token");
    expect(openHeaders(box, TEAM, "pkgs.example.com", sealed)).toEqual(headers);
    expect(() => openHeaders(box, OTHER_TEAM, "pkgs.example.com", sealed)).toThrow();
    expect(() => openHeaders(box, TEAM, "other.example.com", sealed)).toThrow();
    expect(() =>
      openHeaders(headerBox("t".repeat(40)), TEAM, "pkgs.example.com", sealed),
    ).toThrow();
  });

  it("opens values sealed with a previous secret after rotation", () => {
    const old = headerBox("o".repeat(40));
    const sealed = sealHeaders(old, TEAM, "pkgs.example.com", [{ name: "X-Key", value: "v" }]);
    const rotated = headerBox(["n".repeat(40), "o".repeat(40)]);
    expect(rotated.isCurrent(sealed)).toBe(false);
    expect(openHeaders(rotated, TEAM, "pkgs.example.com", sealed)).toEqual([
      { name: "X-Key", value: "v" },
    ]);
  });
});
