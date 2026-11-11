import { describe, expect, it } from "vitest";
import {
  buildGuide,
  GuideBuildError,
  ORIGIN_TOKEN,
  rewriteLinks,
  slugFromPath,
  splitFrontmatter,
  type GuideFile,
} from "./guide-loader";

/** KOBE-616 (ac-5, ac-6): the guide's build step — frontmatter, order, slugs, links, failures. */

function page(fm: Record<string, unknown>, body = "Text.\n"): string {
  const yaml = Object.entries(fm)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join("\n");
  return `---\n${yaml}\n---\n\n${body}`;
}

const ok = (title: string, section: string, order?: number, body?: string) =>
  page(
    { title, summary: `About ${title}.`, section, ...(order === undefined ? {} : { order }) },
    body,
  );

function problems(files: GuideFile[]): string[] {
  try {
    buildGuide(files);
  } catch (e) {
    expect(e).toBeInstanceOf(GuideBuildError);
    return [...(e as GuideBuildError).problems];
  }
  throw new Error("expected the build to fail");
}

describe("slugFromPath", () => {
  it("is the path without .md, subfolders kept", () => {
    expect(slugFromPath("getting-started.md")).toBe("getting-started");
    expect(slugFromPath("admin/team-settings.md")).toBe("admin/team-settings");
  });
  it("refuses other files and names", () => {
    for (const p of ["notes.txt", "Upper.md", "a b.md", "admin/.md", "x_y.md"])
      expect(slugFromPath(p)).toBeNull();
  });
});

describe("splitFrontmatter", () => {
  it("parses the YAML and returns the rest (CRLF and a BOM too)", () => {
    const { data, body } = splitFrontmatter("﻿---\r\ntitle: A\r\n---\r\nBody\r\n");
    expect(data).toEqual({ title: "A" });
    expect(body).toBe("Body\n");
  });
  it("fails without frontmatter or with bad YAML", () => {
    expect(() => splitFrontmatter("# Title\n")).toThrow(/missing YAML frontmatter/);
    expect(() => splitFrontmatter("---\ntitle: [a\n---\n")).toThrow(/not valid YAML/);
  });
});

