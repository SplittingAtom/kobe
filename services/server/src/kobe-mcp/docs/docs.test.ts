import { describe, expect, it } from "vitest";
import { llmsFullTxt, llmsTxt, pageMarkdown, PAGES } from "@kobe/guide";
import { kobePinnedTool } from "../pinned.js";
import {
  DOCS_FULL_MAX_BYTES,
  isKobeDocsToolName,
  KOBE_DOCS_TOOLS,
  kobeDocsToolByName,
  runKobeDocsTool,
} from "./index.js";

/**
 * KOBE-620 (KA-3, spec kobe-admin-mcp §4, KA4): the docs tools of the built-in Kobe connector
 * answer the guide the web serves, byte for byte, for the deployment's origin and app name.
 */
const CTX = { appName: "Acme Chat", origin: "https://chat.example.com" };
const run = (name: string, input: unknown, pages = PAGES) =>
  runKobeDocsTool(
    kobeDocsToolByName(name) as NonNullable<ReturnType<typeof kobeDocsToolByName>>,
    input,
    CTX,
    pages,
  );
const textOf = (out: ReturnType<typeof run>) => {
  if (!out.ok) throw new Error(`${out.code}: ${out.message}`);
  return out.result.content[0]?.text ?? "";
};

describe("the docs tools", () => {
  it("are four read-only, closed-world tools with strict inputs", () => {
    expect(KOBE_DOCS_TOOLS.map((t) => t.name).sort()).toEqual([
      "docs_full",
      "docs_index",
      "docs_page",
      "docs_search",
    ]);
    for (const tool of KOBE_DOCS_TOOLS) {
      expect(isKobeDocsToolName(tool.name)).toBe(true);
      expect(tool.input.safeParse({ unexpected: 1 }).success).toBe(false);
      const pinned = kobePinnedTool("kobe", tool);
      expect(pinned.pi_name).toBe(`mcp__kobe__${tool.name}`);
      expect(pinned.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
    }
    expect(isKobeDocsToolName("team_members_list")).toBe(false);
  });

  it("docs_index is /llms.txt for the same origin and branding (ac-1)", () => {
    expect(textOf(run("docs_index", {}))).toBe(llmsTxt(PAGES, CTX));
  });

  it("docs_page is the page's .md; slugs may carry .md or the /docs/ path", () => {
    const page = PAGES[0] as (typeof PAGES)[number];
    const expected = pageMarkdown(page, CTX.origin);
    expect(textOf(run("docs_page", { slug: page.slug }))).toBe(expected);
    expect(textOf(run("docs_page", { slug: `${page.slug}.md` }))).toBe(expected);
    expect(textOf(run("docs_page", { slug: `/docs/${page.slug}.md` }))).toBe(expected);
    expect(textOf(run("docs_page", { slug: `${CTX.origin}/docs/${page.slug}.md` }))).toBe(expected);
  });

  it("an unknown slug is a tool error; traversal is only ever an unknown slug (ac-2)", () => {
    for (const slug of [
      "no-such-page",
      "../../etc/passwd",
      "../package.json",
      "chat/../../../../etc/passwd",
      "/etc/passwd",
      "%2e%2e/secrets",
      "C:\\Windows\\win.ini",
    ]) {
      const out = run("docs_page", { slug });
      expect(out.ok, slug).toBe(false);
      if (!out.ok) {
        expect(["unknown_page", "invalid_input"]).toContain(out.code);
        expect(out.message).not.toMatch(/root|ENOENT/);
      }
    }
    expect(run("docs_page", { slug: "x".repeat(1000) }).ok).toBe(false);
    expect(run("docs_page", {}).ok).toBe(false);
  });

  it("docs_full is every page, or one section's", () => {
    expect(textOf(run("docs_full", {}))).toBe(llmsFullTxt(PAGES, CTX));
    expect(textOf(run("docs_full", { section: "For agents" }))).toBe(
      llmsFullTxt(PAGES, CTX, "For agents"),
    );
    expect(run("docs_full", { section: "Nope" }).ok).toBe(false);
    expect(Buffer.byteLength(llmsFullTxt(PAGES, CTX))).toBeLessThan(DOCS_FULL_MAX_BYTES);
  });

  it("docs_full refuses a text above the cap and points at sections", () => {
    const big = PAGES.map((p) => ({
      ...p,
      markdown: p.markdown + "x".repeat(DOCS_FULL_MAX_BYTES),
    }));
    const out = run("docs_full", {}, big);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.message).toMatch(/section/);
  });

  it("docs_search finds pages by title, summary and heading, ranked and capped", () => {
    const out = run("docs_search", { query: "approvals" });
    if (!out.ok) throw new Error(out.message);
    const results = out.result.structuredContent?.results as { slug: string; url: string }[];
    expect(results.length).toBeGreaterThan(0);
    expect(results.length).toBeLessThanOrEqual(20);
    expect(results[0]?.url.startsWith(`${CTX.origin}/docs/`)).toBe(true);
    expect(JSON.parse(textOf(out))).toEqual(out.result.structuredContent);
    expect(run("docs_search", { query: "" }).ok).toBe(false);
    const limited = run("docs_search", { query: "a", limit: 2 });
    if (!limited.ok) throw new Error(limited.message);
    expect((limited.result.structuredContent?.results as unknown[]).length).toBeLessThanOrEqual(2);
  });
});
