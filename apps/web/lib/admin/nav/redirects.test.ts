import { describe, expect, it } from "vitest";
import nextConfig from "../../../next.config";
import { consoleHref, sectionHref, SITE_SECTIONS } from "./registry";

/** KOBE-257: the install console became the Site console; old bookmarks keep working. */
describe("Site console URLs", () => {
  it("redirects every old /admin/install path to /admin/site permanently", async () => {
    const rules = (await nextConfig.redirects?.()) ?? [];
    // One rule: `:path*` matches zero or more segments, so the bare /admin/install too.
    expect(rules).toEqual([
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
