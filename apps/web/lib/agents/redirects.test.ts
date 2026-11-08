import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import nextConfig from "../../next.config";
import { agentPageHref, agentsRedirects } from "./redirects";

describe("Agents redirects (KOBE-569, AR1/AR15)", () => {
  it("lands /me/agents on the Personal tab and keeps deeper links at the same path", () => {
    expect(agentsRedirects().filter((r) => r.source.startsWith("/me/agents"))).toEqual([
      { source: "/me/agents", destination: "/agents?tab=personal", permanent: false },
      { source: "/me/agents/:path+", destination: "/agents/:path+", permanent: false },
    ]);
  });

  it("sends the console's agent lists to the tabs that carry their actions (KOBE-570, AR12)", () => {
    expect(agentsRedirects().filter((r) => r.source.startsWith("/admin"))).toEqual([
      { source: "/admin/team/agents", destination: "/agents?tab=team", permanent: false },
      { source: "/admin/team/inventory", destination: "/agents?tab=team", permanent: false },
      { source: "/admin/site/gallery", destination: "/agents?tab=site", permanent: false },
    ]);
  });

  it("are served by next.config", async () => {
    const rules = (await nextConfig.redirects?.()) ?? [];
    const ours = new Set(agentsRedirects().map((r) => r.source));
    expect(rules.filter((r) => ours.has(r.source))).toEqual(agentsRedirects());
  });

  it("keeps the editors and detail pages under the old lists working", async () => {
    const rules = (await nextConfig.redirects?.()) ?? [];
    for (const deep of [
      "/admin/team/agents/new",
      "/admin/team/agents/a-1",
      "/admin/team/agents/a-1/cases",
      "/admin/site/gallery/g-1",
    ]) {
      expect(rules.some((r) => r.source === deep || matches(r.source, deep))).toBe(false);
    }
    expect(existsSync(new URL("../../app/admin/team/agents/[id]", import.meta.url))).toBe(true);
    expect(existsSync(new URL("../../app/admin/team/agents/new", import.meta.url))).toBe(true);
    expect(existsSync(new URL("../../app/admin/site/gallery/[id]", import.meta.url))).toBe(true);
  });

  it("links an agent's editor under /agents", () => {
    expect(agentPageHref("a 1")).toBe("/agents/a%201");
  });
});

/** Whether a Next.js redirect source (`:param`, `:param+`, `:param*`) matches `path`. */
function matches(source: string, path: string): boolean {
  const pattern = source
    .split("/")
    .map((part) =>
      part.endsWith("+") ? ".+" : part.endsWith("*") ? ".*" : part.startsWith(":") ? "[^/]+" : part,
    )
    .join("/");
  return new RegExp(`^${pattern}$`).test(path);
}
