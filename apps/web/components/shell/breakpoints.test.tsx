// @vitest-environment happy-dom
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeKobe } from "../../lib/chat/testing/fake-kobe";
import { PREFERENCES_PATH } from "../../lib/shell/preferences";
import { must } from "../../lib/testing/must";
import { DESKTOP_WIDTH, resizeWindow } from "../../lib/testing/viewport";
import { composer, openApp, openThreads, streaming } from "../chat/testing";

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
const row = (n: 1) => must(header().querySelector<HTMLElement>(`[data-bar-row="${n}"]`));
const toolbar = () =>
  waitFor(() => must(document.querySelector<HTMLElement>("[data-composer-toolbar]")));
const menuPanel = () => must(document.querySelector<HTMLElement>("#kobe-bar-menu"));
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
  const list = await screen.findByRole("navigation", {
    name: "Artifacts and files in this conversation",
  });
  const opener = within(list).getByRole("button", { name: "Open artifact Plan" });
  await userEvent.setup().click(opener);
  await screen.findByRole("tab", { name: "Plan", selected: true });
  return opener;
}

describe("the CE7 table, per band (ac-1)", () => {
  it("1280: the member's rail, the artifact column and its resize handle; one bar row", async () => {
    await openArtifact();
    expect(aside().hasAttribute("data-collapsed")).toBe(false);
    expect(handle()).not.toBeNull();
    expect(artifactRegion().hasAttribute("data-sheet-open")).toBe(false);
    expect(header().querySelectorAll("[data-bar-row]")).toHaveLength(1);
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
    const show = await within(aside()).findByRole("button", { name: "Show files" });
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

  it("390: one 56 px row with the drawer button, team switcher, title and Menu", async () => {
    resizeWindow(390);
    openApp(fake);
    await composer();
    await waitFor(() => expect(header().getAttribute("data-bar-layout")).toBe("single"));
    const one = within(row(1));
    expect(one.getByRole("button", { name: "Show the workspace" })).toBeTruthy();
    expect(one.getByRole("heading", { name: "Kobe" })).toBeTruthy();
    // Folded: the search and the icons are hidden behind the Menu.
    const menuButton = one.getByRole("button", { name: "Menu" });
    expect(menuButton.getAttribute("aria-expanded")).toBe("false");
    expect(menuPanel().hidden).toBe(true);
    await userEvent.setup().click(menuButton);
    expect(menuButton.getAttribute("aria-expanded")).toBe("true");
    expect(menuButton.getAttribute("aria-controls")).toBe("kobe-bar-menu");
    // What row two held is not lost (KOBE-418): the pickers are in the composer's own menu...
    expect(within(header()).queryByRole("combobox")).toBeNull();
    const pickers = await within(await toolbar()).findByRole("button", { name: "Agent and model" });
    const folded = within(
      must(document.getElementById(must(pickers.getAttribute("aria-controls")))),
    );
    expect(
      await folded.findByRole("button", { name: "Chat with: No agent", hidden: true }),
    ).toBeTruthy();
    expect(
      await folded.findByRole("combobox", { name: "Model for this conversation", hidden: true }),
    ).toBeTruthy();
    // ...and the Menu holds the search, the areas and the profile menu.
    const panel = within(menuPanel());
    expect(menuPanel().hidden).toBe(false);
    expect(panel.getByLabelText("Search conversations")).toBeTruthy();
    expect(panel.getByRole("navigation", { name: "My area" })).toBeTruthy();
    expect(menuPanel().querySelector('summary[aria-label="Profile"]')).not.toBeNull();
  });

  it("390: the closed drawer lists nothing; opening it on Files lists once, reopening reuses it (KOBE-461 ac-2)", async () => {
    resizeWindow(390);
    openApp(fake);
    await composer();
    const wakes = () =>
      fake.requests.filter((r) => r.method === "POST" && r.path === "/v1/workspace/wake").length;
    await new Promise((r) => setTimeout(r, 50));
    expect(wakes()).toBe(0);
    expect(fake.workspaceListings).toEqual([]);
    await userEvent.setup().click(screen.getByRole("button", { name: "Show the workspace" }));
    const files = await screen.findByRole("region", { name: "Files" });
    await within(files).findByRole("button", { name: "Refresh files" });
    await waitFor(() => expect(wakes()).toBe(1));
    // Closed and opened again: the kept listing, no new wake.
    const user = userEvent.setup();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Workspace" })).toBeNull());
    await user.click(screen.getByRole("button", { name: "Show the workspace" }));
    await screen.findByRole("dialog", { name: "Workspace" });
    await new Promise((r) => setTimeout(r, 50));
    expect(wakes()).toBe(1);
    expect(fake.workspaceListings).toHaveLength(1);
  });

  it("390: the Menu stays open through a press inside it; Escape and a press outside close it", async () => {
    resizeWindow(390);
    openApp(fake);
    await composer();
    const user = userEvent.setup();
    const menuButton = screen.getByRole("button", { name: "Menu" });
    await user.click(menuButton);
    await user.click(within(menuPanel()).getByLabelText("Search conversations"));
    expect(menuButton.getAttribute("aria-expanded")).toBe("true");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(menuButton.getAttribute("aria-expanded")).toBe("false"));
    expect(document.activeElement).toBe(menuButton);
    await user.click(menuButton);
    await user.click(await composer());
    expect(menuButton.getAttribute("aria-expanded")).toBe("false");
  });

  it("390: a search hit in the Menu opens the thread and closes the Menu", async () => {
    resizeWindow(390);
    const t = fake.addThread("Quarterly revenue");
    openApp(fake);
    await composer();
    const user = userEvent.setup();
    const menuButton = screen.getByRole("button", { name: "Menu" });
    await user.click(menuButton);
    await user.type(within(menuPanel()).getByLabelText("Search conversations"), "revenue{Enter}");
    const results = within(await screen.findByRole("list", { name: "Search results" }));
    await user.click(results.getByRole("button", { name: "Quarterly revenue" }));
    await waitFor(() => expect(window.location.search).toBe(`?thread=${t}`));
    await waitFor(() => expect(menuButton.getAttribute("aria-expanded")).toBe("false"));
    expect(menuPanel().hidden).toBe(true);
  });

  it("crossing 768 px keeps the bar's parts mounted: the search keeps its text", async () => {
    openApp(fake);
    await composer();
    const box = screen.getByLabelText("Search conversations");
    const bell = row(1).querySelector('[data-command="notifications"]');
    await userEvent.setup().type(box, "budget");
    resizeWindow(390);
    await waitFor(() => expect(header().getAttribute("data-bar-layout")).toBe("single"));
    expect(screen.getByLabelText("Search conversations")).toBe(box);
    expect((box as HTMLInputElement).value).toBe("budget");
    expect(row(1).querySelector('[data-command="notifications"]')).toBe(bell);
    resizeWindow(DESKTOP_WIDTH);
    await waitFor(() => expect(header().getAttribute("data-bar-layout")).toBe("wide"));
    expect(screen.getByLabelText("Search conversations")).toBe(box);
    expect(menuPanel().hidden).toBe(false);
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
    // Nothing is saved on a phone (KOBE-202).
    await user.click(within(drawer).getByRole("button", { name: "Close the workspace" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Workspace" })).toBeNull());
    expect(document.activeElement).toBe(open);
    await new Promise((r) => setTimeout(r, 900));
    expect(puts()).toHaveLength(0);
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

describe("review round 1", () => {
  it("Escape that closes a row's menu in the Threads panel leaves the panel open (KOBE-292, KOBE-453)", async () => {
    resizeWindow(960);
    fake.addThread("Budget");
    openApp(fake);
    await composer();
    const user = userEvent.setup();
    const panel = within(await openThreads());
    const button = await panel.findByRole("button", { name: "Actions for Budget" });
    button.focus();
    await user.keyboard("{Enter}");
    expect(await screen.findByRole("menu", { name: "Actions for Budget" })).toBeTruthy();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(screen.getByRole("dialog", { name: "Threads" })).toBeTruthy();
    expect(document.activeElement).toBe(button);
    // The button's tooltip (shown on focus) takes the next Escape; then the panel's.
    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog", { name: "Threads" })).toBeTruthy();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Threads" })).toBeNull());
  });

  it("a sheet crossing 768 px stays open, and Back still returns focus to its opener", async () => {
    resizeWindow(800);
    const opener = await openArtifact();
    await waitFor(() => expect(artifactRegion().hasAttribute("data-sheet-open")).toBe(true));
    resizeWindow(390);
    const sheet = await screen.findByRole("dialog", { name: "Plan" });
    expect(header().hasAttribute("inert")).toBe(true);
    await userEvent
      .setup()
      .click(within(sheet).getByRole("button", { name: "Back to the conversation" }));
    expect(artifactRegion().hasAttribute("data-sheet-open")).toBe(false);
    expect(header().hasAttribute("inert")).toBe(false);
    expect(document.activeElement).toBe(opener);
  });

  it("an artifact opened as a column doesn't pop up as a sheet when the window narrows", async () => {
    await openArtifact();
    resizeWindow(390);
    await waitFor(() => expect(header().getAttribute("data-bar-layout")).toBe("single"));
    expect(artifactRegion().hasAttribute("data-sheet-open")).toBe(false);
    expect(header().hasAttribute("inert")).toBe(false);
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
      .click(await within(aside()).findByRole("button", { name: "Show files" }));
    await screen.findByRole("dialog", { name: "Workspace" });
    resizeWindow(DESKTOP_WIDTH);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Workspace" })).toBeNull());
    expect(header().hasAttribute("inert")).toBe(false);
    expect(aside().hasAttribute("data-collapsed")).toBe(false);
  });
});
