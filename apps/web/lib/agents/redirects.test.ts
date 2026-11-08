import { describe, expect, it } from "vitest";
import nextConfig from "../../next.config";
import { agentPageHref, agentsRedirects } from "./redirects";

describe("Agents redirects (KOBE-569, AR1/AR15)", () => {
  it("lands /me/agents on the Personal tab and keeps deeper links at the same path", () => {
    expect(agentsRedirects()).toEqual([
      { source: "/me/agents", destination: "/agents?tab=personal", permanent: false },
      { source: "/me/agents/:path+", destination: "/agents/:path+", permanent: false },
    ]);
  });

  it("are served by next.config", async () => {
    const rules = (await nextConfig.redirects?.()) ?? [];
    expect(rules.filter((r) => r.source.startsWith("/me/agents"))).toEqual(agentsRedirects());
  });

  it("leaves the console pages alone until the tabs carry their actions (KOBE-570)", () => {
    const sources = agentsRedirects().map((r) => r.source);
    for (const page of ["/admin/team/agents", "/admin/team/inventory", "/admin/site/gallery"]) {
      expect(sources.some((s) => s.startsWith(page))).toBe(false);
    }
  });

  it("links an agent's editor under /agents", () => {
    expect(agentPageHref("a 1")).toBe("/agents/a%201");
  });
});
