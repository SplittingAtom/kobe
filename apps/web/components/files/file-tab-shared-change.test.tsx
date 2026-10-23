// @vitest-environment happy-dom
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tabsKey } from "../../lib/chat/artifact-tabs";
import { FakeKobe } from "../../lib/chat/testing/fake-kobe";
import { must } from "../../lib/testing/must";
import { composer, openApp } from "../chat/testing";
import { changedBadgeText, changedWhen, UPDATED_NOTE } from "./outside-change-notice";

/**
 * KOBE-496: a file changed by someone else while its tab is open. Clean: a badge at the top of
 * the editor says who and when and offers Reload; nothing is replaced first (ac-1). A draft:
 * KOBE-491's choices, naming who (ac-2). This thread's own agent still reloads silently (ac-3).
 * Read-only tabs get Reload only (ac-5). A dropped stream catches up by version (ac-6).
 */
let fake: FakeKobe;
const enc = (s: string) => new TextEncoder().encode(s);
const PATH = "docs/notes.md";
const ORIGINAL = "# Notes\n\nline two\nline three\n";
const OTHER = "# Notes (other tab)\n\nline two\nline three\n";
const BADGE_USER = "You changed this file in another tab or device just now.";

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

function threadWithFile(path = PATH, text = ORIGINAL) {
  fake.workspaceFiles.set(path, enc(text));
  const thread = fake.addThread("Notes");
  const u = fake.addEntry(thread, null, { role: "user", content: "hi" });
  fake.addEntry(thread, u, { role: "assistant", content: [{ type: "text", text: "done" }] });
  const tab = `file:${path}`;
  localStorage.setItem(tabsKey(fake.teamId, thread), JSON.stringify({ open: [tab], active: tab }));
  return thread;
}

async function editorView(label = "Edit notes.md"): Promise<EditorView> {
  const content = await screen.findByLabelText(label);
  return must(EditorView.findFromDOM(content as HTMLElement));
}

/** Opens the thread with the file in Raw and waits for the page's change stream. */
async function openTab(path = PATH, text = ORIGINAL, label = "Edit notes.md") {
  const thread = threadWithFile(path, text);
  openApp(fake, thread);
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "Raw" }));
  const view = await editorView(label);
  await waitFor(() => expect(fake.workspaceChanges.open).toEqual([[path]]), { timeout: 3_000 });
  return { user, view, thread };
}

async function changeFrom(
  actor: { kind: "agent" | "user" | "sync"; name: string | null },
  text = OTHER,
  path = PATH,
) {
  fake.workspaceFiles.set(path, enc(text));
  await act(() => fake.workspaceChanges.announce(path, actor));
}

const badge = () => screen.findByText(/changed this file|updated this project file/);

describe("someone else's change to a clean tab (ac-1)", () => {
  it("shows who and when with Reload, and replaces nothing until Reload", async () => {
    const { user, view } = await openTab();
    const cursorAt = view.state.doc.line(4).from + 2;
    act(() => view.dispatch({ selection: { anchor: cursorAt } }));
    await changeFrom({ kind: "user", name: "Owner" });
    const text = await badge();
    expect(text.textContent).toBe(BADGE_USER);
    const region = must(text.closest("[role=status]"));
    expect(region.getAttribute("data-kobe-changed-badge")).toBe("");
    expect(view.state.doc.toString()).toBe(ORIGINAL);

    await user.click(
      within(region as HTMLElement).getByRole("button", { name: "Reload notes.md" }),
    );
    await waitFor(() => expect(view.state.doc.toString()).toBe(OTHER));
    // The same editor, the cursor still on "line three"; the badge is gone.
    expect(EditorView.findFromDOM(await screen.findByLabelText("Edit notes.md"))).toBe(view);
    expect(view.state.doc.lineAt(view.state.selection.main.head).text).toBe("line three");
    expect(screen.queryByText(BADGE_USER)).toBeNull();
    expect(screen.queryByText(UPDATED_NOTE)).toBeNull();
  });

  it("the agent of another thread or a schedule gets the badge too", async () => {
    const { view } = await openTab();
    await changeFrom({ kind: "agent", name: null });
    expect((await badge()).textContent).toBe("The agent changed this file just now.");
    expect(view.state.doc.toString()).toBe(ORIGINAL);
  });

  it("typing under the badge turns it into the draft's choices", async () => {
    const { view } = await openTab();
    await changeFrom({ kind: "user", name: "Owner" });
    await badge();
    act(() => view.dispatch({ changes: { from: 0, insert: "mine " } }));
    const banner = await screen.findByRole("alert");
    expect(banner.textContent).toContain(
      "You changed this file in another tab or device while you were editing here.",
    );
    expect(screen.queryByText(BADGE_USER)).toBeNull();
  });
});

