import { describe, expect, it } from "vitest";
import { createProxyProbe } from "./probe.js";

const make = (respond: () => Response | Promise<Response>) => {
  const seen: { url: string; init: RequestInit }[] = [];
  const probe = createProxyProbe({
    baseUrl: "http://proxy",
    internalKey: "k".repeat(40),
    timeoutMs: 1000,
    fetch: ((url: string, init: RequestInit) => {
      seen.push({ url, init });
      return Promise.resolve(respond());
    }) as typeof fetch,
  });
  return { probe, seen };
};

describe("createProxyProbe", () => {
  it("posts the URL with the internal key and returns the tools", async () => {
    const { probe, seen } = make(() => Response.json({ ok: true, tools: [{ name: "a" }] }));
    expect(await probe.probe("https://mcp.example/x")).toEqual({
      ok: true,
      tools: [{ name: "a" }],
    });
    expect(seen[0]?.url).toBe("http://proxy/internal/v1/probe");
    expect(seen[0]?.init.body).toBe(JSON.stringify({ url: "https://mcp.example/x" }));
    expect((seen[0]?.init.headers as Record<string, string>).authorization).toBe(
      `Bearer ${"k".repeat(40)}`,
    );
  });

  it("sends a user's API key to the proxy in the body only when given (KOBE-108)", async () => {
    const { probe, seen } = make(() => Response.json({ ok: true, tools: [] }));
    await probe.probe("https://mcp.example/x", "sk-live-0123456789");
    expect(seen[0]?.init.body).toBe(
      JSON.stringify({ url: "https://mcp.example/x", api_key: "sk-live-0123456789" }),
    );
    expect(seen[0]?.url).not.toContain("sk-live");
  });

  it("passes the proxy's failure code through", async () => {
    const { probe } = make(() => Response.json({ ok: false, failure: "auth_required" }));
    expect(await probe.probe("https://x")).toEqual({ ok: false, failure: "auth_required" });
  });

  it("fails closed on a bad status, a bad answer or a network error", async () => {
    const unavailable = { ok: false, failure: "proxy_unavailable" };
    expect(await make(() => new Response("no", { status: 401 })).probe.probe("https://x")).toEqual(
      unavailable,
    );
    expect(
      await make(() => Response.json({ ok: true, tools: "x" })).probe.probe("https://x"),
    ).toEqual(unavailable);
    expect(
      await make(() => {
        throw new Error("down");
      }).probe.probe("https://x"),
    ).toEqual(unavailable);
  });
});
