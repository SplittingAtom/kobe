import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import nextConfig from "../../next.config";
import { config, proxy } from "../../proxy";
import { buildCsp, newNonce } from "./csp";

function directives(csp: string): Map<string, string[]> {
  return new Map(
    csp.split(";").map((d) => {
      const [name = "", ...values] = d.trim().split(/\s+/);
      return [name, values] as const;
    }),
  );
}

describe("Content Security Policy", () => {
  it("allows only nonced same-origin scripts, no eval in production, never framed", () => {
    const d = directives(buildCsp("abc", { dev: false }));
    expect(d.get("script-src")).toEqual(["'self'", "'nonce-abc'", "'strict-dynamic'"]);
    expect(d.get("style-src")).toEqual(["'self'", "'nonce-abc'"]);
    expect(d.get("img-src")).toEqual(["'self'", "data:"]);
    expect(d.get("connect-src")).toEqual(["'self'"]);
    expect(d.get("object-src")).toEqual(["'none'"]);
    expect(d.get("base-uri")).toEqual(["'self'"]);
    expect(d.get("frame-ancestors")).toEqual(["'none'"]);
    expect(d.get("form-action")).toEqual(["'self'"]);
    const all = [...d.values()].flat();
    expect(all).not.toContain("'unsafe-eval'");
    expect(d.get("script-src")).not.toContain("'unsafe-inline'");
    expect(all).not.toContain("*");
    expect(directives(buildCsp("abc", { dev: true })).get("script-src")).toContain("'unsafe-eval'");
  });

  it("uses a fresh, unguessable nonce per request on both the request and the response", () => {
    const a = proxy(new NextRequest("http://kobe.test/"));
    const b = proxy(new NextRequest("http://kobe.test/?thread=x"));
    const csp = a.headers.get("content-security-policy") ?? "";
    const nonce = /'nonce-([^']+)'/.exec(csp)?.[1] ?? "";
    expect(nonce).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    expect(b.headers.get("content-security-policy")).not.toContain(nonce);
    // Next reads the request copy to put the nonce on its own scripts.
    expect(a.headers.get("x-middleware-request-content-security-policy")).toBe(csp);
    expect(a.headers.get("x-middleware-request-x-nonce")).toBe(nonce);
    expect(newNonce()).not.toBe(newNonce());
  });

  it("runs on pages, not on static chunks or prefetches", () => {
    const [matcher] = config.matcher;
    const source = new RegExp(`^${matcher?.source ?? ""}$`);
    expect(source.test("/")).toBe(true);
    expect(source.test("/admin/install/users")).toBe(true);
    expect(source.test("/_next/static/chunks/a.js")).toBe(false);
    expect(source.test("/api/healthz")).toBe(false);
    expect(matcher?.missing.map((m) => m.key)).toEqual(["next-router-prefetch", "purpose"]);
  });

  it("serves frame, sniffing and referrer headers on every path", async () => {
    const rules = (await nextConfig.headers?.()) ?? [];
    expect(rules).toHaveLength(1);
    expect(rules[0]?.source).toBe("/:path*");
    expect(
      Object.fromEntries((rules[0]?.headers ?? []).map((h) => [h.key, h.value])),
    ).toMatchObject({
      "X-Frame-Options": "DENY",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "strict-origin-when-cross-origin",
    });
  });
});
