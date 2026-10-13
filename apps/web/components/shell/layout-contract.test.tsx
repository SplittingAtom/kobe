// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { cleanup, renderHook, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { viewport } from "../../app/layout";
import { FakeKobe } from "../../lib/chat/testing/fake-kobe";
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
    // One column: the conversation keeps 20rem (or all there is); the rail and artifact yield.
    const narrow =
      "grid-template-rows: minmax(0, auto) minmax(min(20rem, 100%), 1fr) minmax(0, auto);";
    expect(grid.some((b) => b.includes(narrow))).toBe(true);
    expect(grid.some((b) => b.includes("grid-template-rows: minmax(0, 1fr);"))).toBe(true);
    expect(grid.some((b) => b.includes("min-height: 0;"))).toBe(true);
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
