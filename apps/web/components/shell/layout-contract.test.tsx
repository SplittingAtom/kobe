// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { cleanup, renderHook, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { viewport } from "../../app/layout";
import { FakeKobe } from "../../lib/chat/testing/fake-kobe";
import { BAND_QUERIES, BREAKPOINTS, SHELL_SPACING_PX } from "../../lib/shell/layout";
import { must } from "../../lib/testing/must";
import { composer, openApp, openThreads } from "../chat/testing";
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
const GLOBAL = css("../../app/chat-global.css");

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

/** One line, no padding inside parentheses: the formatter may wrap a long value. */
const flatCss = (s: string) => s.replace(/\s+/g, " ").replace(/\(\s+/g, "(").replace(/\s+\)/g, ")");

const declares = (source: string, selector: string, declaration: string) =>
  rules(source, selector).some((body) => flatCss(body).includes(flatCss(declaration)));

/** The value of `property` in the first rule for `selector` that declares it. */
function value(source: string, selector: string, property: string): string {
  for (const body of rules(source, selector)) {
    const m = new RegExp(`(?:^|[;{\\s])${property}:\\s*([^;]+);`).exec(flatCss(body));
    if (m?.[1]) return m[1].trim();
  }
  throw new Error(`no ${property} in ${selector}`);
}

/**
 * A px length from a CSS value made of calc(), min(), var() and px: variables come from `vars`,
 * `100%` is `percentBase` px. Enough to check the shell's arithmetic without a layout engine.
 */
function evaluate(expr: string, vars: Record<string, string>, percentBase: number): number {
  let out = expr;
  for (let i = 0; i < 10 && out.includes("var("); i += 1) {
    out = out.replace(
      /var\((--[\w-]+)(?:,\s*([^()]+))?\)/g,
      (_m, name: string, fallback?: string) => {
        const v = vars[name] ?? fallback;
        if (v === undefined) throw new Error(`no ${name}`);
        return `(${v})`;
      },
    );
  }
  const js = out
    .replace(/100%/g, `${percentBase}`)
    .replace(/(\d)px/g, "$1")
    .replace(/calc\(/g, "(")
    .replace(/min\(/g, "Math.min(")
    .replace(/max\(/g, "Math.max(");
  if (!/^[\d\s+\-*/().,Mathimnx]*$/.test(js)) throw new Error(`cannot evaluate ${js}`);
  return Number(new Function(`return ${js};`)());
}

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
    const flat = (bodies: string[]) => bodies.map(flatCss);
    expect(
      declares(
        SHELL,
        ".grid",
        "--kobe-artifact-width: calc((100% - var(--kobe-rail-width) - 2 * var(--kobe-shell-gap)) / 2);",
      ),
    ).toBe(true);
    // The two gaps come out of the room first; the column yields to the conversation's 400 px
    // at the medium band's lower edge, where the gutters leave less than both floors (KOBE-554).
    const floors =
      "minmax(min(360px, var(--kobe-artifact-room)), min(var(--kobe-artifact-width), var(--kobe-artifact-room))) minmax(400px, 1fr);";
    expect(
      flat(rules(SHELL, ".grid:has(> .artifact:not(:empty):not([data-hidden]))")).some((b) =>
        b.includes(floors),
      ),
    ).toBe(true);
    expect(declares(SHELL, ".artifact:empty", "display: none;")).toBe(true);
    // Hidden by the member (KOBE-225): no column, its previews still mounted.
    expect(declares(SHELL, ".artifact[data-hidden]", "display: none;")).toBe(true);
    // The resize handle has its own strip, off the column's scrollbar (review round 1).
    expect(declares(SHELL, ".artifact", "padding-inline-end: var(--kobe-handle-width);")).toBe(
      true,
    );
  });
});

