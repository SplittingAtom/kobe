// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeKobe } from "../../lib/chat/testing/fake-kobe";
import { must } from "../../lib/testing/must";
import { composer, openApp, streaming } from "./testing";

/**
 * KOBE-374 ac-2/ac-3: the whole composer panel takes the focus outline (focus-within; the text
 * field's own ring is gone) and pulses in the running colour while a run holds the thread.
 * happy-dom has no cascade, so these pin the panel's state attributes and the stylesheet's rules;
 * the token contrast is in app/theme-css.test.ts and the rendering in the gate1 browser spec.
 */
// A variable path: Vite rewrites `new URL("literal", import.meta.url)` into a served asset URL.
const cssFile = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const CSS = cssFile("./composer.module.css").replace(/\/\*[\s\S]*?\*\//g, "");

/** The declarations of the first rule whose selector list is exactly `selector`. */
function rule(css: string, selector: string): string {
  const at = css.indexOf(`${selector} {`);
  if (at < 0) throw new Error(`no rule ${selector}`);
  const start = css.indexOf("{", at) + 1;
  return css.slice(start, css.indexOf("}", start));
}

let fake: FakeKobe;

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  fake = new FakeKobe();
  vi.stubGlobal("fetch", fake.fetch);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const panel = () => must(document.querySelector<HTMLElement>("[data-kobe-composer-panel]"));

async function running(title = "Work") {
  const t = fake.addThread(title);
  openApp(fake, t);
  await userEvent.setup().type(await composer(), "go{Enter}");
  await waitFor(() => expect(fake.activeRun(t)).toBeDefined());
  const runId = must(fake.activeRun(t)).run_id;
  await streaming(fake, runId);
  return { t, runId };
}

describe("whole-composer focus (ac-2)", () => {
  it("focus anywhere in the panel outlines the panel with the focus token", async () => {
    openApp(fake, fake.addThread("Idle"));
    const input = await composer();
    const box = panel();
    expect(box.contains(input)).toBe(true);
    expect(box.className).toMatch(/panel/);
    expect(input.className).toMatch(/input/);
    // The old border-only cue is gone; the outline is the panel's.
    expect(box.className).not.toContain("focus-within:");
    expect(rule(CSS, ".panel:focus-within")).toMatch(
      /outline-color:\s*var\(--kobe-composer-focus\)/,
    );
    // 2px, never taking layout space; none at rest (a transparent one would show in forced colours).
    expect(rule(CSS, ".panel")).toMatch(/outline:\s*2px none /);
    expect(rule(CSS, ".panel:focus-within")).toMatch(/outline-style:\s*solid/);

    // The panel holds the focus (what :focus-within matches; happy-dom has no such selector).
    await userEvent.setup().click(input);
    expect(document.activeElement).toBe(input);
    expect(box.contains(document.activeElement)).toBe(true);
    // A button inside the panel lights the panel too, and keeps its own ring.
    within(box)
      .getByRole("button", { name: /attach/i })
      .focus();
    expect(box.contains(document.activeElement)).toBe(true);
    expect(CSS).not.toMatch(/\.panel\s+button/);
  });

  it("the text field's own blue ring is removed (over the chat's focus ring)", () => {
    const own = rule(CSS, ".panel .input:focus,\n.panel .input:focus-visible");
    expect(own).toMatch(/outline:\s*none/);
    expect(own).toMatch(/box-shadow:\s*none/);
    // The chat-wide ring it overrides (specificity 0,2,0 < 0,3,0).
    expect(cssFile("./chat.module.css")).toMatch(/\.app :focus-visible \{/);
  });

  it("queue mode keeps the same panel and outline", async () => {
    await running();
    const box = panel();
    expect(screen.getByRole("button", { name: "Queue" })).toBeTruthy();
    expect(box.contains(screen.getByRole("button", { name: "Queue" }))).toBe(true);
    expect(box.className).toMatch(/panel/);
  });

  it("a reader of a shared thread gets the note, not a composer panel", async () => {
    const id = fake.addThread("Shared");
    Object.assign(must(fake.threads.get(id)), { read_only: true, owner_name: "Alice" });
    fake.addEntry(id, null, { role: "user", content: "from the author" });
    openApp(fake, id);
    expect(await screen.findByText(/You are reading a shared conversation/)).toBeTruthy();
    expect(document.querySelector("[data-kobe-composer-panel]")).toBeNull();
  });
});

describe("pulse while running (ac-3)", () => {
  /** The body of the first `@keyframes name` block. */
  const keyframes = (name: string) => {
    const at = CSS.indexOf(`@keyframes ${name}`);
    if (at < 0) throw new Error(`no keyframes ${name}`);
    let depth = 0;
    for (let i = CSS.indexOf("{", at); i < CSS.length; i += 1) {
      if (CSS[i] === "{") depth += 1;
      if (CSS[i] === "}" && --depth === 0) return CSS.slice(at, i);
    }
    throw new Error("unclosed keyframes");
  };

  it("pulses in the running colour while a run holds the thread, and stops when it ends", async () => {
    const { runId } = await running();
    await waitFor(() => expect(panel().getAttribute("data-running")).toBe("true"));
    fake.agent.complete(runId);
    await waitFor(() => expect(panel().hasAttribute("data-running")).toBe(false));
  });

  it("stops when the member stops the run", async () => {
    const { runId } = await running();
    await waitFor(() => expect(panel().hasAttribute("data-running")).toBe(true));
    await userEvent.setup().click(screen.getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(fake.run(runId).status).toBe("cancelled"));
    await waitFor(() => expect(panel().hasAttribute("data-running")).toBe(false));
  });

  it("an idle thread has no pulse", async () => {
    openApp(fake, fake.addThread("Idle"));
    await composer();
    expect(panel().hasAttribute("data-running")).toBe(false);
  });

  it("uses the running token and moves only the shadow, so nothing shifts", () => {
    const on = rule(CSS, ".panel[data-running]");
    expect(on).toMatch(/border-color:\s*var\(--kobe-status-running\)/);
    expect(on).toMatch(/animation:\s*kobe-composer-pulse /);
    expect(rule(CSS, ".panel[data-running]:focus-within")).toMatch(
      /outline-color:\s*var\(--kobe-status-running\)/,
    );
    const frames = keyframes("kobe-composer-pulse");
    expect(frames).toContain("var(--kobe-status-running)");
    const animated = [...frames.matchAll(/([a-z-]+)\s*:/g)].map((m) => m[1]);
    expect(new Set(animated)).toEqual(new Set(["box-shadow"]));
  });

  it("has no motion under prefers-reduced-motion", () => {
    const at = CSS.indexOf("@media (prefers-reduced-motion: reduce)");
    expect(at).toBeGreaterThan(CSS.indexOf("@keyframes kobe-composer-pulse"));
    const reduced = rule(CSS.slice(at), ".panel[data-running]");
    expect(reduced).toMatch(/animation:\s*none/);
  });
});

/** [ids, classes + attributes + pseudo-classes, types] of one compound selector chain. */
function specificity(selector: string): [number, number, number] {
  const ids = (selector.match(/#[\w-]+/g) ?? []).length;
  const classes = (selector.match(/\.[\w-]+|\[[^\]]+\]|:(?!:)[\w-]+/g) ?? []).length;
  const types = (selector.replace(/\[[^\]]+\]/g, "").match(/(^|[\s>+~])[a-z][\w-]*/g) ?? []).length;
  return [ids, classes, types];
}
const beats = (a: [number, number, number], b: [number, number, number]) =>
  a[0] !== b[0] ? a[0] > b[0] : a[1] !== b[1] ? a[1] > b[1] : a[2] >= b[2];

describe("drop target over focus and run (KOBE-374 review)", () => {
  it("the mention drop outline wins over the running and focus outlines", () => {
    // Outside the forced-colours block, where the cascade of the normal themes is decided.
    const main = CSS.slice(0, CSS.indexOf("@media (forced-colors: active)"));
    const running = ".panel[data-running]:focus-within";
    const runningAt = main.indexOf(`${running} {`);
    expect(runningAt).toBeGreaterThan(0);
    for (const kind of ["file", "folder"]) {
      const drop = `.panel[data-mention-drop="${kind}"]:focus-within`;
      const at = main.indexOf(`${drop} {`);
      expect(at, drop).toBeGreaterThan(runningAt); // later, so it wins a tie
      expect(beats(specificity(drop), specificity(running)), drop).toBe(true);
      expect(beats(specificity(drop), specificity(".panel:focus-within")), drop).toBe(true);
      expect(rule(main, drop)).toMatch(/outline-color:/);
      expect(rule(main, drop)).toMatch(/outline-style:\s*(solid|dashed)/);
    }
    // Files from the computer during a run: the drop border wins over the running one.
    expect(rule(main, ".panel[data-running][data-dragging]")).toMatch(/border-color:/);
  });
});

describe("forced colours (KOBE-374 review)", () => {
  it("the focus, running and drop cues use system colours, never a transparent outline", () => {
    const at = CSS.indexOf("@media (forced-colors: active)");
    expect(at).toBeGreaterThan(0);
    const forced = CSS.slice(at);
    expect(rule(forced, ".panel[data-running]:focus-within")).toMatch(
      /outline:\s*3px solid Highlight/,
    );
    expect(forced).toMatch(/\.panel:focus-within,\s*\.panel\[data-running\]:focus-within \{/);
    expect(rule(forced, '.panel[data-mention-drop="file"]:focus-within')).toMatch(/Highlight/);
    expect(rule(forced, '.panel[data-mention-drop="folder"]:focus-within')).toMatch(
      /dashed CanvasText/,
    );
    expect(CSS).not.toMatch(/outline:[^;]*transparent/);
  });
});