describe("someone else's change under unsaved edits (ac-2)", () => {
  it("keeps the draft and offers Compare, Keep mine and Take theirs, naming who", async () => {
    const { view } = await openTab();
    act(() =>
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "# Mine\n" } }),
    );
    await changeFrom({ kind: "user", name: "Owner" });
    const banner = await screen.findByRole("alert");
    expect(banner.textContent).toContain("You changed this file in another tab or device");
    expect(banner.textContent).toContain("Nothing was replaced.");
    for (const name of ["Compare", "Keep mine", "Take theirs"]) {
      expect(within(banner).getByRole("button", { name })).toBeTruthy();
    }
    expect(view.state.doc.toString()).toBe("# Mine\n");
    expect(screen.queryByText(BADGE_USER)).toBeNull();
  });
});

describe("this thread's own agent (ac-3)", () => {
  it("still reloads silently after its own write", async () => {
    const { user, view, thread } = await openTab();
    await user.type(await composer(), "edit it{Enter}");
    await waitFor(() => expect(fake.activeRun(thread)).toBeDefined());
    const run = must(fake.activeRun(thread)).run_id;
    act(() => fake.agent.toolCall(run, "e1", "edit", { path: `/workspace/${PATH}` }));
    act(() => fake.agent.toolResult(run, "e1", "edit", "ok"));
    await changeFrom({ kind: "agent", name: null });
    expect(await screen.findByText(UPDATED_NOTE, undefined, { timeout: 3_000 })).toBeTruthy();
    await waitFor(() => expect(view.state.doc.toString()).toBe(OTHER));
    expect(screen.queryByText(/changed this file/)).toBeNull();
  });
});

describe("read-only tabs (ac-5)", () => {
  it("a project file gets the badge with Reload only", async () => {
    const path = "projects/handbook/spec.md";
    const { user, view } = await openTab(path, "v1\n", "Edit spec.md");
    await changeFrom({ kind: "sync", name: "Ann" }, "v2\n", path);
    const text = await badge();
    expect(text.textContent).toBe("Ann updated this project file just now.");
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Keep mine" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Reload spec.md" }));
    await waitFor(() => expect(view.state.doc.toString()).toBe("v2\n"));
  });
});

describe("after a dropped stream (ac-6)", () => {
  it("catches up by version on reconnect and shows the badge", async () => {
    const { view } = await openTab();
    // Changed while the stream was down: no live event, only the reconnect's state.
    fake.workspaceFiles.set(PATH, enc(OTHER));
    act(() => fake.workspaceChanges.dropAll());
    expect((await badge()).textContent).toBe("The agent changed this file just now.");
    expect(view.state.doc.toString()).toBe(ORIGINAL);
  });
});

describe("badge text", () => {
  it("names who and when", () => {
    const now = Date.parse("2026-10-23T12:00:00Z");
    expect(changedWhen("2026-10-23T11:59:30Z", now)).toBe("just now");
    expect(changedWhen("2026-10-23T11:55:00Z", now)).toBe("5 min ago");
    expect(changedWhen("2026-10-23T09:00:00Z", now)).toMatch(/^at /);
    expect(changedBadgeText({ actor: { kind: "sync", name: null }, at: null })).toBe(
      "This project file was updated just now.",
    );
    expect(changedBadgeText(undefined)).toBe("This file changed outside this tab just now.");
  });
});
