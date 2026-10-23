// @vitest-environment happy-dom
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeKobe } from "../../lib/chat/testing/fake-kobe";
import { RAIL_PX } from "../../lib/shell/layout";
import { PREFERENCES_PATH } from "../../lib/shell/preferences";
import { RAIL_WIDTH_VAR } from "../../lib/shell/rail-width";
import { isMacPlatform } from "../../lib/shell/shortcuts";
import { must } from "../../lib/testing/must";
import { DESKTOP_WIDTH, resizeWindow } from "../../lib/testing/viewport";
import { openApp } from "../chat/testing";

/**
 * KOBE-305: the resizable rail. happy-dom has no layout engine, so the columns' boxes are mocked
 * from the grid's custom properties, as the CSS lays them out at 1,280 px: the rail is the
 * dragged width (280 px by default), the artifact column 360 px while open. The CSS rules
 * themselves are pinned in `layout-contract.test.tsx`; real widths are checked on gate1.
 */
let fake: FakeKobe;
const WAIT = { timeout: 10_000 };
const GRID_PX = DESKTOP_WIDTH;

const regionOf = (name: string) =>
  must(document.querySelector<HTMLElement>(`[data-shell-region="${name}"]`));
const grid = () => must(regionOf("rail").parentElement);
const railVar = () => grid().style.getPropertyValue(RAIL_WIDTH_VAR);
/** What the fake server holds for the member: their stored rail width (wire casing). */
const stored = () => fake.preferences["rail_width"];
const puts = () => fake.requests.filter((r) => r.method === "PUT" && r.path === PREFERENCES_PATH);
const SAVED = { timeout: 3000 };
const handle = () => screen.queryByRole("separator", { name: "Resize the workspace rail" });
const mustHandle = () => must(handle());
const aside = () => must(document.querySelector<HTMLElement>('aside[aria-label="Workspace"]'));

function box(left: number, width: number): DOMRect {
  return { left, width, right: left + width, top: 0, height: 800, x: left, y: 0 } as DOMRect;
}

/** The widths the CSS would give: the rail's variable (else 280), the artifact column if open. */
function mockLayout() {
  const real = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    const region = this.getAttribute("data-shell-region");
    const shell = this.querySelector(':scope > [data-shell-region="rail"]') ? this : null;
    if (shell) return box(0, GRID_PX);
    if (region === null) return real.call(this);
    const g = must(this.parentElement);
    const rail = parseFloat(g.style.getPropertyValue(RAIL_WIDTH_VAR)) || RAIL_PX.expanded;
    const artifactOpen = !!g.querySelector(
      ':scope > [data-shell-region="artifact"]:not(:empty):not([data-hidden])',
    );
    const artifact = artifactOpen ? 360 : 0;
    if (region === "rail") return box(0, rail);
    if (region === "artifact") return box(rail, artifact);
    return box(rail + artifact, GRID_PX - rail - artifact);
  });
}

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  fake = new FakeKobe();
  fake.teamModels.push({ alias: "kimi", label: "Kimi K2.7 Code", enabled: true, is_default: true });
  vi.stubGlobal("fetch", fake.fetch);
  resizeWindow(DESKTOP_WIDTH);
  mockLayout();
});

