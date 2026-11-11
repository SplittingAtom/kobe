import { describe, expect, it } from "vitest";
import { buildGuide } from "./loader.js";
import { llmsFullTxt, llmsTxt, pageMarkdown } from "./llms.js";

/** KOBE-616 (ac-4): /llms.txt, /llms-full.txt and /docs/<slug>.md formatting. */

const fm = (title: string, section: string, extra = "") =>
  `---\ntitle: ${title}\nsummary: About ${title}.\nsection: ${section}\norder: 1\n${extra}---\n`;

const PAGES = buildGuide([
  {
    path: "getting-started.md",
    content: `${fm("Getting started", "Getting started")}\n# Getting started\n\nSee the [Glossary](glossary.md#thread).\n`,
  },
  { path: "glossary.md", content: `${fm("Glossary", "Reference")}\nWords.\n` },
  {
    path: "agents/use.md",
    content: `${fm("Using [Kobe]", "For agents", "audience: agent\n")}\nHow.\n`,
  },
]);
const CTX = { appName: "Acme Chat", origin: "https://chat.example.com" };

describe("llmsTxt", () => {
  it("has the app name, a summary line, a paragraph and sections, For agents first", () => {
    const text = llmsTxt(PAGES, CTX);
    const lines = text.split("\n");
    expect(lines[0]).toBe("# Acme Chat");
    expect(lines[2]).toMatch(/^> Acme Chat is a self-hosted conversational agent platform/);
    expect(lines[4]).toContain("https://chat.example.com/llms-full.txt");
    const headings = lines.filter((l) => l.startsWith("## "));
    expect(headings).toEqual(["## For agents", "## Getting started", "## Reference"]);
    expect(text).toContain(
      "- [Getting started](https://chat.example.com/docs/getting-started.md): About Getting started.",
    );
    expect(text).toContain(
      "- [Using \\[Kobe\\]](https://chat.example.com/docs/agents/use.md): About Using [Kobe].",
    );
    expect(text.endsWith("\n")).toBe(true);
  });
});

describe("pageMarkdown", () => {
  it("has the title as H1, the summary, and absolute links", () => {
    const page = PAGES.find((p) => p.slug === "getting-started");
    expect(pageMarkdown(page as (typeof PAGES)[number], CTX.origin)).toBe(
      "# Getting started\n\n> About Getting started.\n\nSee the [Glossary](https://chat.example.com/docs/glossary.md#thread).\n",
    );
  });
});

describe("llmsFullTxt", () => {
  it("concatenates every page with its title and source URL, For agents first", () => {
    const text = llmsFullTxt(PAGES, CTX);
    expect(text.startsWith("# Acme Chat user guide\n")).toBe(true);
    const titles = text.split("\n").filter((l) => /^# /.test(l));
    expect(titles).toEqual([
      "# Acme Chat user guide",
      "# Using [Kobe]",
      "# Getting started",
      "# Glossary",
    ]);
    expect(text).toContain("Source: https://chat.example.com/docs/glossary.md");
    expect(text).not.toContain("%%KOBE_ORIGIN%%");
  });
});

describe("llmsFullTxt with a section (KOBE-620 docs_full)", () => {
  it("keeps only that section's pages", () => {
    const text = llmsFullTxt(PAGES, CTX, "Reference");
    const titles = text.split("\n").filter((l) => /^# /.test(l));
    expect(titles).toEqual(["# Acme Chat user guide", "# Glossary"]);
  });
});
