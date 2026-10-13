// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { cleanup, renderHook, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { viewport } from "../../app/layout";
import { FakeKobe } from "../../lib/chat/testing/fake-kobe";
import { BREAKPOINTS } from "../../lib/shell/layout";
import { must } from "../../lib/testing/must";
import { composer, openApp } from "../chat/testing";
import { useViewportHeight } from "../chat/use-viewport-height";

/**
 * KOBE-205 (CE9, ac-3, ac-4): the page never scrolls, each column scrolls on its own and the
 * composer is a fixed footer of the conversation. happy-dom has no layout engine, so this pins the
 * CSS and DOM contract that layout rests on; the real widths are checked in a browser on gate1.
 */
const css = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const SHELL = css("./shell.module.css");
const CHAT = css("../chat/chat.module.css");
const RAIL = css("./rail.module.css");

/** Every declaration block whose selector list names `selector`, media blocks included. */
function rules(source: string, selector: string): string[] {
  const out: string[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  for (const [, selectors = "", body = ""] of source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .matchAll(re)) {
    if (selectors.split(",").some((s) => s.trim() === selector)) out.push(body);
  }
  return out;
}

const declares = (source: string, selector: string, declaration: string) =>
  rules(source, selector).some((body) => body.includes(declaration));

describe("CSS contract", () => {
  it("the chat is exactly as tall as the window and never scrolls the page", () => {
    expect(declares(CHAT, ".app", "height: var(--kobe-viewport-height, 100dvh);")).toBe(true);
    expect(declares(CHAT, ".app", "overflow: hidden;")).toBe(true);
    expect(declares(CHAT, ".app", "top: var(--kobe-viewport-offset, 0px);")).toBe(true);
    expect(declares(CHAT, ".main", "overflow: hidden;")).toBe(true);
    expect(viewport.interactiveWidget).toBe("resizes-content");
  });

  it("the rail and the artifact column scroll on their own; the conversation leaves it to its list", () => {
    expect(declares(SHELL, ".rail", "overflow-y: auto;")).toBe(true);
    expect(declares(SHELL, ".artifact", "overflow-y: auto;")).toBe(true);
    expect(declares(SHELL, ".rail", "overscroll-behavior: contain;")).toBe(true);
    expect(declares(SHELL, ".conversation", "overflow: hidden;")).toBe(true);
  });

  it("the grid's row is bounded at every width, so no column can push the page taller", () => {
    const grid = rules(SHELL, ".grid");
    // One row at every width: under 768 px the rail and the artifact column leave the grid
    // (drawer, sheet; KOBE-201), so the conversation is all of it.
    expect(grid.some((b) => b.includes("grid-template-rows: minmax(0, 1fr);"))).toBe(true);
    expect(
      grid.some((b) => b.includes("grid-template-rows:") && !b.includes("minmax(0, 1fr)")),
    ).toBe(false);
    expect(grid.some((b) => b.includes("min-height: 0;"))).toBe(true);
  });

  it("the artifact column: half by default, a dragged width within both floors, none when empty (KOBE-200)", () => {
    const flat = (bodies: string[]) => bodies.map((b) => b.replace(/\s+/g, " "));
    expect(
      declares(SHELL, ".grid", "--kobe-artifact-width: calc((100% - var(--kobe-rail-width)) / 2);"),
    ).toBe(true);
    const floors =
      "minmax(360px, min(var(--kobe-artifact-width), 100% - var(--kobe-rail-width) - 400px)) minmax(400px, 1fr);";
    expect(
      flat(rules(SHELL, ".grid:has(> .artifact:not(:empty))")).some((b) => b.includes(floors)),
    ).toBe(true);
    expect(declares(SHELL, ".artifact:empty", "display: none;")).toBe(true);
    // The resize handle has its own strip, off the column's scrollbar (review round 1).
    expect(declares(SHELL, ".artifact", "padding-inline-end: 6px;")).toBe(true);
  });
});

/** The body of `@media <query> { … }` (the first one), braces matched; "" when absent. */
function media(source: string, query: string): string {
  const flat = source.replace(/\/\*[\s\S]*?\*\//g, "");
  const start = flat.indexOf(`@media ${query} {`);
  if (start < 0) return "";
  let depth = 0;
  for (let i = flat.indexOf("{", start); i < flat.length; i += 1) {
    if (flat[i] === "{") depth += 1;
    if (flat[i] === "}") depth -= 1;
    if (depth === 0) return flat.slice(flat.indexOf("{", start) + 1, i);
  }
  return "";
}

describe("breakpoints (KOBE-201, CE7, CE8)", () => {
  const below = (px: number) => `(max-width: ${px - 0.02}px)`;
  const from = (px: number) => `(min-width: ${px}px)`;

  it("the CSS bands sit on the layout module's numbers", () => {
    expect(BREAKPOINTS).toEqual({ overlay: 768, medium: 820, wide: 1100 });
    for (const query of [
      below(BREAKPOINTS.overlay),
      from(BREAKPOINTS.overlay),
      `${from(BREAKPOINTS.overlay)} and ${below(BREAKPOINTS.medium)}`,
      from(BREAKPOINTS.medium),
      below(BREAKPOINTS.wide),
    ]) {
      expect(media(SHELL, query), query).not.toBe("");
    }
    expect(media(RAIL, below(BREAKPOINTS.overlay))).not.toBe("");
  });

  it("below 1100 px the rail's column is 48 px; an expanded rail is a drawer over it", () => {
    expect(
      declares(media(SHELL, below(BREAKPOINTS.wide)), ".grid", "--kobe-rail-width: 48px;"),
    ).toBe(true);
    const drawer = rules(RAIL, ".rail[data-drawer]").join("");
    expect(drawer).toContain("position: absolute;");
    expect(drawer).toContain("width: min(280px, 85vw);");
  });

  it("from 820 px the artifact column sits beside the conversation, within both floors", () => {
    const column = media(SHELL, from(BREAKPOINTS.medium)).replace(/\s+/g, " ");
    expect(column).toContain(
      "minmax(360px, min(var(--kobe-artifact-width), 100% - var(--kobe-rail-width) - 400px)) minmax(400px, 1fr);",
    );
    expect(declares(column, ".resizeHandle", "display: block;")).toBe(true);
  });

  it("768–820: the artifact column is a sheet over the conversation, shown only while open", () => {
    const overlay = media(SHELL, `${from(BREAKPOINTS.overlay)} and ${below(BREAKPOINTS.medium)}`);
    expect(declares(overlay, ".artifact", "position: absolute;")).toBe(true);
    expect(
      declares(overlay, ".artifact", "width: clamp(360px, 50%, 100% - var(--kobe-rail-width));"),
    ).toBe(true);
    expect(declares(overlay, ".artifact:not([data-sheet-open])", "display: none;")).toBe(true);
    // Not a grid column there: the conversation keeps everything right of the 48 px rail.
    expect(overlay).not.toContain("grid-template-columns");
  });

  it("under 768 px: one column; the drawer and the full-screen sheet leave the grid", () => {
    const single = media(SHELL, below(BREAKPOINTS.overlay));
    expect(declares(single, ".rail", "display: contents;")).toBe(true);
    expect(declares(single, ".artifact", "display: contents;")).toBe(true);
    expect(declares(single, ".artifact[data-sheet-open] > *", "inset: 0;")).toBe(true);
    expect(declares(single, ".artifact:not([data-sheet-open]) > *", "display: none;")).toBe(true);
    expect(
      declares(
        media(RAIL, below(BREAKPOINTS.overlay)),
        ".rail:not([data-drawer])",
        "display: none;",
      ),
    ).toBe(true);
  });

  it("the drawer and the sheets move only for members who allow motion", () => {
    for (const source of [SHELL, RAIL]) {
      const motion = media(source, "(prefers-reduced-motion: no-preference)");
      const all = source.match(/animation:/g) ?? [];
      expect(all.length).toBeGreaterThan(0);
      expect((motion.match(/animation:/g) ?? []).length).toBe(all.length);
    }
  });
});

describe("DOM contract", () => {
  let kobe: FakeKobe;
  beforeEach(() => {
    sessionStorage.clear();
    kobe = new FakeKobe();
    vi.stubGlobal("fetch", kobe.fetch);
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("the composer sits in the conversation column, below and outside the message list's scroll", async () => {
    const t = kobe.addThread("Sales");
    kobe.addEntry(t, null, { role: "user", content: "q1" });
    openApp(kobe, t);
    const input = await composer();
    expect(await screen.findByText("q1")).toBeTruthy();

    const list = must(document.querySelector<HTMLElement>('[data-kobe-scroll="messages"]'));
    const footer = must(input.closest<HTMLElement>("[data-kobe-composer]"));
    const conversation = must(document.querySelector('[data-shell-region="conversation"]'));
    expect(list.contains(input)).toBe(false);
    expect(conversation.contains(list) && conversation.contains(footer)).toBe(true);
    expect(list.compareDocumentPosition(footer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(list.className).toMatch(/\boverflow-y-auto\b/);
    expect(list.className).toMatch(/\[overflow-anchor:auto\]/);
    expect(footer.className).toMatch(/\bshrink-0\b/);
    expect(list.getAttribute("role")).toBe("region");
    expect(list.getAttribute("aria-labelledby")).toBe("kobe-thread-title");
  });
});

describe("rail width (KOBE-267)", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("the sections grid is one column exactly the rail's width, so the divider is too", () => {
    expect(declares(RAIL, ".sections", "grid-template-columns: minmax(0, 1fr);")).toBe(true);
    // An explicit width or min-width on the divider could still push past the rail.
    const divider = rules(RAIL, ".divider").join("");
    expect(divider).toContain("min-width: 0;");
    expect(divider).not.toMatch(/(^|[^-])width:/);
  });

  it("nothing in the rail is sized by a title's length: every level may shrink", () => {
    expect(declares(RAIL, ".rail", "min-width: 0;")).toBe(true);
    expect(declares(RAIL, ".rail", "overflow-x: clip;")).toBe(true);
    for (const selector of [".expanded", ".sections", ".section", ".sectionBody", ".scroll"]) {
      expect(declares(RAIL, selector, "min-width: 0;"), selector).toBe(true);
    }
    for (const selector of [".threadList", ".threadItem", ".threadTrigger"]) {
      expect(declares(CHAT, selector, "min-width: 0;"), selector).toBe(true);
    }
    const trigger = rules(CHAT, ".threadTrigger").join("");
    for (const d of ["overflow: hidden;", "text-overflow: ellipsis;", "white-space: nowrap;"]) {
      expect(trigger).toContain(d);
    }
  });

  it("a 200-character title renders inside the ellipsizing trigger, in the rail", async () => {
    const kobe = new FakeKobe();
    vi.stubGlobal("fetch", kobe.fetch);
    const title = "Quarterly revenue reconciliation ".repeat(7).slice(0, 200);
    kobe.addThread(title);
    openApp(kobe);
    const rail = await screen.findByRole("complementary", { name: "Workspace" });
    const text = await within(rail).findByText(title);
    const trigger = must(text.closest("button"), "trigger");
    expect(trigger.className).toMatch(/threadTrigger/);
    expect(trigger.closest("aside")).toBe(rail);
  });
});

describe("on-screen keyboard (visualViewport)", () => {
  afterEach(() => vi.unstubAllGlobals());

  function fakeVisualViewport(height: number, scale = 1) {
    const listeners = new Set<() => void>();
    const vv = {
      height,
      scale,
      offsetTop: 0,
      events: new Set<string>(),
      addEventListener: (type: string, fn: () => void) => {
        vv.events.add(type);
        listeners.add(fn);
      },
      removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
      fire: () => listeners.forEach((fn) => fn()),
    };
    vi.stubGlobal("visualViewport", vv);
    return vv;
  }

  it("sizes the chat to what is visible, and leaves zoom alone", () => {
    const vv = fakeVisualViewport(800);
    const el = document.createElement("div");
    const { unmount } = renderHook(() => useViewportHeight(el));
    expect(el.style.getPropertyValue("--kobe-viewport-height")).toBe("800px");
    expect([...vv.events].sort()).toEqual(["resize", "scroll"]);

    vv.height = 420; // the keyboard opened, and iOS panned the page down to the input
    vv.offsetTop = 380;
    vv.fire();
    expect(el.style.getPropertyValue("--kobe-viewport-height")).toBe("420px");
    expect(el.style.getPropertyValue("--kobe-viewport-offset")).toBe("380px");

    vv.scale = 2; // pinch zoom
    vv.fire();
    expect(el.style.getPropertyValue("--kobe-viewport-height")).toBe("");
    expect(el.style.getPropertyValue("--kobe-viewport-offset")).toBe("");

    vv.scale = 1;
    vv.fire();
    unmount();
    expect(el.style.getPropertyValue("--kobe-viewport-height")).toBe("");
  });
});