afterEach(() => {
  cleanup();
  resizeWindow(DESKTOP_WIDTH);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function thread() {
  const t = fake.addThread("Reports");
  const u = fake.addEntry(t, null, { role: "user", content: "make it" });
  fake.addEntry(t, u, { role: "assistant", content: [{ type: "text", text: "done" }] });
  return t;
}

async function openShell(t = thread()) {
  openApp(fake, t);
  await screen.findByText("done", undefined, WAIT);
  await screen.findByRole("combobox", { name: "Model for this conversation" }, WAIT);
  await waitFor(() => expect(handle()).not.toBeNull());
  return mustHandle();
}

const MOD = () => (isMacPlatform() ? { metaKey: true } : { ctrlKey: true });
const toggleRail = () => fireEvent.keyDown(document.body, { key: "b", code: "KeyB", ...MOD() });

describe("the handle (ac-1, ac-3)", () => {
  it("is a vertical separator at 280 px, between 200 px and the conversation's floor", async () => {
    const h = await openShell();
    expect(h.getAttribute("aria-orientation")).toBe("vertical");
    expect(h.getAttribute("aria-controls")).toBe(aside().id);
    expect(h.tabIndex).toBe(0);
    h.focus();
    await waitFor(() => expect(h.getAttribute("aria-valuenow")).toBe("280"));
    expect(h.getAttribute("aria-valuemin")).toBe("200");
    // 1,280 − 400 = 880 px of room; the rail's own maximum is 560 px.
    expect(h.getAttribute("aria-valuemax")).toBe("560");
    expect(railVar()).toBe(""); // the CSS default
  });

  it("arrow keys step 24 px, Page Up/Down four steps (stopping on 280), Home and End jump to the bounds", async () => {
    const h = await openShell();
    h.focus();
    const user = userEvent.setup();
    await user.keyboard("{ArrowRight}");
    expect(railVar()).toBe("304px");
    await user.keyboard("{ArrowLeft}{ArrowLeft}");
    expect(railVar()).toBe("256px");
    await user.keyboard("{PageUp}"); // 256 + 96 passes the default: stops on 280
    expect(railVar()).toBe("280px");
    await user.keyboard("{PageUp}");
    expect(railVar()).toBe("376px");
    await user.keyboard("{PageDown}");
    expect(railVar()).toBe("280px");
    await user.keyboard("{Home}");
    expect(railVar()).toBe("200px");
    await user.keyboard("{ArrowLeft}");
    expect(railVar()).toBe("200px"); // held at the minimum
    await user.keyboard("{End}");
    expect(railVar()).toBe("560px");
    await waitFor(() => expect(h.getAttribute("aria-valuenow")).toBe("560"));
  });

  it("drags within the bounds, shows each value and commits on release", async () => {
    const h = await openShell();
    fireEvent.pointerDown(h, { clientX: 280, button: 0, pointerId: 1 });
    fireEvent.pointerMove(h, { clientX: 120, pointerId: 1 }); // under the minimum
    expect(railVar()).toBe("200px");
    expect(h.getAttribute("aria-valuenow")).toBe("200");
    expect(puts()).toHaveLength(0); // nothing saved mid-drag
    fireEvent.pointerMove(h, { clientX: 1000, pointerId: 1 }); // past the maximum
    expect(railVar()).toBe("560px");
    fireEvent.pointerMove(h, { clientX: 400.4, pointerId: 1 });
    expect(railVar()).toBe("400px");
    fireEvent.pointerUp(h, { clientX: 400, pointerId: 1 });
    expect(railVar()).toBe("400px");
    await waitFor(() => expect(puts()).toHaveLength(1), SAVED);
    expect(puts()[0]?.body).toEqual({ rail_width: 400 });
    expect(stored()).toBe(400);
  });

  it("a press that doesn't move is a click: the width stays the default", async () => {
    const h = await openShell();
    fireEvent.pointerDown(h, { clientX: 280, button: 0, pointerId: 1 });
    fireEvent.pointerMove(h, { clientX: 282, pointerId: 1 });
    fireEvent.pointerUp(h, { clientX: 282, pointerId: 1 });
    fireEvent.pointerDown(h, { clientX: 280, button: 2, pointerId: 1 }); // not the main button
    fireEvent.pointerMove(h, { clientX: 400, pointerId: 1 });
    fireEvent.pointerUp(h, { clientX: 400, pointerId: 1 });
    expect(railVar()).toBe("");
    await new Promise((r) => setTimeout(r, 900));
    expect(puts()).toHaveLength(0);
  });
});

describe("persistence and reset (ac-2)", () => {
  it("applies the member's stored width, from any device", async () => {
    fake.preferences = { rail_width: 360 };
    const h = await openShell();
    await waitFor(() => expect(railVar()).toBe("360px"));
    h.focus();
    await waitFor(() => expect(h.getAttribute("aria-valuenow")).toBe("360"));
  });

  it("ignores a stored width out of bounds or garbled: the default applies", async () => {
    fake.preferences = { rail_width: 9000 };
    await openShell();
    await waitFor(() => expect(fake.requests.some((r) => r.path === PREFERENCES_PATH)).toBe(true));
    expect(railVar()).toBe("");
    cleanup();
    fake.preferences = { rail_width: "wide" };
    await openShell();
    expect(railVar()).toBe("");
  });

  it("saves keyboard changes debounced into one PUT", async () => {
    const h = await openShell();
    h.focus();
    await userEvent.setup().keyboard("{ArrowRight}{ArrowRight}");
    expect(railVar()).toBe("328px");
    await waitFor(() => expect(puts()).toHaveLength(1), SAVED);
    expect(puts()[0]?.body).toEqual({ rail_width: 328 });
  });

  it("double-click goes back to the default and saves that (null)", async () => {
    fake.preferences = { rail_width: 420 };
    const h = await openShell();
    await waitFor(() => expect(railVar()).toBe("420px"));
    fireEvent.doubleClick(h);
    await waitFor(() => expect(railVar()).toBe(""));
    await waitFor(() => expect(puts()).toHaveLength(1), SAVED);
    expect(puts()[0]?.body).toEqual({ rail_width: null });
    expect(stored()).toBeNull();
  });
});

describe("with the rest of the shell (ac-4)", () => {
  it("Enter resets to the default, and the keys stop on 280 px on the way back", async () => {
    fake.preferences = { rail_width: 200 };
    const h = await openShell();
    await waitFor(() => expect(railVar()).toBe("200px"));
    h.focus();
    const user = userEvent.setup();
    await user.keyboard("{PageUp}"); // 200 + 96 passes 280: stops there
    expect(railVar()).toBe("280px");
    await user.keyboard("{End}{Enter}");
    await waitFor(() => expect(railVar()).toBe(""));
    expect(h.getAttribute("aria-keyshortcuts")).toBe("Enter");
    await waitFor(() => expect(stored()).toBeNull(), SAVED);
  });

  it("Mod+B during a drag drops the dragged width: the saved one shows, nothing is saved", async () => {
    fake.preferences = { rail_width: 320 };
    const h = await openShell();
    await waitFor(() => expect(railVar()).toBe("320px"));
    fireEvent.pointerDown(h, { clientX: 320, button: 0, pointerId: 1 });
    fireEvent.pointerMove(h, { clientX: 500, pointerId: 1 });
    expect(railVar()).toBe("500px");
    toggleRail();
    await waitFor(() => expect(handle()).toBeNull());
    expect(railVar()).toBe("320px");
    toggleRail();
    await waitFor(() => expect(handle()).not.toBeNull());
    expect(railVar()).toBe("320px");
    await new Promise((r) => setTimeout(r, 900));
    expect(puts().every((p) => !("rail_width" in (p.body as object)))).toBe(true);
  });

  it("Mod+B collapses the rail (no handle) and expanding restores the saved width", async () => {
    fake.preferences = { rail_width: 380 };
    await openShell();
    await waitFor(() => expect(railVar()).toBe("380px"));
    toggleRail();
    await waitFor(() => expect(aside().hasAttribute("data-collapsed")).toBe(true));
    expect(handle()).toBeNull();
    toggleRail();
    await waitFor(() => expect(aside().hasAttribute("data-collapsed")).toBe(false));
    await waitFor(() => expect(handle()).not.toBeNull());
    expect(railVar()).toBe("380px");
    expect(puts().every((p) => !("rail_width" in (p.body as object)))).toBe(true);
  });

  it("has no handle on narrow and phone widths, nor in the drawer", async () => {
    fake.preferences = { rail_width: 380 };
    await openShell();
    for (const width of [960, 390]) {
      resizeWindow(width);
      await waitFor(() => expect(handle()).toBeNull());
    }
    resizeWindow(960);
    const user = userEvent.setup();
    await user.click(within(aside()).getByRole("button", { name: "Show files" }));
    await waitFor(() => expect(aside().hasAttribute("data-drawer")).toBe(true));
    expect(handle()).toBeNull();
    // The stored width is untouched and comes back on a wide window.
    resizeWindow(DESKTOP_WIDTH);
    await waitFor(() => expect(handle()).not.toBeNull());
    expect(stored()).toBe(380);
    expect(railVar()).toBe("380px");
  });

  it("beside the artifact column, the rail's maximum keeps both floors", async () => {
    const t = thread();
    fake.addArtifact(t, { kind: "markdown", title: "Plan", versions: ["Plan body"] });
    const h = await openShell(t);
    const list = await screen.findByRole("navigation", {
      name: "Artifacts and files in this conversation",
    });
    await userEvent.setup().click(within(list).getByRole("button", { name: "Open artifact Plan" }));
    await screen.findByRole("tab", { name: "Plan", selected: true });
    expect(
      screen.getByRole("separator", { name: "Resize the artifact column and the conversation" }),
    ).toBeTruthy();
    h.focus();
    await userEvent.setup().keyboard("{End}");
    // 1,280 − the conversation's 400 − the artifact column's 360.
    expect(railVar()).toBe("520px");
    expect(h.getAttribute("aria-valuemax")).toBe("520");
  });
});
