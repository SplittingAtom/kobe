// @vitest-environment happy-dom
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeKobe } from "../../lib/chat/testing/fake-kobe";
import { PREFERENCES_PATH } from "../../lib/shell/preferences";
import { must } from "../../lib/testing/must";
import { DESKTOP_WIDTH, resizeWindow } from "../../lib/testing/viewport";
import { composer, openApp, streaming } from "../chat/testing";

/**
 * KOBE-201 (CE7, CE8): the shell at the four widths the gate measures (1280, 960, 800, 390 px),
 * through happy-dom's real `matchMedia` and `resize`. happy-dom has no layout engine: the widths
 * themselves are `lib/shell/layout.test.ts` and the CSS contract (`layout-contract.test.tsx`);
 * these check what each band renders and how it behaves. Real widths are measured on gate1.
 */
let fake: FakeKobe;
/** The grid's columns as laid out (mocked; happy-dom has no layout). */
let space = { artifact: 0, conversation: 1000 };

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  fake = new FakeKobe();
  fake.runnableAgents.push({ id: "a-1", scope: "team", name: "Ledger Bot", model: null });
  fake.teamModels.push({ alias: "kimi", label: "Kimi K2.7 Code", enabled: true, is_default: true });
  vi.stubGlobal("fetch", fake.fetch);
  space = { artifact: 0, conversation: 1000 };
  const real = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    const region = this.getAttribute("data-shell-region");
    if (region !== "artifact" && region !== "conversation") return real.call(this);
    const width = space[region];
    return {
      left: 0,
      top: 0,
      x: 0,
      y: 0,
      width,
      height: 800,
      right: width,
      bottom: 800,
    } as DOMRect;
  });
});

