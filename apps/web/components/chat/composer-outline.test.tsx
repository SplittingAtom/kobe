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
    // 2px, never taking layout space: the resting outline is transparent, not absent.
    expect(rule(CSS, ".panel")).toMatch(/outline:\s*2px solid transparent/);

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