describe("buildGuide", () => {
  it("reads the frontmatter, defaults the audience and drops a leading H1", () => {
    const [p] = buildGuide([
      { path: "a.md", content: ok("Alpha", "Memory", 2, "# Alpha\n\nHello.\n") },
    ]);
    expect(p).toEqual({
      slug: "a",
      title: "Alpha",
      summary: "About Alpha.",
      section: "Memory",
      order: 2,
      audience: "member",
      body: "Hello.\n",
      markdown: "Hello.\n",
    });
  });

  it("orders by section (list order), then order, then title", () => {
    const pages = buildGuide([
      { path: "r.md", content: ok("Ref", "Reference", 1) },
      { path: "z.md", content: ok("Zed", "Getting started") },
      { path: "b.md", content: ok("Bee", "Getting started", 2) },
      { path: "a.md", content: ok("Ay", "Getting started", 2) },
      { path: "c.md", content: ok("Cee", "Getting started", 1) },
      { path: "f.md", content: ok("Agents", "For agents", 1) },
    ]);
    expect(pages.map((p) => p.slug)).toEqual(["c", "a", "b", "z", "r", "f"]);
  });

  it("keeps audience admin and agent", () => {
    const [p] = buildGuide([
      {
        path: "admin/x.md",
        content: page({ title: "X", summary: "S.", section: "Team admin", audience: "admin" }),
      },
    ]);
    expect(p?.slug).toBe("admin/x");
    expect(p?.audience).toBe("admin");
  });

  it("fails on missing required frontmatter, naming the file and the key", () => {
    const found = problems([{ path: "a.md", content: page({ summary: "S.", section: "Memory" }) }]);
    expect(found).toEqual(["docs/guide/a.md: title is required"]);
    expect(problems([{ path: "b.md", content: page({ title: "B", summary: "S." }) }])).toEqual([
      "docs/guide/b.md: section is required",
    ]);
    expect(problems([{ path: "c.md", content: "no frontmatter" }])[0]).toMatch(
      /docs\/guide\/c\.md: missing YAML frontmatter/,
    );
  });

  it("fails on an unknown section or audience", () => {
    const found = problems([
      { path: "a.md", content: page({ title: "A", summary: "S.", section: "Billing" }) },
    ]);
    expect(found[0]).toMatch(
      /docs\/guide\/a\.md: unknown section "Billing" \(one of: Getting started/,
    );
    expect(
      problems([
        {
          path: "b.md",
          content: page({ title: "B", summary: "S.", section: "Memory", audience: "root" }),
        },
      ]),
    ).toHaveLength(1);
  });

  it("fails on a duplicate slug and on a bad file name", () => {
    const found = problems([
      { path: "a.md", content: ok("A", "Memory") },
      { path: "a.md", content: ok("A2", "Memory") },
      { path: "Bad Name.md", content: ok("B", "Memory") },
    ]);
    expect(found).toEqual([
      "docs/guide/a.md: duplicate slug a (also docs/guide/a.md)",
      "docs/guide/Bad Name.md: file names must be lowercase a-z, 0-9 and - and end in .md",
    ]);
  });

  it("fails on a broken relative link, listing every problem", () => {
    const found = problems([
      { path: "a.md", content: ok("A", "Memory", 1, "See [b](b.md) and [c](missing.md).\n") },
      { path: "b.md", content: ok("B", "Memory", 1, "Up [x](../outside.md), [img](pic.png).\n") },
    ]);
    expect(found).toEqual([
      "docs/guide/a.md: broken link missing.md: no page docs/guide/missing.md",
      "docs/guide/b.md: broken link ../outside.md: it leaves docs/guide",
      "docs/guide/b.md: link pic.png: relative links must point at a guide page's .md file",
    ]);
  });

  it("fails on an empty guide", () => {
    expect(problems([])).toEqual(["docs/guide has no pages"]);
  });
});

describe("rewriteLinks", () => {
  const slugs = new Set(["getting-started", "chat/threads", "chat/files", "glossary"]);

  it("rewrites relative .md links for the viewer and the Markdown outputs", () => {
    const r = rewriteLinks(
      'See [Threads](threads.md#pin), [Files](./files.md "Files") and [Start](../getting-started.md).',
      "chat/files",
      slugs,
    );
    expect(r.problems).toEqual([]);
    expect(r.body).toBe(
      'See [Threads](/docs/chat/threads#pin), [Files](/docs/chat/files "Files") and [Start](/docs/getting-started).',
    );
    expect(r.markdown).toBe(
      `See [Threads](${ORIGIN_TOKEN}/docs/chat/threads.md#pin), [Files](${ORIGIN_TOKEN}/docs/chat/files.md "Files") and [Start](${ORIGIN_TOKEN}/docs/getting-started.md).`,
    );
  });

  it("rewrites reference definitions", () => {
    const r = rewriteLinks("[t]: chat/threads.md\n", "glossary", slugs);
    expect(r.body).toBe("[t]: /docs/chat/threads\n");
  });

  it("leaves external links, anchors and code alone; app paths get the origin in Markdown", () => {
    const text = [
      "[web](https://example.com/a.md) [mail](mailto:a@b.c) [top](#top) [mem](/me/memory)",
      "`[code](missing.md)` and ``[more](missing.md)``",
      "```md",
      "[fenced](missing.md)",
      "```",
    ].join("\n");
    const r = rewriteLinks(text, "glossary", slugs);
    expect(r.problems).toEqual([]);
    expect(r.body).toBe(text);
    expect(r.markdown).toContain(`[mem](${ORIGIN_TOKEN}/me/memory)`);
  });

  it("refuses root-relative links into /docs (they must be relative .md links)", () => {
    expect(rewriteLinks("[x](/docs/glossary)", "chat/files", slugs).problems).toEqual([
      "link /docs/glossary: link to the page's .md file with a relative path",
    ]);
  });
});
