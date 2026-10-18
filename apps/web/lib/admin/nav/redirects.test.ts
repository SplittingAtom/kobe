import { describe, expect, it } from "vitest";
import nextConfig from "../../../next.config";
import { consoleHref, sectionHref, SITE_SECTIONS } from "./registry";

/** KOBE-257: the install console became the Site console; old bookmarks keep working. */
describe("Site console URLs", () => {
  it("redirects every old /admin/install path to /admin/site permanently", async () => {
    const rules = (await nextConfig.redirects?.()) ?? [];
    // One rule: `:path*` matches zero or more segments, so the bare /admin/install too.
    expect(rules.filter((r) => r.source.startsWith("/admin/install"))).toEqual([
      { source: "/admin/install/:path*", destination: "/admin/site/:path*", permanent: true },
    ]);
  });

  it("links only to /admin/site, never to the old path", () => {
    expect(consoleHref("site")).toBe("/admin/site");
    for (const section of SITE_SECTIONS) {
      expect(sectionHref(section)).toBe(`/admin/site/${section.id}`);
    }
  });
});

/** KOBE-321: the Workbench replaced the skill editors; their links land on the Skills page. */
describe("retired skill editor URLs", () => {
  it("send the old editors to the Skills page, never catching the Workbench editor", async () => {
    const rules = (await nextConfig.redirects?.()) ?? [];
    const skills = rules.filter((r) => r.source.includes("skills"));
    expect(skills).toEqual([
      { source: "/me/skills/new", destination: "/me/skills?tab=workbench", permanent: true },
      {
        source: "/admin/team/skills/new",
        destination: "/me/skills?tab=workbench",
        permanent: true,
      },
      { source: "/me/skills/:id", destination: "/me/skills?tab=mine", permanent: true },
    ]);
    // `:id` is one segment: /me/skills/drafts/<id> is the editor, not a redirect.
    expect(skills.some((r) => r.source.includes(":path"))).toBe(false);
  });
});
