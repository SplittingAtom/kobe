// @vitest-environment happy-dom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeKobe } from "../../lib/chat/testing/fake-kobe";
import { Markdown } from "../chat/markdown";
import { openApp } from "../chat/testing";
import { IconActionProvider } from "../shell/icon-action";
import { DocsNav, filterPages, type DocsNavGroup } from "./docs-nav";

/** KOBE-616: the bar's Docs icon, the guide's nav and filter, and guide Markdown. */
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const GROUPS: DocsNavGroup[] = [
  {
    section: "Getting started",
    id: "getting-started",
    pages: [{ slug: "getting-started", title: "Getting started", summary: "Sign in and chat." }],
  },
  {
    section: "Reference",
    id: "reference",
    pages: [
      { slug: "glossary", title: "Glossary", summary: "The words Kobe uses." },
      { slug: "ref/limits", title: "Limits", summary: "Upload and run limits." },
    ],
  },
];

describe("the Docs icon", () => {
  it("sits in the bar's first row and opens /docs, the Docs panel over the workspace", async () => {
    const fake = new FakeKobe();
    vi.stubGlobal("fetch", fake.fetch);
    openApp(fake);
    const row = (await screen.findByRole("banner")).querySelector<HTMLElement>(
      '[data-bar-row="1"]',
    );
    const link = await within(row as HTMLElement).findByRole("link", { name: "Docs" });
    expect(link.getAttribute("href")).toBe("/docs");
    expect(link.getAttribute("target")).toBeNull();
    expect(link.getAttribute("data-command")).toBe("docs");
    // The same IconAction look as its neighbours: a lucide icon, the name in a tooltip.
    expect(link.querySelector("svg.lucide-book-open")).not.toBeNull();
  });
});

describe("DocsNav", () => {
  it("lists pages by section and marks the current one", () => {
    render(<DocsNav groups={GROUPS} current="glossary" />);
    const nav = screen.getByRole("navigation", { name: "Guide" });
    expect(within(nav).getByRole("heading", { name: "Reference" })).toBeTruthy();
    const current = within(nav).getByRole("link", { name: "Glossary" });
    expect(current.getAttribute("aria-current")).toBe("page");
    expect(within(nav).getByRole("link", { name: "Limits" }).getAttribute("href")).toBe(
      "/docs/ref/limits",
    );
  });

  it("filters over titles and summaries", async () => {
    render(<DocsNav groups={GROUPS} current={null} />);
    await userEvent.type(screen.getByRole("searchbox", { name: "Filter pages" }), "upload");
    const nav = screen.getByRole("navigation", { name: "Guide" });
    expect(
      within(nav)
        .getAllByRole("link")
        .map((a) => a.textContent),
    ).toEqual(["Limits"]);
    await userEvent.clear(screen.getByRole("searchbox", { name: "Filter pages" }));
    await userEvent.type(screen.getByRole("searchbox", { name: "Filter pages" }), "zzz");
    expect(within(nav).getByText("No pages match.")).toBeTruthy();
    expect(filterPages(GROUPS, "kobe WORDS").map((p) => p.slug)).toEqual(["glossary"]);
    expect(filterPages(GROUPS, " ")).toHaveLength(3);
  });

  it("folds behind Contents on a phone", async () => {
    render(<DocsNav groups={GROUPS} current={null} />);
    const toggle = screen.getByRole("button", { name: "Contents" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    await userEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
  });
});

describe('Markdown variant="guide"', () => {
  function guide(text: string) {
    return render(
      <IconActionProvider>
        <Markdown text={text} variant="guide" />
      </IconActionProvider>,
    ).container;
  }

  it("links the guide's own pages in the same tab and others in a new one", () => {
    const root = guide(
      "[Glossary](/docs/glossary#thread) [top](#top) [web](https://example.com) [bad](javascript:alert(1)) [proto](//evil.example)",
    );
    const href = (name: string) => screen.getByText(name).closest("a");
    expect(href("Glossary")?.getAttribute("href")).toBe("/docs/glossary#thread");
    expect(href("Glossary")?.getAttribute("target")).toBeNull();
    expect(href("top")?.getAttribute("href")).toBe("#top");
    expect(href("web")?.getAttribute("target")).toBe("_blank");
    expect(href("bad")).toBeNull();
    expect(href("proto")).toBeNull();
    expect(root.querySelector("script")).toBeNull();
  });

  it("gives h2–h4 ids with an anchor link, and keeps raw HTML as text", () => {
    const root = guide("## Sign in\n\n### Sign in\n\n<b>bold</b>");
    expect([...root.querySelectorAll("h2, h3")].map((h) => h.id)).toEqual(["sign-in", "sign-in-1"]);
    expect(
      screen.getAllByRole("link", { name: "Link to this section" })[0]?.getAttribute("href"),
    ).toBe("#sign-in");
    expect(root.querySelector("b")).toBeNull();
  });

  it("leaves the chat's Markdown as it was (relative links are text, no heading ids)", () => {
    const root = render(
      <IconActionProvider>
        <Markdown text={"## Hi\n\n[x](/docs/glossary)"} />
      </IconActionProvider>,
    ).container;
    expect(root.querySelector("h2")?.id).toBe("");
    expect(root.querySelector("a")).toBeNull();
  });
});