afterEach(() => {
  cleanup();
  resizeWindow(DESKTOP_WIDTH);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const aside = () => must(document.querySelector<HTMLElement>('aside[aria-label="Workspace"]'));
const artifactRegion = () =>
  must(document.querySelector<HTMLElement>('[data-shell-region="artifact"]'));
const grid = () => must(artifactRegion().parentElement);
const header = () => must(document.querySelector("header"));
const puts = () => fake.requests.filter((r) => r.method === "PUT" && r.path === PREFERENCES_PATH);
const handle = () =>
  screen.queryByRole("separator", { name: "Resize the artifact column and the conversation" });

/** Opens a thread with one artifact and opens it from the thread's list (the member's open). */
async function openArtifact() {
  const t = fake.addThread("Reports");
  const u = fake.addEntry(t, null, { role: "user", content: "make it" });
  fake.addEntry(t, u, { role: "assistant", content: [{ type: "text", text: "done" }] });
  fake.addArtifact(t, { kind: "markdown", title: "Plan", versions: ["Plan body"] });
  openApp(fake, t);
  const list = await screen.findByRole("navigation", { name: "Artifacts in this conversation" });
  const opener = within(list).getByRole("button", { name: "Plan" });
  await userEvent.setup().click(opener);
  await screen.findByRole("tab", { name: "Plan", selected: true });
  return opener;
}

describe("the CE7 table, per band (ac-1)", () => {
  it("1280: the member's rail, the artifact column and its resize handle; two bar rows", async () => {
    await openArtifact();
    expect(aside().hasAttribute("data-collapsed")).toBe(false);
    expect(handle()).not.toBeNull();
    expect(artifactRegion().hasAttribute("data-sheet-open")).toBe(false);
    expect(document.querySelector('[data-bar-row="2"]')?.closest("details")).toBeNull();
    expect(screen.queryByRole("button", { name: "Back to the conversation" })).toBeNull();
  });

  it("960: the rail collapses to 48 px while the artifact column stays, resizable", async () => {
    resizeWindow(960);
    await openArtifact();
    await waitFor(() => expect(aside().hasAttribute("data-collapsed")).toBe(true));
    expect(handle()).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Back to the conversation" })).toBeNull();
  });

  it("960: expanding the rail opens a modal drawer; Escape closes it, focus returns, nothing saved", async () => {
    resizeWindow(960);
    openApp(fake);
    await composer();
    const user = userEvent.setup();
    const show = await within(aside()).findByRole("button", { name: "Show threads" });
    await user.click(show);
    const drawer = await screen.findByRole("dialog", { name: "Workspace" });
    expect(drawer.getAttribute("aria-modal")).toBe("true");
    expect(drawer.contains(document.activeElement)).toBe(true);
    expect(header().hasAttribute("inert")).toBe(true);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Workspace" })).toBeNull());
    expect(header().hasAttribute("inert")).toBe(false);
    expect(document.activeElement).toBe(show);
    await new Promise((r) => setTimeout(r, 900));
    expect(puts()).toHaveLength(0);
  });

  it("800: the artifact column is a sheet over the conversation, with Back", async () => {
    resizeWindow(800);
    const opener = await openArtifact();
    await waitFor(() => expect(artifactRegion().hasAttribute("data-sheet-open")).toBe(true));
    expect(handle()).toBeNull();
    const sheet = screen.getByRole("region", { name: "Plan" });
    expect(header().hasAttribute("inert")).toBe(false); // over the conversation, not modal
    await userEvent
      .setup()
      .click(within(sheet).getByRole("button", { name: "Back to the conversation" }));
    expect(artifactRegion().hasAttribute("data-sheet-open")).toBe(false);
    // The tabs stay open (hidden), and focus is back on what opened the sheet.
    expect(screen.getByRole("tab", { name: "Plan", hidden: true })).toBeTruthy();
    expect(document.activeElement).toBe(opener);
  });

  it("800: the agent's new artifact joins the tabs without covering the conversation", async () => {
    resizeWindow(800);
    const t = fake.addThread("Live");
    openApp(fake, t);
    const user = userEvent.setup();
    const input = await composer();
    await user.type(input, "make a doc{Enter}");
    await waitFor(() => expect(fake.activeRun(t)).toBeDefined());
    const runId = must(fake.activeRun(t)).run_id;
    await streaming(fake, runId);
    input.focus();
    const id = fake.addArtifact(t, { kind: "markdown", title: "Notes", versions: ["v-one"] });
    fake.agent.toolCall(runId, "tc1", "create_artifact", { kind: "markdown", title: "Notes" });
    fake.emit(runId, "artifact.created", {
      artifact_id: id,
      tool_call_id: "tc1",
      kind: "markdown",
      title: "Notes",
      version: 1,
    });
    await screen.findByRole("tab", { name: "Notes", hidden: true });
    expect(artifactRegion().hasAttribute("data-sheet-open")).toBe(false);
    expect(document.activeElement).toBe(input);
  });

  it("390: one 56 px row with the drawer button, team switcher, title and menu", async () => {
    resizeWindow(390);
    openApp(fake);
    await composer();
    await waitFor(() => expect(header().getAttribute("data-bar-layout")).toBe("single"));
    const rows = header().querySelectorAll(":scope > [data-bar-row]");
    expect(rows).toHaveLength(1);
    const one = within(must(rows[0] as HTMLElement));
    expect(one.getByRole("button", { name: "Show the workspace" })).toBeTruthy();
    expect(one.getByRole("heading", { name: "Kobe" })).toBeTruthy();
    // Everything else sits in the menu: row two's pickers, the search, the areas, the profile.
    const menu = must(header().querySelector<HTMLDetailsElement>("details[data-bar-overflow]"));
    await userEvent.setup().click(must(menu.querySelector('summary[aria-label="Menu"]')));
    expect(menu.open).toBe(true);
    const inMenu = within(menu);
    const context = inMenu.getByRole("group", { name: "Conversation context" });
    expect(
      await within(context).findByRole("button", { name: "Chat with: No agent" }),
    ).toBeTruthy();
    expect(
      await within(context).findByRole("combobox", { name: "Model for this conversation" }),
    ).toBeTruthy();
    expect(within(context).getByRole("button", { name: "Files" })).toBeTruthy();
    expect(inMenu.getByLabelText("Search conversations")).toBeTruthy();
    expect(inMenu.getByRole("navigation", { name: "My area" })).toBeTruthy();
    expect(menu.querySelector('summary[aria-label="Profile"]')).not.toBeNull();
  });

  it("390: the menu stays open while a picker inside it is used, and opens the profile menu inside", async () => {
    resizeWindow(390);
    openApp(fake);
    await composer();
    const user = userEvent.setup();
    const menu = must(header().querySelector<HTMLDetailsElement>("details[data-bar-overflow]"));
    await user.click(must(menu.querySelector("summary")));
    expect(menu.open).toBe(true);
    await user.click(await within(menu).findByRole("button", { name: "Chat with: No agent" }));
    const choices = await screen.findByRole("radiogroup", { name: "Chat with" });
    await user.click(within(choices).getByRole("radio", { name: /Ledger Bot/ }));
    expect(menu.open).toBe(true);
    const profile = must(menu.querySelector<HTMLElement>('summary[aria-label="Profile"]'));
    await user.click(profile);
    expect(menu.open).toBe(true);
    expect(must(profile.closest("details")).open).toBe(true);
  });

  it("390: the rail is a drawer from the bar; the collapsed rail is not shown", async () => {
    resizeWindow(390);
    openApp(fake);
    await composer();
    await waitFor(() => expect(header().getAttribute("data-bar-layout")).toBe("single"));
    expect(within(aside()).queryByRole("button", { name: "Show threads" })).toBeNull();
    const user = userEvent.setup();
    const open = screen.getByRole("button", { name: "Show the workspace" });
    await user.click(open);
    const drawer = await screen.findByRole("dialog", { name: "Workspace" });
    expect(open.getAttribute("aria-expanded")).toBe("true");
    expect(grid().querySelector('[data-shell-region="conversation"]')?.hasAttribute("inert")).toBe(
      true,
    );
    await user.click(within(drawer).getByRole("button", { name: "Close the workspace" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Workspace" })).toBeNull());
    expect(document.activeElement).toBe(open);
  });

  it("390: an artifact opens as a full-screen modal sheet with Back and a tab strip", async () => {
    resizeWindow(390);
    const opener = await openArtifact();
    const sheet = await screen.findByRole("dialog", { name: "Plan" });
    expect(sheet.getAttribute("aria-modal")).toBe("true");
    expect(artifactRegion().hasAttribute("data-sheet-open")).toBe(true);
    expect(within(sheet).getByRole("tablist", { name: "Open artifacts" })).toBeTruthy();
    expect(header().hasAttribute("inert")).toBe(true);
    expect(sheet.contains(document.activeElement)).toBe(true);
    await userEvent.setup().keyboard("{Escape}"); // Escape is Back on a sheet: the tab stays
    await waitFor(() => expect(artifactRegion().hasAttribute("data-sheet-open")).toBe(false));
    expect(header().hasAttribute("inert")).toBe(false);
    expect(document.activeElement).toBe(opener);
    expect(screen.getByRole("tab", { name: "Plan", hidden: true })).toBeTruthy();
  });
});

describe("manual choices come back when space returns (ac-2)", () => {
  it("a collapsed rail stays collapsed through 960 and 390, and is collapsed again at 1280", async () => {
    openApp(fake);
    await composer();
    const user = userEvent.setup();
    await user.click(within(aside()).getByRole("button", { name: "Collapse the rail" }));
    await waitFor(() => expect(puts()).toHaveLength(1), { timeout: 3000 });
    for (const width of [960, 390, DESKTOP_WIDTH]) {
      resizeWindow(width);
      await waitFor(() => expect(aside().hasAttribute("data-collapsed")).toBe(true));
    }
    expect(puts()).toHaveLength(1);
  });

  it("an expanded rail is collapsed automatically below 1100 px and expanded again above, unsaved", async () => {
    fake.preferences = { rail_collapsed: false };
    openApp(fake);
    await composer();
    resizeWindow(960);
    await waitFor(() => expect(aside().hasAttribute("data-collapsed")).toBe(true));
    resizeWindow(DESKTOP_WIDTH);
    await waitFor(() => expect(aside().hasAttribute("data-collapsed")).toBe(false));
    await new Promise((r) => setTimeout(r, 900));
    expect(puts()).toHaveLength(0);
  });

  it("a dragged artifact width holds through 800 and 390 and is in place again at 1280", async () => {
    await openArtifact();
    space = { artifact: 500, conversation: 500 };
    must(handle()).focus();
    await userEvent.setup().keyboard("{ArrowRight}");
    const width = () => grid().style.getPropertyValue("--kobe-artifact-width");
    expect(width()).toBe("524px");
    await waitFor(() => expect(puts()).toHaveLength(1), { timeout: 3000 });
    for (const w of [800, 390]) {
      resizeWindow(w);
      await waitFor(() => expect(handle()).toBeNull());
      expect(width()).toBe("524px");
    }
    resizeWindow(DESKTOP_WIDTH);
    await waitFor(() => expect(handle()).not.toBeNull());
    expect(width()).toBe("524px");
    expect(puts()).toHaveLength(1);
  });

  it("a drawer open at 960 closes when the window grows past 1100 px", async () => {
    resizeWindow(960);
    openApp(fake);
    await composer();
    await userEvent
      .setup()
      .click(await within(aside()).findByRole("button", { name: "Show threads" }));
    await screen.findByRole("dialog", { name: "Workspace" });
    resizeWindow(DESKTOP_WIDTH);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Workspace" })).toBeNull());
    expect(header().hasAttribute("inert")).toBe(false);
    expect(aside().hasAttribute("data-collapsed")).toBe(false);
  });
});
