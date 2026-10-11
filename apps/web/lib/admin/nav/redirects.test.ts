import { describe, expect, it } from "vitest";
import nextConfig from "../../../next.config";
import { consoleHref, sectionHref, INSTALL_SECTIONS } from "./registry";

/** KOBE-257: the install console became the Site console; old bookmarks keep working. */
describe("Site console URLs", () => {
  it("redirects every old /admin/install path to /admin/site permanently", async () => {
    const rules = (await nextConfig.redirects?.()) ?? [];
    expect(rules).toEqual([
      { source: "/admin/install", destination: "/admin/site", permanent: true },
      { source: "/admin/install/:path*", destination: "/admin/site/:path*", permanent: true },
    ]);
  });

  it("links only to /admin/site, never to the old path", () => {
    expect(consoleHref("install")).toBe("/admin/site");
    for (const section of INSTALL_SECTIONS) {
      expect(sectionHref(section)).toBe(`/admin/site/${section.id}`);
    }
  });
});