describe("floating cards (KOBE-554)", () => {
  it("the grid has a 16 px page gutter and a 16 px gap between the columns at every width", () => {
    expect(declares(SHELL, ".grid", "--kobe-shell-gutter: 16px;")).toBe(true);
    expect(declares(SHELL, ".grid", "--kobe-shell-gap: 16px;")).toBe(true);
    expect(declares(SHELL, ".grid", "padding: var(--kobe-shell-gutter);")).toBe(true);
    expect(declares(SHELL, ".grid", "column-gap: var(--kobe-shell-gap);")).toBe(true);
    // The rail's room counts the gaps beside the floors.
    expect(declares(SHELL, ".grid", "--kobe-rail-room: calc(400px + var(--kobe-shell-gap));")).toBe(
      true,
    );
  });

  it("rail, artifact column and conversation are cards: card colour, border, panel radius", () => {
    for (const region of [".rail", ".artifact", ".conversation"]) {
      expect(declares(SHELL, region, "background: var(--card);"), region).toBe(true);
      expect(declares(SHELL, region, "border: 1px solid var(--border);"), region).toBe(true);
      expect(declares(SHELL, region, "border-radius: var(--kobe-radius-lg);"), region).toBe(true);
    }
    // No edge borders left from the edge-to-edge layout: the card's border replaces them.
    expect(RAIL).not.toMatch(/border-inline-end/);
    expect(declares(SHELL, ".artifact", "border-inline-end: 1px solid var(--admin-border);")).toBe(
      false,
    );
    // The rail's own surface is the card's, so the card colour shows to its rounded edge.
    expect(declares(RAIL, ".rail", "background: var(--card);")).toBe(true);
  });

  it("the rail's handle sits in the middle of the gap, also when the rail is clamped", () => {
    const wide = media(SHELL, "(width >= 1100px)");
    const column = media(SHELL, "(width >= 820px)");
    expect(declares(wide, ".railHandle", "inset-block: var(--kobe-shell-gutter);")).toBe(true);
    const vars = {
      "--kobe-shell-gutter": value(SHELL, ".grid", "--kobe-shell-gutter"),
      "--kobe-shell-gap": value(SHELL, ".grid", "--kobe-shell-gap"),
      "--kobe-handle-width": value(SHELL, ".grid", "--kobe-handle-width"),
      // The artifact column is open: both floors and both gaps are the rail's room.
      "--kobe-rail-room": value(
        column,
        ".grid:has(> .artifact:not(:empty):not([data-hidden]))",
        "--kobe-rail-room",
      ),
      "--kobe-rail-handle-track": value(wide, ".railHandle", "--kobe-rail-handle-track"),
    };
    // A 1,100 px window, the rail dragged to 480 px: the clamp gives it 276 px (1,068 − 792).
    for (const [windowPx, dragged, rail] of [
      [1100, 480, 276],
      [1280, 480, 456],
      [1600, 300, 300],
    ] as const) {
      const all = { ...vars, "--kobe-rail-expanded-width": `${dragged}px` };
      // The columns resolve 100% against the grid's content box, the handle against its padding box.
      const track = evaluate(value(SHELL, ".grid", "--kobe-rail-width"), all, windowPx - 32);
      expect(track, `${windowPx}`).toBe(rail);
      const left = evaluate(value(wide, ".railHandle", "inset-inline-start"), all, windowPx);
      const width = evaluate("var(--kobe-handle-width)", all, windowPx);
      // Centred in the gap that starts after the gutter and the rail's track.
      expect(left + width / 2, `${windowPx}`).toBe(16 + rail + 16 / 2);
    }
  });

  it("the 16 px lives in one place: SHELL_SPACING_PX, the grid's variables, the console's gap-4 p-4", () => {
    expect(value(SHELL, ".grid", "--kobe-shell-gutter")).toBe(`${SHELL_SPACING_PX.gutter}px`);
    expect(value(SHELL, ".grid", "--kobe-shell-gap")).toBe(`${SHELL_SPACING_PX.gap}px`);
    // Tailwind's spacing step is 4 px: gap-4 and p-4 are 16 px.
    const consoleLayout = css("../ui/console/layout.tsx");
    expect(consoleLayout).toContain(`gap-${SHELL_SPACING_PX.gap / 4}`);
    expect(consoleLayout).toContain(`p-${SHELL_SPACING_PX.gutter / 4}`);
  });

  it("the drawer and the overlay sheet keep the 16 px gutters (full height under 768 px)", () => {
    // Under 768 px `.app` holds the drawer: full height from the window's edge, not over the bar.
    const single = media(RAIL, "(width < 768px)");
    expect(declares(single, ".rail[data-drawer]", "inset-block: 0;")).toBe(true);
    expect(declares(single, ".rail[data-drawer]", "inset-inline-start: 0;")).toBe(true);
    expect(
      declares(RAIL, ".rail[data-drawer]", "inset-block: var(--kobe-shell-gutter, 16px);"),
    ).toBe(true);
    expect(
      declares(RAIL, ".rail[data-drawer]", "inset-inline-start: var(--kobe-shell-gutter, 16px);"),
    ).toBe(true);
    expect(declares(RAIL, ".rail[data-drawer]", "border-radius: var(--kobe-radius-lg);")).toBe(
      true,
    );
    const sheet = media(SHELL, "(768px <= width < 820px)").replace(/\s+/g, " ");
    expect(sheet).toContain("inset-block: var(--kobe-shell-gutter);");
    expect(sheet).toContain("bottom: anchor(--kobe-composer top, var(--kobe-shell-gutter));");
    expect(sheet).toContain("inset-inline-end: var(--kobe-shell-gutter);");
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
  // Range syntax, the same as `BAND_QUERIES`, so CSS and JS agree at fractional widths.
  const below = (px: number) => `(width < ${px}px)`;
  const from = (px: number) => `(width >= ${px}px)`;
  const between = (lo: number, hi: number) => `(${lo}px <= width < ${hi}px)`;

  it("the CSS bands sit on the layout module's numbers, in the same range syntax", () => {
    expect(BREAKPOINTS).toEqual({ overlay: 768, medium: 820, wide: 1100 });
    for (const q of Object.values(BAND_QUERIES)) expect(q).toMatch(/^\(width >= \d+px\)$/);
    // No min-/max-width with a fractional edge left in the shell's CSS.
    expect(`${SHELL}${RAIL}`).not.toMatch(/\((min|max)-width/);
    for (const query of [
      below(BREAKPOINTS.overlay),
      from(BREAKPOINTS.overlay),
      between(BREAKPOINTS.overlay, BREAKPOINTS.medium),
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
    const column = flatCss(media(SHELL, from(BREAKPOINTS.medium)));
    expect(column).toContain(
      "minmax(min(360px, var(--kobe-artifact-room)), min(var(--kobe-artifact-width), var(--kobe-artifact-room))) minmax(400px, 1fr);",
    );
    expect(column).toContain(
      "--kobe-artifact-room: calc(100% - var(--kobe-rail-width) - 2 * var(--kobe-shell-gap) - 400px);",
    );
    expect(declares(column, ".resizeHandle", "display: block;")).toBe(true);
  });

  it("768–820: the artifact column is a sheet over the conversation, shown only while open", () => {
    const overlay = media(SHELL, between(BREAKPOINTS.overlay, BREAKPOINTS.medium));
    expect(declares(overlay, ".artifact", "position: absolute;")).toBe(true);
    expect(
      declares(
        overlay,
        ".artifact",
        "width: clamp(360px, 50%, 100% - var(--kobe-rail-width) - 2 * var(--kobe-shell-gutter) - var(--kobe-shell-gap));",
      ),
    ).toBe(true);
    expect(declares(overlay, ".artifact:not([data-sheet-open])", "display: none;")).toBe(true);
    // Not a grid column there: the conversation keeps everything right of the 48 px rail.
    expect(overlay).not.toContain("grid-template-columns");
    // KOBE-269: the sheet ends above the composer, so Send stays reachable (anchor positioning).
    // No anchor on screen (loading, error): the fallback keeps it full height (inside the
    // gutter, KOBE-554); no anchor positioning at all: the declaration drops, with the same result.
    expect(
      declares(
        overlay,
        ".artifact",
        "bottom: anchor(--kobe-composer top, var(--kobe-shell-gutter));",
      ),
    ).toBe(true);
    expect(
      declares(
        GLOBAL,
        "[data-kobe-chat] [data-kobe-composer-box]",
        "anchor-name: --kobe-composer;",
      ),
    ).toBe(true);
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
    // The rail handle's highlight fades only then too (KOBE-305).
    const motion = media(SHELL, "(prefers-reduced-motion: no-preference)");
    const transitions = SHELL.match(/transition:/g) ?? [];
    expect(transitions.length).toBeGreaterThan(0);
    expect((motion.match(/transition:/g) ?? []).length).toBe(transitions.length);
  });

  it("the rail's dragged width yields to the columns' floors; its handle is wide-only (KOBE-305)", () => {
    // 280 px unless dragged, never leaving the conversation (and an open artifact column) less
    // than its floor.
    expect(declares(SHELL, ".grid", "--kobe-rail-room: calc(400px + var(--kobe-shell-gap));")).toBe(
      true,
    );
    expect(
      declares(
        SHELL,
        ".grid",
        "--kobe-rail-width: min(var(--kobe-rail-expanded-width, 280px), 100% - var(--kobe-rail-room));",
      ),
    ).toBe(true);
    const column = flatCss(media(SHELL, from(BREAKPOINTS.medium)));
    expect(
      declares(
        column,
        ".grid:has(> .artifact:not(:empty):not([data-hidden]))",
        "--kobe-rail-room: calc(760px + 2 * var(--kobe-shell-gap));",
      ),
    ).toBe(true);
    // Collapsed and narrower bands keep 48 px whatever was dragged.
    expect(
      declares(SHELL, ".grid:has(> .rail > [data-collapsed])", "--kobe-rail-width: 48px;"),
    ).toBe(true);
    expect(declares(SHELL, ".railHandle", "display: none;")).toBe(true);
    const wide = media(SHELL, from(BREAKPOINTS.wide));
    expect(declares(wide, ".railHandle", "display: block;")).toBe(true);
    expect(declares(wide, ".railHandle", "cursor: col-resize;")).toBe(true);
    // In the gap between the rail card and the next (KOBE-554; geometry in "floating cards").
    expect(
      declares(
        wide,
        ".railHandle",
        "inset-inline-start: calc(var(--kobe-shell-gutter) + var(--kobe-rail-handle-track) + (var(--kobe-shell-gap) - var(--kobe-handle-width)) / 2);",
      ),
    ).toBe(true);
    expect(declares(wide, ".railHandle:focus-visible", "background: var(--admin-accent);")).toBe(
      true,
    );
    // A visible focus in forced colours too (no `outline: none`), and a 24 px touch target.
    expect(declares(wide, ".railHandle:focus-visible", "outline: 2px solid transparent;")).toBe(
      true,
    );
    // The hit area: the whole gap for a mouse (−5 px each side), 24 px for touch (−9 px).
    const vars = {
      "--kobe-shell-gap": value(SHELL, ".grid", "--kobe-shell-gap"),
      "--kobe-handle-width": value(SHELL, ".grid", "--kobe-handle-width"),
    };
    expect(evaluate(value(wide, ".railHandle::before", "inset-inline"), vars, 0)).toBe(-5);
    const touch = media(SHELL, "(width >= 1100px) and (pointer: coarse)");
    expect(evaluate(value(touch, ".railHandle::before", "inset-inline"), vars, 0)).toBe(-9);
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

  it("the sheet's anchor is the composer box (steering panel and input), not its footer (KOBE-269)", async () => {
    const t = kobe.addThread("Sales");
    kobe.addEntry(t, null, { role: "user", content: "q1" });
    openApp(kobe, t);
    const input = await composer();
    const boxes = document.querySelectorAll("[data-kobe-composer-box]");
    expect(boxes).toHaveLength(1);
    const box = must(boxes[0]);
    expect(box.contains(input)).toBe(true);
    expect(box.querySelector("[data-kobe-steering]")).toBeTruthy();
    // The footer grows (welcome, notices); the box is only as tall as what it holds.
    expect(box.hasAttribute("data-kobe-composer")).toBe(false);
    expect(box.className).not.toMatch(/\bflex-1\b/);
  });
});

describe("rail width (KOBE-267)", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("the sections grid is one column exactly the rail's width", () => {
    expect(declares(RAIL, ".sections", "grid-template-columns: minmax(0, 1fr);")).toBe(true);
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

  it("a 200-character title renders inside the ellipsizing trigger, in the Threads panel", async () => {
    const kobe = new FakeKobe();
    vi.stubGlobal("fetch", kobe.fetch);
    const title = "Quarterly revenue reconciliation ".repeat(7).slice(0, 200);
    kobe.addThread(title);
    openApp(kobe);
    const panel = await openThreads();
    const text = await within(panel).findByText(title);
    const trigger = must(text.closest("button"), "trigger");
    expect(trigger.className).toMatch(/threadTrigger/);
    expect(trigger.closest("[data-kobe-panel]")).toBe(panel);
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
